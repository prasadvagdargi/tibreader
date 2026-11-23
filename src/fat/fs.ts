import { FsEntry, SnapshotFS } from '../fs/types';
import { joinPath, splitPath } from '../fs/tree';
import { LRUCache, createBlockCache } from '../cache';
import { FormatError } from '../errors';
import { warn } from '../log';
import { DiskImage, readExact } from '../disk/image';
import { registerVolumeOpener } from '../disk/fs';


/*
 * FAT32 volumes (e.g. the EFI system partition). See doc/Format-FAT32.md.
 *
 * Boot sector (little-endian): 11 bytes per sector, 13 sectors per cluster, 14 reserved sectors,
 * 16 number of FATs, 17 root entries (0 on FAT32), 19 total sectors (16-bit), 22 FAT size (16-bit, 0 on
 * FAT32), 32 total sectors (32-bit), 36 FAT size (32-bit), 44 root folder cluster, 71 label, 82 "FAT32   ",
 * 510 55 AA.
 */

const DIR_ENTRY_SIZE = 32;
const ATTR_READ_ONLY = 0x01;
const ATTR_HIDDEN = 0x02;
const ATTR_SYSTEM = 0x04;
const ATTR_VOLUME_LABEL = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_LONG_NAME = ATTR_READ_ONLY | ATTR_HIDDEN | ATTR_SYSTEM | ATTR_VOLUME_LABEL;
const DELETED_MARKER = 0xe5;
const LFN_LAST_PART = 0x40;
const NT_LOWERCASE_BASE = 0x08;
const NT_LOWERCASE_EXTENSION = 0x10;
const FAT32_ENTRY_MASK = 0x0fffffff;
const FAT32_END_OF_CHAIN = 0x0ffffff8;
const FAT32_BAD_CLUSTER = 0x0ffffff7;
const FAT_BLOCK_SIZE = 64 * 1024;
const FIRST_DATA_CLUSTER = 2;


interface Geometry {
	bytesPerSector: number;
	clusterSize: number;
	fatOffset: number;
	fatSize: number;
	dataOffset: number;
	clusterCount: number;
	rootCluster: number;
	bootLabel?: string;
}

/** One folder entry, after joining long-name parts */
interface FatEntry {
	name: string;
	isDirectory: boolean;
	firstCluster: number;
	size: number;
	modified: Date;
	accessed?: Date;
}

/** A run of consecutive clusters */
interface ClusterRun {
	firstCluster: number;
	count: number;
}


function parseGeometry(boot: Buffer, volumeSize: number): Geometry | null {
	if(boot.length < 512 || boot[510] !== 0x55 || boot[511] !== 0xaa) {
		return null;
	}
	let bytesPerSector = boot.readUInt16LE(11);
	let sectorsPerCluster = boot[13];
	let reservedSectors = boot.readUInt16LE(14);
	let fatCount = boot[16];
	let rootEntries = boot.readUInt16LE(17);
	let fatSize16 = boot.readUInt16LE(22);
	let fatSectors = boot.readUInt32LE(36);
	let totalSectors = boot.readUInt16LE(19) || boot.readUInt32LE(32);

	// FAT32 is told apart by its BPB (no fixed root folder, 32-bit FAT size). Windows also formats small
	// EFI partitions as FAT32 with fewer clusters than the specification's FAT32 minimum.
	let isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;
	if(![ 512, 1024, 2048, 4096 ].includes(bytesPerSector) || !isPowerOfTwo(sectorsPerCluster) ||
		reservedSectors === 0 || fatCount === 0 || rootEntries !== 0 || fatSize16 !== 0 || fatSectors === 0 || totalSectors === 0) {
		return null;
	}

	let fatOffset = reservedSectors * bytesPerSector;
	let fatSize = fatSectors * bytesPerSector;
	let dataOffset = fatOffset + fatCount * fatSize;
	let clusterSize = bytesPerSector * sectorsPerCluster;
	let dataBytes = Math.min(totalSectors * bytesPerSector, volumeSize) - dataOffset;
	if(dataBytes <= 0) {
		return null;
	}
	let clusterCount = Math.min(Math.floor(dataBytes / clusterSize), Math.floor(fatSize / 4) - FIRST_DATA_CLUSTER);

	let rawLabel = boot.subarray(71, 82).toString('latin1').trimEnd();
	return {
		bytesPerSector, clusterSize, fatOffset, fatSize, dataOffset, clusterCount,
		rootCluster: boot.readUInt32LE(44),
		bootLabel: rawLabel && rawLabel !== 'NO NAME' ? rawLabel : undefined,
	};
}

/** DOS date and time (local time of the computer that wrote them; no time zone is stored) */
function dosTime(date: number, time = 0): Date | undefined {
	if(date === 0) {
		return undefined;
	}
	let year = 1980 + (date >> 9);
	let month = ((date >> 5) & 0x0f) - 1;
	let day = date & 0x1f;
	return new Date(year, month, day, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

function shortNameChecksum(raw: Buffer): number {
	let sum = 0;
	for(let i = 0; i < 11; i++) {
		sum = (((sum & 1) << 7) + (sum >> 1) + raw[i]) & 0xff;
	}
	return sum;
}

function shortName(entry: Buffer): string {
	let raw = Buffer.from(entry.subarray(0, 11));
	if(raw[0] === 0x05) {
		raw[0] = DELETED_MARKER; // a real first character 0xE5 is stored as 0x05
	}
	let base = raw.subarray(0, 8).toString('latin1').trimEnd();
	let extension = raw.subarray(8, 11).toString('latin1').trimEnd();
	if(entry[12] & NT_LOWERCASE_BASE) {
		base = base.toLowerCase();
	}
	if(entry[12] & NT_LOWERCASE_EXTENSION) {
		extension = extension.toLowerCase();
	}
	return extension ? base + '.' + extension : base;
}

/** The characters of one long-name entry, up to the terminating NUL (0xFFFF padding follows it) */
function longNamePart(entry: Buffer): string {
	let units: number[] = [];
	for(let [ start, count ] of [ [ 1, 5 ], [ 14, 6 ], [ 28, 2 ] ]) {
		for(let i = 0; i < count; i++) {
			let u = entry.readUInt16LE(start + i * 2);
			if(u === 0x0000) {
				return String.fromCharCode(...units);
			}
			units.push(u);
		}
	}
	return String.fromCharCode(...units);
}


/**
 * Files and folders of a FAT32 volume. Names match case-insensitively, like on Windows. Read-only.
 */
export class FatFS implements SnapshotFS {

	private _fatBlocks = createBlockCache<number>(8 * 1024 * 1024);
	private _folders = new LRUCache<number, Map<string, FatEntry>>(512, () => 1);
	private _chains = new LRUCache<number, ClusterRun[]>(4096, () => 1);

	private constructor(private _image: DiskImage, private _geometry: Geometry, private _fallbackTime: Date) {}

	static async open(image: DiskImage, fallbackTime = new Date(0)): Promise<FatFS | null> {
		if(image.size < 512) {
			return null;
		}
		let geometry = parseGeometry(await readExact(image, 0, 512), image.size);
		return geometry ? new FatFS(image, geometry, fallbackTime) : null;
	}

	/** Volume label: the root folder's label entry, else the boot sector's */
	async label(): Promise<string | undefined> {
		let label: string | undefined;
		await this.scanFolder(this._geometry.rootCluster, (entry) => {
			if((entry[11] & ATTR_LONG_NAME) !== ATTR_LONG_NAME && (entry[11] & ATTR_VOLUME_LABEL)) {
				label = entry.subarray(0, 11).toString('latin1').trimEnd();
				return false;
			}
			return true;
		});
		return label || this._geometry.bootLabel;
	}

	private async fatEntry(cluster: number): Promise<number> {
		let offset = cluster * 4;
		if(offset + 4 > this._geometry.fatSize) {
			throw new FormatError('FAT32 cluster ' + cluster + ' is outside of the FAT');
		}
		let blockIndex = Math.floor(offset / FAT_BLOCK_SIZE);
		let block = await this._fatBlocks.getOrLoad(blockIndex, () =>
			this._image.read(this._geometry.fatOffset + blockIndex * FAT_BLOCK_SIZE, Math.min(FAT_BLOCK_SIZE, this._geometry.fatSize - blockIndex * FAT_BLOCK_SIZE)));
		return block.readUInt32LE(offset - blockIndex * FAT_BLOCK_SIZE) & FAT32_ENTRY_MASK;
	}

	private isDataCluster(cluster: number) {
		return cluster >= FIRST_DATA_CLUSTER && cluster < FIRST_DATA_CLUSTER + this._geometry.clusterCount;
	}

	/** The clusters of a file or folder, as runs; 'maxBytes' stops early for files */
	private async chain(firstCluster: number, maxBytes = Infinity): Promise<ClusterRun[]> {
		let cached = this._chains.get(firstCluster);
		if(cached) {
			return cached;
		}
		let runs: ClusterRun[] = [];
		let maxClusters = Math.min(this._geometry.clusterCount, Math.ceil(maxBytes / this._geometry.clusterSize));
		let cluster = firstCluster;
		for(let n = 0; n < maxClusters; n++) {
			if(!this.isDataCluster(cluster)) {
				throw new FormatError('FAT32 chain starting at cluster ' + firstCluster + ' points to invalid cluster ' + cluster);
			}
			let last = runs[runs.length - 1];
			if(last && last.firstCluster + last.count === cluster) {
				last.count++;
			}
			else {
				runs.push({ firstCluster: cluster, count: 1 });
			}
			let next = await this.fatEntry(cluster);
			if(next >= FAT32_END_OF_CHAIN) {
				break;
			}
			if(next === FAT32_BAD_CLUSTER || next === 0) {
				throw new FormatError('FAT32 chain starting at cluster ' + firstCluster + ' is broken at cluster ' + cluster);
			}
			cluster = next;
		}
		this._chains.set(firstCluster, runs);
		return runs;
	}

	private clusterOffset(cluster: number) {
		return this._geometry.dataOffset + (cluster - FIRST_DATA_CLUSTER) * this._geometry.clusterSize;
	}

	/** Calls 'visit' for every 32-byte entry of a folder until it returns false or the folder ends */
	private async scanFolder(firstCluster: number, visit: (entry: Buffer) => boolean) {
		for(let run of await this.chain(firstCluster)) {
			let data = await readExact(this._image, this.clusterOffset(run.firstCluster), run.count * this._geometry.clusterSize);
			for(let at = 0; at + DIR_ENTRY_SIZE <= data.length; at += DIR_ENTRY_SIZE) {
				let entry = data.subarray(at, at + DIR_ENTRY_SIZE);
				if(entry[0] === 0x00) {
					return; // no more entries
				}
				if(!visit(entry)) {
					return;
				}
			}
		}
	}

	private async folder(firstCluster: number): Promise<Map<string, FatEntry>> {
		let cached = this._folders.get(firstCluster);
		if(cached) {
			return cached;
		}

		let byUppercaseName = new Map<string, FatEntry>();
		let longParts: string[] = [];
		let longChecksum = -1;
		await this.scanFolder(firstCluster, (entry) => {
			let attributes = entry[11];
			if(entry[0] === DELETED_MARKER) {
				longParts = [];
				return true;
			}
			if((attributes & ATTR_LONG_NAME) === ATTR_LONG_NAME) {
				if(entry[0] & LFN_LAST_PART) {
					longParts = [];
					longChecksum = entry[13];
				}
				longParts.unshift(longNamePart(entry));
				return true;
			}
			let raw = entry.subarray(0, 11);
			let longName = longParts.length > 0 && longChecksum === shortNameChecksum(raw) ? longParts.join('') : '';
			longParts = [];
			if(attributes & ATTR_VOLUME_LABEL) {
				return true;
			}
			let name = longName || shortName(entry);
			if(name === '.' || name === '..') {
				return true;
			}
			let isDirectory = (attributes & ATTR_DIRECTORY) !== 0;
			let e: FatEntry = {
				name,
				isDirectory,
				firstCluster: (entry.readUInt16LE(20) << 16 | entry.readUInt16LE(26)) >>> 0,
				size: isDirectory ? 0 : entry.readUInt32LE(28),
				modified: dosTime(entry.readUInt16LE(24), entry.readUInt16LE(22)) || this._fallbackTime,
				accessed: dosTime(entry.readUInt16LE(18)),
			};
			let key = name.toUpperCase();
			if(byUppercaseName.has(key)) {
				warn('FAT32 folder has two entries named ' + name + '; the first is used');
				return true;
			}
			byUppercaseName.set(key, e);
			return true;
		});

		this._folders.set(firstCluster, byUppercaseName);
		return byUppercaseName;
	}

	/** The entry at a path (the root has no entry), and the path as stored */
	private async resolve(path: string): Promise<{ entry: FatEntry | null; storedPath: string } | undefined> {
		let entry: FatEntry | null = null;
		let storedPath = '/';
		for(let part of splitPath(path)) {
			if(entry && !entry.isDirectory) {
				return undefined;
			}
			let found = (await this.folder(entry ? entry.firstCluster : this._geometry.rootCluster)).get(part.toUpperCase());
			if(!found) {
				return undefined;
			}
			entry = found;
			storedPath = joinPath(storedPath, found.name);
		}
		return { entry, storedPath };
	}

	private toFsEntry(e: FatEntry, path: string): FsEntry {
		return { name: e.name, path, type: e.isDirectory ? 'directory' : 'file', size: e.size, mtime: e.modified, atime: e.accessed };
	}

	async stat(path: string): Promise<FsEntry | undefined> {
		let found = await this.resolve(path);
		if(!found) {
			return undefined;
		}
		if(!found.entry) {
			return { name: '', path: '/', type: 'directory', size: 0, mtime: this._fallbackTime };
		}
		return this.toFsEntry(found.entry, found.storedPath);
	}

	async list(path: string): Promise<FsEntry[] | undefined> {
		let found = await this.resolve(path);
		if(!found || (found.entry && !found.entry.isDirectory)) {
			return undefined;
		}
		let folder = await this.folder(found.entry ? found.entry.firstCluster : this._geometry.rootCluster);
		return Array.from(folder.values()).map((e) => this.toFsEntry(e, joinPath(found!.storedPath, e.name)));
	}

	async read(path: string, offset: number, length: number): Promise<Buffer> {
		if(!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			throw new RangeError('Invalid read range');
		}
		let found = await this.resolve(path);
		if(!found || !found.entry) {
			throw new Error(found ? 'Is a folder: ' + path : 'No such file: ' + path);
		}
		let file = found.entry;
		if(file.isDirectory) {
			throw new Error('Is a folder: ' + path);
		}
		let end = Math.min(offset + length, file.size);
		if(offset >= end || file.firstCluster === 0) {
			return Buffer.alloc(0);
		}

		let clusterSize = this._geometry.clusterSize;
		let parts: Buffer[] = [];
		let runStart = 0; // byte offset in the file where the current run starts
		for(let run of await this.chain(file.firstCluster, file.size)) {
			let runEnd = runStart + run.count * clusterSize;
			if(runEnd > offset && runStart < end) {
				let from = Math.max(offset, runStart);
				let to = Math.min(end, runEnd);
				parts.push(await readExact(this._image, this.clusterOffset(run.firstCluster) + (from - runStart), to - from));
			}
			runStart = runEnd;
			if(runStart >= end) {
				break;
			}
		}
		let data = Buffer.concat(parts);
		if(data.length !== end - offset) {
			throw new FormatError(path + ': its cluster chain is shorter than its size');
		}
		return data;
	}

	async *walk(path: string = '/'): AsyncIterable<FsEntry> {
		let top = await this.stat(path);
		if(!top) {
			throw new Error('No such file or folder: ' + path);
		}
		let stack: FsEntry[] = [ top ];
		let visitedFolders = new Set<string>();
		while(stack.length > 0) {
			let entry = stack.pop()!;
			yield entry;
			if(entry.type !== 'directory' || visitedFolders.has(entry.path.toUpperCase())) {
				continue;
			}
			visitedFolders.add(entry.path.toUpperCase());
			let kids = await this.list(entry.path) || [];
			for(let i = kids.length - 1; i >= 0; i--) {
				stack.push(kids[i]);
			}
		}
	}
}


registerVolumeOpener(async (image: DiskImage) => {
	let fs = await FatFS.open(image);
	return fs ? { fs, type: 'FAT32', label: await fs.label() } : null;
});
