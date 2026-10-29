import { DiskImage } from './image';
import { warn } from '../log';


export interface Partition {
	/** 1-based number, in table order (MBR: primary 1-4, logical from 5) */
	number: number;
	/** Byte offset on the disk */
	start: number;
	/** Size in bytes */
	size: number;
	/** MBR type byte, e.g. 0x07 (NTFS/exFAT), or a GPT type GUID */
	type: string;
	/** GPT partition name, if any */
	name?: string;
	/** What the type means, if known ("NTFS", "EFI system", ...) */
	description?: string;
}

export interface PartitionTable {
	style: 'mbr' | 'gpt';
	sectorSize: number;
	partitions: Partition[];
}

const SECTOR = 512;

const MBR_TYPES: { [t: number]: string } = {
	0x01: 'FAT12', 0x04: 'FAT16', 0x06: 'FAT16', 0x07: 'NTFS/exFAT', 0x0b: 'FAT32', 0x0c: 'FAT32',
	0x0e: 'FAT16', 0x11: 'Hidden FAT12', 0x17: 'Hidden NTFS', 0x1b: 'Hidden FAT32', 0x1c: 'Hidden FAT32',
	0x27: 'Windows recovery', 0x42: 'Windows dynamic disk', 0x82: 'Linux swap', 0x83: 'Linux',
	0x8e: 'Linux LVM', 0xa5: 'FreeBSD', 0xa8: 'macOS UFS', 0xaf: 'macOS HFS+', 0xee: 'GPT protective',
	0xef: 'EFI system', 0xfd: 'Linux RAID'
};

const GPT_TYPES: { [guid: string]: string } = {
	'c12a7328-f81f-11d2-ba4b-00a0c93ec93b': 'EFI system',
	'e3c9e316-0b5c-4db8-817d-f92df00215ae': 'Microsoft reserved',
	'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7': 'Basic data',
	'de94bba4-06d1-4d40-a16a-bfd50179d6ac': 'Windows recovery',
	'5808c8aa-7e8f-42e0-85d2-e1e90434cfb3': 'LDM metadata',
	'af9b60a0-1431-4f62-bc68-3311714a69ad': 'LDM data',
	'0fc63daf-8483-4772-8e79-3d69d8477de4': 'Linux filesystem',
	'0657fd6d-a4ab-43c4-84e5-0933c84b4f4f': 'Linux swap',
	'48465300-0000-11aa-aa11-00306543ecac': 'Apple HFS+',
	'7c3457ef-0000-11aa-aa11-00306543ecac': 'Apple APFS',
};

const EXTENDED_TYPES = new Set([ 0x05, 0x0f, 0x85 ]);

/** Formats a GUID stored in Microsoft's mixed-endian layout */
export function guidToString(b: Buffer, off = 0): string {
	let h = (start: number, len: number, reverse: boolean) => {
		let s = b.subarray(off + start, off + start + len);
		return Buffer.from(reverse ? Buffer.from(s).reverse() : s).toString('hex');
	};
	return h(0, 4, true) + '-' + h(4, 2, true) + '-' + h(6, 2, true) + '-' + h(8, 2, false) + '-' + h(10, 6, false);
}

/**
 * Reads the partition table of a disk image. Returns null if the image doesn't start with one
 * (e.g. it is a single partition).
 */
export async function readPartitionTable(image: DiskImage): Promise<PartitionTable | null> {
	if(image.size < SECTOR * 2) {
		return null;
	}

	let mbr = await image.read(0, SECTOR);
	if(mbr[510] !== 0x55 || mbr[511] !== 0xaa) {
		return null;
	}

	// A volume boot sector (NTFS, FAT) also ends in 55 AA; it isn't a partition table
	if(isVolumeBootSector(mbr)) {
		return null;
	}

	let entries = parseMbrEntries(mbr);
	if(entries.some((e) => e.type === 0xee)) {
		let gpt = await readGpt(image);
		if(gpt) {
			return gpt;
		}
		warn('Disk has a protective MBR but no readable GPT; using the MBR');
	}

	let partitions: Partition[] = [];
	let n = 1;
	for(let e of entries) {
		if(e.type === 0 || e.sectors === 0) {
			n++;
			continue;
		}

		if(EXTENDED_TYPES.has(e.type)) {
			partitions.push(...await readLogical(image, e.lba * SECTOR));
		}
		else {
			addIfInside(image, partitions, {
				number: n, start: e.lba * SECTOR, size: e.sectors * SECTOR,
				type: '0x' + e.type.toString(16).padStart(2, '0'), description: MBR_TYPES[e.type]
			});
		}
		n++;
	}

	partitions.sort((a, b) => a.number - b.number);
	return { style: 'mbr', sectorSize: SECTOR, partitions };
}

function addIfInside(image: DiskImage, list: Partition[], p: Partition) {
	if(p.start + p.size > image.size) {
		// Images can end before the last partition (e.g. trailing free space that wasn't backed up)
		if(p.start >= image.size) {
			warn('Partition ' + p.number + ' starts after the end of the image; skipped');
			return;
		}
		p.size = image.size - p.start;
	}
	list.push(p);
}

function parseMbrEntries(mbr: Buffer) {
	let out: Array<{ type: number; lba: number; sectors: number }> = [];
	for(let i = 0; i < 4; i++) {
		let o = 446 + i * 16;
		out.push({ type: mbr[o + 4], lba: mbr.readUInt32LE(o + 8), sectors: mbr.readUInt32LE(o + 12) });
	}
	return out;
}

async function readLogical(image: DiskImage, extStart: number): Promise<Partition[]> {
	let out: Partition[] = [];
	let ebr = extStart;
	let seen = new Set<number>();
	let n = 5;

	while(ebr < image.size && !seen.has(ebr) && out.length < 128) {
		seen.add(ebr);
		let sec = await image.read(ebr, SECTOR);
		if(sec.length < SECTOR || sec[510] !== 0x55 || sec[511] !== 0xaa) {
			break;
		}

		let [ first, second ] = parseMbrEntries(sec);
		if(first.type !== 0 && first.sectors > 0) {
			addIfInside(image, out, {
				number: n++, start: ebr + first.lba * SECTOR, size: first.sectors * SECTOR,
				type: '0x' + first.type.toString(16).padStart(2, '0'), description: MBR_TYPES[first.type]
			});
		}

		if(!EXTENDED_TYPES.has(second.type) || second.lba === 0) {
			break;
		}
		ebr = extStart + second.lba * SECTOR;
	}

	return out;
}

async function readGpt(image: DiskImage): Promise<PartitionTable | null> {
	for(let sectorSize of [ 512, 4096 ]) {
		let hdr = await image.read(sectorSize, 92);
		if(hdr.length < 92 || hdr.toString('latin1', 0, 8) !== 'EFI PART') {
			continue;
		}

		let entriesLba = Number(hdr.readBigUInt64LE(72));
		let count = hdr.readUInt32LE(80);
		let entrySize = hdr.readUInt32LE(84);
		if(entrySize < 128 || entrySize > 4096 || count > 4096) {
			warn('GPT header has implausible entry layout');
			return null;
		}

		let table = await image.read(entriesLba * sectorSize, count * entrySize);
		let partitions: Partition[] = [];
		for(let i = 0; i < count && (i + 1) * entrySize <= table.length; i++) {
			let e = table.subarray(i * entrySize, (i + 1) * entrySize);
			if(e.subarray(0, 16).every((b) => b === 0)) {
				continue;
			}

			let type = guidToString(e, 0);
			let first = Number(e.readBigUInt64LE(32));
			let last = Number(e.readBigUInt64LE(40));
			let name = e.toString('utf16le', 56, 128).replace(/\0.*$/s, '');
			addIfInside(image, partitions, {
				number: i + 1, start: first * sectorSize, size: (last - first + 1) * sectorSize,
				type, name: name || undefined, description: GPT_TYPES[type]
			});
		}

		return { style: 'gpt', sectorSize, partitions };
	}

	return null;
}

/**
 * Whether a 512-byte sector is a volume boot sector (NTFS, FAT, exFAT) rather than an MBR
 */
export function isVolumeBootSector(sec: Buffer): boolean {
	let oem = sec.toString('latin1', 3, 11);
	if(oem === 'NTFS    ' || oem === 'EXFAT   ') {
		return true;
	}

	// FAT: a jump instruction and a sane BIOS parameter block
	let bytesPerSector = sec.readUInt16LE(11);
	let sectorsPerCluster = sec[13];
	return (sec[0] === 0xeb || sec[0] === 0xe9) &&
		[ 512, 1024, 2048, 4096 ].includes(bytesPerSector) &&
		sectorsPerCluster > 0 && (sectorsPerCluster & (sectorsPerCluster - 1)) === 0 &&
		(sec.toString('latin1', 54, 59) === 'FAT12' || sec.toString('latin1', 54, 59) === 'FAT16' || sec.toString('latin1', 82, 87) === 'FAT32');
}
