import fs from 'node:fs';
import crypto from 'node:crypto';
import { SnapshotFS } from '../fs/types';
import { DiskImage } from '../disk/image';
import { isVolumeBootSector, readPartitionTable } from '../disk/partitions';


export interface ExportProgress {
	bytes: number;
	totalBytes: number;
}

export interface ExportImageOptions {
	/** 'img' (raw bytes) or 'vhd' (fixed VHD that Windows can attach); default from the file extension */
	format?: 'img' | 'vhd';
	overwrite?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: ExportProgress) => void;
}

const CHUNK = 4 * 1024 * 1024;
/** A volume put in a VHD starts 1 MiB into the disk, like Windows lays out partitions */
const PARTITION_START = 1024 * 1024;

/**
 * Footer of a fixed VHD (Microsoft "Virtual Hard Disk Image Format Specification"): the raw disk
 * followed by these 512 bytes
 */
export function vhdFooter(diskSize: number, now = new Date()): Buffer {
	let f = Buffer.alloc(512);
	f.write('conectix', 0, 'latin1');
	f.writeUInt32BE(2, 8);
	f.writeUInt32BE(0x00010000, 12);
	f.writeBigUInt64BE(0xffffffffffffffffn, 16);
	f.writeUInt32BE(Math.max(0, Math.floor((now.getTime() - Date.UTC(2000, 0, 1)) / 1000)), 24);
	f.write('tibr', 28, 'latin1');
	f.writeUInt32BE(0x00010000, 32);
	f.write('Wi2k', 36, 'latin1');
	f.writeBigUInt64BE(BigInt(diskSize), 40);
	f.writeBigUInt64BE(BigInt(diskSize), 48);

	// CHS geometry, per the specification's algorithm
	let totalSectors = Math.min(diskSize / 512, 65535 * 16 * 255);
	let sectorsPerTrack: number;
	let heads: number;
	let cylindersTimesHeads: number;
	if(totalSectors >= 65535 * 16 * 63) {
		sectorsPerTrack = 255;
		heads = 16;
		cylindersTimesHeads = Math.floor(totalSectors / sectorsPerTrack);
	}
	else {
		sectorsPerTrack = 17;
		cylindersTimesHeads = Math.floor(totalSectors / sectorsPerTrack);
		heads = Math.max(4, Math.floor((cylindersTimesHeads + 1023) / 1024));
		if(cylindersTimesHeads >= heads * 1024 || heads > 16) {
			sectorsPerTrack = 31;
			heads = 16;
			cylindersTimesHeads = Math.floor(totalSectors / sectorsPerTrack);
		}
		if(cylindersTimesHeads >= heads * 1024) {
			sectorsPerTrack = 63;
			heads = 16;
			cylindersTimesHeads = Math.floor(totalSectors / sectorsPerTrack);
		}
	}
	f.writeUInt16BE(Math.floor(cylindersTimesHeads / heads), 56);
	f[58] = heads;
	f[59] = sectorsPerTrack;
	f.writeUInt32BE(2, 60); // fixed disk
	crypto.randomBytes(16).copy(f, 68);

	let sum = 0;
	for(let i = 0; i < 512; i++) {
		sum += f[i];
	}
	f.writeUInt32BE((~sum) >>> 0, 64);
	return f;
}

/** An MBR with one NTFS/exFAT partition covering [PARTITION_START, PARTITION_START + size) */
function mbrFor(volumeSize: number): Buffer {
	let mbr = Buffer.alloc(512);
	let o = 446;
	mbr[o + 4] = 0x07;
	mbr.writeUInt32LE(PARTITION_START / 512, o + 8);
	mbr.writeUInt32LE(Math.ceil(volumeSize / 512), o + 12);
	// CHS fields: "use LBA" values
	mbr.fill(0xfe, o + 1, o + 4);
	mbr.fill(0xfe, o + 5, o + 8);
	crypto.randomBytes(4).copy(mbr, 440); // disk signature
	mbr[510] = 0x55;
	mbr[511] = 0xaa;
	return mbr;
}

/**
 * Writes a raw image file from a backup (e.g. "/Partition 2.img" of a disk-image backup) to 'output',
 * as raw bytes or as a fixed VHD. A volume without a partition table is put in a one-partition disk
 * for VHD, so Windows can attach it (Disk Management > Attach VHD) and show its files.
 */
export async function exportImage(snapshot: SnapshotFS, imagePath: string, output: string, opts: ExportImageOptions = {}): Promise<{ bytes: number; file: string }> {
	let entry = await snapshot.stat(imagePath);
	if(!entry || entry.type !== 'file') {
		throw new Error('No such image in the backup: ' + imagePath);
	}
	if(!opts.overwrite && fs.existsSync(output)) {
		throw new Error('Not replacing ' + output + ' (it exists)');
	}
	let format = opts.format || (/\.vhd$/i.test(output) ? 'vhd' : 'img');

	let source: DiskImage = { size: entry.size, read: (o, l) => snapshot.read(entry!.path, o, l) };
	let prefix = Buffer.alloc(0);
	if(format === 'vhd') {
		let first = await source.read(0, 512);
		if(!(await readPartitionTable(source)) && first.length === 512 && isVolumeBootSector(first)) {
			prefix = Buffer.concat([ mbrFor(entry.size), Buffer.alloc(PARTITION_START - 512) ]);
		}
	}

	let tmp = output + '.' + process.pid + '.partial';
	let fh = await fs.promises.open(tmp, 'w');
	try {
		let dataSize = prefix.length + entry.size;
		let diskSize = format === 'vhd' ? Math.ceil(dataSize / 512) * 512 : dataSize;
		await fh.truncate(diskSize);
		if(prefix.length) {
			await fh.write(prefix, 0, prefix.length, 0);
		}

		for(let off = 0; off < entry.size; off += CHUNK) {
			opts.signal?.throwIfAborted();
			let b = await source.read(off, Math.min(CHUNK, entry.size - off));
			// Leave all-zero areas unwritten (the file is already that size, so they read as zeros)
			if(b.some((x) => x !== 0)) {
				await fh.write(b, 0, b.length, prefix.length + off);
			}
			opts.onProgress?.({ bytes: Math.min(entry.size, off + CHUNK), totalBytes: entry.size });
		}

		if(format === 'vhd') {
			let footer = vhdFooter(diskSize);
			await fh.write(footer, 0, footer.length, diskSize);
		}
		await fh.close();
		await fs.promises.rename(tmp, output);
		return { bytes: entry.size, file: output };
	}
	catch(e) {
		await fh.close().catch(() => {});
		await fs.promises.rm(tmp, { force: true });
		throw e;
	}
}
