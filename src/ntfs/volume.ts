import { DiskImage, readExact } from '../disk/image';
import { FormatError, NotSupportedError } from '../errors';
import { LRUCache } from '../cache';
import { lznt1Decompress } from './lznt1';
import { xpressHuffmanDecompress } from './xpress';


export const enum AttributeType {
	StandardInformation = 0x10,
	AttributeList = 0x20,
	FileName = 0x30,
	VolumeName = 0x60,
	Data = 0x80,
	IndexRoot = 0x90,
	IndexAllocation = 0xa0,
	ReparsePoint = 0xc0,
	End = 0xffffffff,
}

const ATTRIBUTE_FLAG_COMPRESSED = 0x0001;
const ATTRIBUTE_FLAG_ENCRYPTED = 0x4000;
const RECORD_FLAG_IN_USE = 0x0001;
const RECORD_FLAG_DIRECTORY = 0x0002;
const INDEX_ENTRY_HAS_SUBNODE = 0x0001;
const INDEX_ENTRY_LAST = 0x0002;
const NAMESPACE_DOS = 2;
const REPARSE_TAG_WOF = 0x80000017;

export const ROOT_RECORD = 5;
const UPCASE_RECORD = 10;
const VOLUME_RECORD = 3;
/** Records below this number are NTFS's own files ($MFT, $Bitmap, ...), except the root */
export const FIRST_USER_RECORD = 16;

const FILETIME_UNIX_EPOCH = 116444736000000000n;

export function filetimeToDate(filetime: bigint): Date {
	if(filetime === 0n) {
		return new Date(0);
	}
	return new Date(Number((filetime - FILETIME_UNIX_EPOCH) / 10000n));
}

/** One run of a non-resident attribute: 'clusterCount' clusters at 'lcn' (-1 for a sparse run) */
export interface DataRun {
	vcn: number;
	lcn: number;
	clusterCount: number;
}

export interface Attribute {
	type: number;
	name: string;
	flags: number;
	id: number;
	isResident: boolean;
	/** Resident attributes */
	value?: Buffer;
	/** Non-resident attributes (only the first extent has the sizes) */
	startVcn: number;
	lastVcn: number;
	runs: DataRun[];
	compressionUnitLog2: number;
	allocatedSize: number;
	dataSize: number;
	initializedSize: number;
}

export interface MftRecord {
	number: number;
	isInUse: boolean;
	isDirectory: boolean;
	/** For extension records: the record they belong to */
	baseRecord: number;
	hardLinkCount: number;
	/** Every attribute, including those moved to extension records via $ATTRIBUTE_LIST */
	attributes: Attribute[];
}

export interface FileNameInfo {
	parentRecord: number;
	name: string;
	namespace: number;
	flags: number;
}

export interface IndexEntry {
	record: number;
	name: string;
	namespace: number;
}

/** Reads the 48-bit record number out of a 64-bit file reference */
function recordNumberOf(reference: bigint): number {
	return Number(reference & 0xffffffffffffn);
}

/**
 * Applies the "update sequence" of a multi-sector structure (FILE and INDX records): the last two bytes
 * of every 512-byte sector were replaced by a check value on disk; put the real bytes back.
 */
export function applyFixups(record: Buffer, structureName: string): Buffer {
	let updateSequenceOffset = record.readUInt16LE(4);
	let updateSequenceCount = record.readUInt16LE(6);
	if(updateSequenceCount === 0 || updateSequenceOffset + updateSequenceCount * 2 > record.length || (updateSequenceCount - 1) * 512 > record.length) {
		throw new FormatError('Bad update sequence in ' + structureName);
	}

	let fixed = Buffer.from(record);
	let checkValue = record.readUInt16LE(updateSequenceOffset);
	for(let i = 1; i < updateSequenceCount; i++) {
		let sectorEnd = i * 512 - 2;
		if(record.readUInt16LE(sectorEnd) !== checkValue) {
			throw new FormatError(structureName + ' is damaged (torn write; update sequence mismatch in sector ' + i + ')');
		}
		fixed.writeUInt16LE(record.readUInt16LE(updateSequenceOffset + i * 2), sectorEnd);
	}
	return fixed;
}

/**
 * Decodes a run list: header byte (low nibble: length bytes, high nibble: offset bytes), the cluster
 * count, then the LCN as a signed delta from the previous run (no offset bytes: a sparse run).
 */
export function decodeRunList(buf: Buffer, startVcn: number): DataRun[] {
	let runs: DataRun[] = [];
	let position = 0;
	let vcn = startVcn;
	let lcn = 0;

	while(position < buf.length && buf[position] !== 0) {
		let header = buf[position++];
		let lengthByteCount = header & 0x0f;
		let offsetByteCount = header >> 4;
		if(lengthByteCount === 0 || lengthByteCount > 8 || offsetByteCount > 8 || position + lengthByteCount + offsetByteCount > buf.length) {
			throw new FormatError('Bad NTFS run list');
		}

		let clusterCount = Number(buf.readUIntLE(position, Math.min(lengthByteCount, 6)));
		if(lengthByteCount > 6 && buf.subarray(position + 6, position + lengthByteCount).some((b) => b !== 0)) {
			throw new FormatError('NTFS run too long');
		}
		position += lengthByteCount;

		if(offsetByteCount === 0) {
			runs.push({ vcn, lcn: -1, clusterCount });
		}
		else {
			let delta = 0n;
			for(let i = offsetByteCount - 1; i >= 0; i--) {
				delta = (delta << 8n) | BigInt(buf[position + i]);
			}
			if(buf[position + offsetByteCount - 1] & 0x80) {
				delta -= 1n << BigInt(offsetByteCount * 8);
			}
			lcn += Number(delta);
			if(lcn < 0) {
				throw new FormatError('NTFS run points before the start of the volume');
			}
			runs.push({ vcn, lcn, clusterCount });
		}
		position += offsetByteCount;
		vcn += clusterCount;
	}
	return runs;
}

function readUint64(buf: Buffer, offset: number): number {
	let v = buf.readBigUInt64LE(offset);
	if(v > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new FormatError('NTFS value too large');
	}
	return Number(v);
}

/** Parses the attributes of one (fixed-up) MFT record, without following $ATTRIBUTE_LIST */
function parseAttributes(record: Buffer, recordNumber: number): Attribute[] {
	let attributes: Attribute[] = [];
	let position = record.readUInt16LE(0x14);
	let usedSize = Math.min(record.readUInt32LE(0x18), record.length);

	while(position + 8 <= usedSize) {
		let type = record.readUInt32LE(position);
		if(type === AttributeType.End) {
			break;
		}
		let length = record.readUInt32LE(position + 4);
		if(length < 0x18 || position + length > usedSize) {
			throw new FormatError('Bad attribute in MFT record ' + recordNumber);
		}

		let a = record.subarray(position, position + length);
		let nameLength = a[9];
		let nameOffset = a.readUInt16LE(10);
		let attribute: Attribute = {
			type,
			name: nameLength ? a.toString('utf16le', nameOffset, nameOffset + nameLength * 2) : '',
			flags: a.readUInt16LE(12),
			id: a.readUInt16LE(14),
			isResident: a[8] === 0,
			startVcn: 0, lastVcn: -1, runs: [], compressionUnitLog2: 0,
			allocatedSize: 0, dataSize: 0, initializedSize: 0,
		};

		if(attribute.isResident) {
			let valueLength = a.readUInt32LE(0x10);
			let valueOffset = a.readUInt16LE(0x14);
			if(valueOffset + valueLength > length) {
				throw new FormatError('Bad resident attribute in MFT record ' + recordNumber);
			}
			attribute.value = Buffer.from(a.subarray(valueOffset, valueOffset + valueLength));
			attribute.dataSize = attribute.initializedSize = attribute.allocatedSize = valueLength;
		}
		else {
			if(length < 0x40) {
				throw new FormatError('Bad non-resident attribute in MFT record ' + recordNumber);
			}
			attribute.startVcn = readUint64(a, 0x10);
			attribute.lastVcn = Number(a.readBigInt64LE(0x18));
			let runListOffset = a.readUInt16LE(0x20);
			attribute.compressionUnitLog2 = a.readUInt16LE(0x22);
			attribute.allocatedSize = readUint64(a, 0x28);
			attribute.dataSize = readUint64(a, 0x30);
			attribute.initializedSize = readUint64(a, 0x38);
			attribute.runs = decodeRunList(a.subarray(runListOffset), attribute.startVcn);
		}

		attributes.push(attribute);
		position += length;
	}
	return attributes;
}

export function parseFileName(value: Buffer): FileNameInfo {
	if(value.length < 0x42) {
		throw new FormatError('Bad $FILE_NAME attribute');
	}
	let nameLength = value[0x40];
	return {
		parentRecord: recordNumberOf(value.readBigUInt64LE(0)),
		flags: value.readUInt32LE(0x38),
		namespace: value[0x41],
		name: value.toString('utf16le', 0x42, 0x42 + nameLength * 2),
	};
}


/**
 * Bytes of one attribute stream (unnamed $DATA, a named stream, $INDEX_ALLOCATION...), from all of
 * its extents. Handles resident data, sparse runs, NTFS compression and the uninitialized tail.
 */
export class AttributeStream {
	readonly size: number;
	private _runs: DataRun[];
	private _first: Attribute;

	constructor(private _volume: NtfsVolume, extents: Attribute[], description: string) {
		let sorted = extents.slice().sort((a, b) => a.startVcn - b.startVcn);
		this._first = sorted[0];
		this.size = this._first.dataSize;
		this._runs = sorted.flatMap((e) => e.runs);

		if(this._first.flags & ATTRIBUTE_FLAG_ENCRYPTED) {
			throw new NotSupportedError(description + ' is encrypted with EFS', 'encrypted');
		}
	}

	get isCompressed() {
		return !this._first.isResident && (this._first.flags & ATTRIBUTE_FLAG_COMPRESSED) !== 0 && this._first.compressionUnitLog2 > 0;
	}

	async read(offset: number, length: number): Promise<Buffer> {
		let end = Math.min(offset + length, this.size);
		if(offset >= end) {
			return Buffer.alloc(0);
		}

		if(this._first.isResident) {
			return Buffer.from(this._first.value!.subarray(offset, end));
		}

		let readableEnd = Math.min(end, this._first.initializedSize);
		let out = Buffer.alloc(end - offset);
		if(offset < readableEnd) {
			let data = this.isCompressed
				? await this.readCompressed(offset, readableEnd - offset)
				: await this.readClusters(offset, readableEnd - offset);
			data.copy(out, 0);
		}
		return out;
	}

	/** Plain (or sparse) runs */
	private async readClusters(offset: number, length: number): Promise<Buffer> {
		let clusterSize = this._volume.clusterSize;
		let out = Buffer.alloc(length);
		let position = offset;
		let end = offset + length;

		let runIndex = this.findRun(Math.floor(position / clusterSize));
		while(position < end) {
			let vcn = Math.floor(position / clusterSize);
			while(runIndex < this._runs.length && this._runs[runIndex].vcn + this._runs[runIndex].clusterCount <= vcn) {
				runIndex++;
			}
			let run = this._runs[runIndex];
			if(!run || run.vcn > vcn) {
				// Not mapped: treated like a sparse run
				let nextMapped = run ? run.vcn * clusterSize : end;
				position = Math.min(end, nextMapped);
				continue;
			}

			let runEnd = Math.min(end, (run.vcn + run.clusterCount) * clusterSize);
			if(run.lcn >= 0) {
				let diskOffset = (run.lcn + (vcn - run.vcn)) * clusterSize + (position - vcn * clusterSize);
				let bytes = await this._volume.readDisk(diskOffset, runEnd - position);
				bytes.copy(out, position - offset);
			}
			position = runEnd;
		}
		return out;
	}

	private findRun(vcn: number): number {
		let low = 0;
		let high = this._runs.length - 1;
		let found = 0;
		while(low <= high) {
			let mid = (low + high) >> 1;
			if(this._runs[mid].vcn <= vcn) {
				found = mid;
				low = mid + 1;
			}
			else {
				high = mid - 1;
			}
		}
		return found;
	}

	/**
	 * NTFS compression works in units of 2^compressionUnitLog2 clusters (usually 16): a unit with no
	 * clusters is zeros, a full unit is stored as is, otherwise its clusters hold LZNT1 data.
	 */
	private async readCompressed(offset: number, length: number): Promise<Buffer> {
		let clusterSize = this._volume.clusterSize;
		let unitClusters = 1 << this._first.compressionUnitLog2;
		let unitSize = unitClusters * clusterSize;
		let out = Buffer.alloc(length);
		let end = offset + length;

		for(let unitStart = Math.floor(offset / unitSize) * unitSize; unitStart < end; unitStart += unitSize) {
			let unit = await this._volume.cachedUnit(this, unitStart, () => this.decompressUnit(unitStart / clusterSize, unitClusters));
			let from = Math.max(offset, unitStart);
			let to = Math.min(end, unitStart + unitSize);
			unit.copy(out, from - offset, from - unitStart, to - unitStart);
		}
		return out;
	}

	private async decompressUnit(firstVcn: number, unitClusters: number): Promise<Buffer> {
		let clusterSize = this._volume.clusterSize;
		let pieces: Buffer[] = [];
		let storedClusters = 0;

		for(let vcn = firstVcn; vcn < firstVcn + unitClusters;) {
			let run = this._runs[this.findRun(vcn)];
			if(!run || run.vcn > vcn || run.vcn + run.clusterCount <= vcn || run.lcn < 0) {
				let sparseEnd = run && run.vcn + run.clusterCount > vcn && run.vcn <= vcn ? run.vcn + run.clusterCount : vcn + 1;
				vcn = Math.min(sparseEnd, firstVcn + unitClusters);
				continue;
			}
			let count = Math.min(run.vcn + run.clusterCount, firstVcn + unitClusters) - vcn;
			pieces.push(await this._volume.readDisk((run.lcn + vcn - run.vcn) * clusterSize, count * clusterSize));
			storedClusters += count;
			vcn += count;
		}

		let unitSize = unitClusters * clusterSize;
		if(storedClusters === 0) {
			return Buffer.alloc(unitSize);
		}
		let stored = Buffer.concat(pieces);
		if(storedClusters === unitClusters) {
			return stored;
		}
		return lznt1Decompress(stored, unitSize);
	}
}


/**
 * Windows Compact OS / WOF: the file's real data is in the ":WofCompressedData" stream, as chunks of
 * 4, 8 or 16 KiB compressed with Xpress Huffman (LZX isn't supported), preceded by a table of where
 * each chunk after the first starts.
 */
export class WofStream {
	readonly chunkSize: number;
	private _tableEntrySize: number;
	private _chunkCount: number;
	private _offsets?: Promise<number[]>;

	constructor(private _volume: NtfsVolume, private _compressed: AttributeStream, readonly size: number, algorithm: number) {
		let chunkSizes: { [a: number]: number } = { 0: 4096, 2: 8192, 3: 16384 };
		if(algorithm === 1) {
			throw new NotSupportedError('This file uses Windows LZX compression (Compact OS), which can\'t be read yet');
		}
		if(!chunkSizes[algorithm]) {
			throw new NotSupportedError('Unknown Compact OS compression ' + algorithm);
		}
		this.chunkSize = chunkSizes[algorithm];
		this._chunkCount = Math.ceil(size / this.chunkSize);
		this._tableEntrySize = size > 0xffffffff ? 8 : 4;
	}

	private chunkStarts(): Promise<number[]> {
		if(!this._offsets) {
			this._offsets = (async () => {
				let tableSize = Math.max(0, this._chunkCount - 1) * this._tableEntrySize;
				let table = await this._compressed.read(0, tableSize);
				let starts = [ tableSize ];
				for(let i = 0; i + 1 < this._chunkCount; i++) {
					let entry = this._tableEntrySize === 8 ? readUint64(table, i * 8) : table.readUInt32LE(i * 4);
					starts.push(tableSize + entry);
				}
				starts.push(this._compressed.size);
				for(let i = 1; i < starts.length; i++) {
					if(starts[i] < starts[i - 1] || starts[i] > this._compressed.size) {
						throw new FormatError('Compact OS chunk table is damaged');
					}
				}
				return starts;
			})();
		}
		return this._offsets;
	}

	async read(offset: number, length: number): Promise<Buffer> {
		let end = Math.min(offset + length, this.size);
		if(offset >= end) {
			return Buffer.alloc(0);
		}
		let starts = await this.chunkStarts();
		let out = Buffer.alloc(end - offset);
		for(let chunkIndex = Math.floor(offset / this.chunkSize); chunkIndex * this.chunkSize < end; chunkIndex++) {
			let chunkStart = chunkIndex * this.chunkSize;
			let chunkLength = Math.min(this.chunkSize, this.size - chunkStart);
			let chunk = await this._volume.cachedUnit(this, chunkStart, async () => {
				let compressed = await this._compressed.read(starts[chunkIndex], starts[chunkIndex + 1] - starts[chunkIndex]);
				return compressed.length === chunkLength ? compressed : xpressHuffmanDecompress(compressed, chunkLength);
			});
			let from = Math.max(offset, chunkStart);
			let to = Math.min(end, chunkStart + chunkLength);
			chunk.copy(out, from - offset, from - chunkStart, to - chunkStart);
		}
		return out;
	}
}

export type FileStream = AttributeStream | WofStream;


/**
 * Read-only access to an NTFS volume image.
 */
export class NtfsVolume {

	readonly clusterSize: number;
	readonly mftRecordSize: number;
	readonly indexRecordSize: number;
	readonly totalSize: number;
	private _mftLcn: number;
	private _mft!: AttributeStream;
	private _records = new LRUCache<number, MftRecord>(4096, () => 1);
	private _units = new LRUCache<string, Buffer>(32 * 1024 * 1024, (b) => b.length);
	private _unitOwners = new WeakMap<object, number>();
	private _nextUnitOwner = 1;
	private _upcase?: Promise<Uint16Array>;

	private constructor(private _image: DiskImage, boot: Buffer) {
		let bytesPerSector = boot.readUInt16LE(0x0b);
		let sectorsPerClusterRaw = boot[0x0d];
		let sectorsPerCluster = sectorsPerClusterRaw > 0x80 ? 1 << (256 - sectorsPerClusterRaw) : sectorsPerClusterRaw;
		this.clusterSize = bytesPerSector * sectorsPerCluster;

		let sizeFrom = (raw: number) => raw >= 0x80 ? 1 << (256 - raw) : raw * this.clusterSize;
		this.mftRecordSize = sizeFrom(boot[0x40]);
		this.indexRecordSize = sizeFrom(boot[0x44]);
		this.totalSize = readUint64(boot, 0x28) * bytesPerSector;
		this._mftLcn = readUint64(boot, 0x30);

		let isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;
		if(![ 512, 1024, 2048, 4096 ].includes(bytesPerSector) || !isPowerOfTwo(this.clusterSize) || this.clusterSize > 2 * 1024 * 1024 ||
			!isPowerOfTwo(this.mftRecordSize) || this.mftRecordSize < 512 || this.mftRecordSize > 65536 ||
			!isPowerOfTwo(this.indexRecordSize) || this.indexRecordSize < 512 || this.indexRecordSize > 65536) {
			throw new FormatError('NTFS boot sector has an implausible layout');
		}
	}

	/** Whether a volume starts with an NTFS boot sector */
	static async isNtfs(image: DiskImage): Promise<boolean> {
		if(image.size < 4096) {
			return false;
		}
		let boot = await image.read(0, 512);
		return boot.toString('latin1', 3, 11) === 'NTFS    ' && boot[510] === 0x55 && boot[511] === 0xaa;
	}

	static async open(image: DiskImage): Promise<NtfsVolume> {
		let boot = await readExact(image, 0, 512);
		if(boot.toString('latin1', 3, 11) !== 'NTFS    ') {
			throw new FormatError('Not an NTFS volume');
		}
		let volume = new NtfsVolume(image, boot);
		await volume.loadMft();
		return volume;
	}

	readDisk(offset: number, length: number): Promise<Buffer> {
		return readExact(this._image, offset, length);
	}

	/** Shared cache for decompressed units of compressed streams */
	cachedUnit(owner: object, unitStart: number, load: () => Promise<Buffer>): Promise<Buffer> {
		let id = this._unitOwners.get(owner);
		if(id === undefined) {
			id = this._nextUnitOwner++;
			this._unitOwners.set(owner, id);
		}
		return this._units.getOrLoad(id + ':' + unitStart, load);
	}

	/**
	 * $MFT describes itself: record 0's $DATA says where the MFT is. If the MFT is so fragmented that
	 * record 0 has an $ATTRIBUTE_LIST, its other extents are read with the runs known so far.
	 */
	private async loadMft() {
		let raw = applyFixups(await this.readDisk(this._mftLcn * this.clusterSize, this.mftRecordSize), 'MFT record 0');
		if(raw.toString('latin1', 0, 4) !== 'FILE') {
			throw new FormatError('NTFS volume has no MFT where its boot sector says');
		}
		let attributes = parseAttributes(raw, 0);
		let data = attributes.filter((a) => a.type === AttributeType.Data && a.name === '');
		if(data.length === 0 || data[0].isResident) {
			throw new FormatError('MFT record 0 has no data');
		}
		this._mft = new AttributeStream(this, data, '$MFT');

		let list = attributes.find((a) => a.type === AttributeType.AttributeList);
		if(list) {
			let record: MftRecord = { number: 0, isInUse: true, isDirectory: false, baseRecord: 0, hardLinkCount: 1, attributes };
			await this.followAttributeList(record, list);
			let allData = record.attributes.filter((a) => a.type === AttributeType.Data && a.name === '');
			this._mft = new AttributeStream(this, allData, '$MFT');
		}
	}

	get recordCount(): number {
		return Math.floor(this._mft.size / this.mftRecordSize);
	}

	private async readRawRecord(number: number): Promise<Buffer | null> {
		if(number < 0 || number >= this.recordCount) {
			throw new FormatError('MFT record ' + number + ' is outside of the MFT');
		}
		let raw = await this._mft.read(number * this.mftRecordSize, this.mftRecordSize);
		if(raw.toString('latin1', 0, 4) !== 'FILE') {
			return null;
		}
		return applyFixups(raw, 'MFT record ' + number);
	}

	/**
	 * An MFT record with all of its attributes (following $ATTRIBUTE_LIST). Null for unused records.
	 */
	record(number: number): Promise<MftRecord | null> {
		let cached = this._records.get(number);
		if(cached) {
			return Promise.resolve(cached);
		}
		return (async () => {
			let raw = await this.readRawRecord(number);
			if(!raw) {
				return null;
			}
			let flags = raw.readUInt16LE(0x16);
			let record: MftRecord = {
				number,
				isInUse: (flags & RECORD_FLAG_IN_USE) !== 0,
				isDirectory: (flags & RECORD_FLAG_DIRECTORY) !== 0,
				baseRecord: recordNumberOf(raw.readBigUInt64LE(0x20)),
				hardLinkCount: raw.readUInt16LE(0x12),
				attributes: parseAttributes(raw, number),
			};

			let list = record.attributes.find((a) => a.type === AttributeType.AttributeList);
			if(list) {
				await this.followAttributeList(record, list);
			}

			this._records.set(number, record);
			return record;
		})();
	}

	/**
	 * $ATTRIBUTE_LIST: attributes that didn't fit in the record live in extension records. Each entry:
	 * type, entry length, name length/offset, starting VCN, record reference, attribute id, name.
	 */
	private async followAttributeList(record: MftRecord, list: Attribute) {
		let value = list.isResident ? list.value! : await new AttributeStream(this, [ list ], 'attribute list').read(0, list.dataSize);
		let wanted = new Map<number, Array<{ type: number; id: number }>>();

		for(let position = 0; position + 0x1a <= value.length;) {
			let entryLength = value.readUInt16LE(position + 4);
			if(entryLength < 0x1a) {
				throw new FormatError('Bad attribute list in MFT record ' + record.number);
			}
			let type = value.readUInt32LE(position);
			let extensionRecord = recordNumberOf(value.readBigUInt64LE(position + 0x10));
			let id = value.readUInt16LE(position + 0x18);
			if(extensionRecord !== record.number) {
				let list = wanted.get(extensionRecord) || [];
				list.push({ type, id });
				wanted.set(extensionRecord, list);
			}
			position += entryLength;
		}

		for(let [ extensionNumber, attributes ] of wanted) {
			let raw = await this.readRawRecord(extensionNumber);
			if(!raw) {
				throw new FormatError('MFT record ' + record.number + ' refers to a missing extension record ' + extensionNumber);
			}
			let parsed = parseAttributes(raw, extensionNumber);
			for(let w of attributes) {
				let found = parsed.find((a) => a.type === w.type && a.id === w.id);
				if(found) {
					record.attributes.push(found);
				}
			}
		}
	}

	/** Every extent of the attribute with this type and name */
	static extentsOf(record: MftRecord, type: number, name = ''): Attribute[] {
		return record.attributes.filter((a) => a.type === type && a.name === name);
	}

	static fileNames(record: MftRecord): FileNameInfo[] {
		return record.attributes.filter((a) => a.type === AttributeType.FileName && a.isResident).map((a) => parseFileName(a.value!));
	}

	static times(record: MftRecord): { created: Date; modified: Date; accessed: Date; attributes: number } | null {
		let si = record.attributes.find((a) => a.type === AttributeType.StandardInformation && a.isResident);
		if(!si || si.value!.length < 0x24) {
			return null;
		}
		let v = si.value!;
		return {
			created: filetimeToDate(v.readBigUInt64LE(0)),
			modified: filetimeToDate(v.readBigUInt64LE(8)),
			accessed: filetimeToDate(v.readBigUInt64LE(0x18)),
			attributes: v.readUInt32LE(0x20),
		};
	}

	/**
	 * The data of a file: its unnamed $DATA, or the decompressed Compact OS data for WOF files.
	 * Null if the record has no data stream.
	 */
	fileStream(record: MftRecord, streamName = ''): FileStream | null {
		let extents = NtfsVolume.extentsOf(record, AttributeType.Data, streamName);
		if(extents.length === 0) {
			return null;
		}
		let stream = new AttributeStream(this, extents, 'MFT record ' + record.number + (streamName ? ':' + streamName : ''));

		if(streamName === '') {
			let reparse = record.attributes.find((a) => a.type === AttributeType.ReparsePoint && a.isResident);
			if(reparse && reparse.value!.length >= 24 && reparse.value!.readUInt32LE(0) === REPARSE_TAG_WOF) {
				// Reparse data: WOF header (version, provider 2 = file), then the file provider (version, algorithm)
				let provider = reparse.value!.readUInt32LE(12);
				let algorithm = reparse.value!.readUInt32LE(20);
				let compressed = NtfsVolume.extentsOf(record, AttributeType.Data, 'WofCompressedData');
				if(provider === 2 && compressed.length > 0) {
					return new WofStream(this, new AttributeStream(this, compressed, 'Compact OS data'), stream.size, algorithm);
				}
			}
		}
		return stream;
	}

	/** Names of the record's named data streams (alternate data streams) */
	static streamNames(record: MftRecord): string[] {
		let names = new Set<string>();
		for(let a of record.attributes) {
			if(a.type === AttributeType.Data && a.name !== '' && a.name !== 'WofCompressedData') {
				names.add(a.name);
			}
		}
		return Array.from(names);
	}

	/**
	 * Entries of a folder's $I30 index, in index order. DOS-only 8.3 names are left out (Windows shows
	 * the long name, which is a separate entry).
	 */
	async listDirectory(record: MftRecord): Promise<IndexEntry[]> {
		let root = NtfsVolume.extentsOf(record, AttributeType.IndexRoot, '$I30')[0];
		if(!root || !root.isResident) {
			return [];
		}
		let allocationExtents = NtfsVolume.extentsOf(record, AttributeType.IndexAllocation, '$I30');
		let allocation = allocationExtents.length ? new AttributeStream(this, allocationExtents, 'folder index of record ' + record.number) : null;

		let rootValue = root.value!;
		let indexRecordSize = rootValue.readUInt32LE(8);
		let entries: IndexEntry[] = [];
		let visited = new Set<number>();

		let visitNode = async (node: Buffer, nodeHeaderOffset: number) => {
			let firstEntry = nodeHeaderOffset + node.readUInt32LE(nodeHeaderOffset);
			let entriesEnd = Math.min(node.length, nodeHeaderOffset + node.readUInt32LE(nodeHeaderOffset + 4));
			for(let position = firstEntry; position + 0x10 <= entriesEnd;) {
				let entryLength = node.readUInt16LE(position + 8);
				let keyLength = node.readUInt16LE(position + 10);
				let flags = node.readUInt16LE(position + 12);
				if(entryLength < 0x10 || position + entryLength > entriesEnd) {
					throw new FormatError('Bad folder index entry in record ' + record.number);
				}

				if(flags & INDEX_ENTRY_HAS_SUBNODE) {
					let childVcn = readUint64(node, position + entryLength - 8);
					await visitChild(childVcn);
				}
				if(flags & INDEX_ENTRY_LAST) {
					break;
				}
				if(keyLength >= 0x42) {
					let info = parseFileName(node.subarray(position + 0x10, position + 0x10 + keyLength));
					if(info.namespace !== NAMESPACE_DOS) {
						entries.push({ record: recordNumberOf(node.readBigUInt64LE(position)), name: info.name, namespace: info.namespace });
					}
				}
				position += entryLength;
			}
		};

		let visitChild = async (vcn: number) => {
			if(!allocation) {
				throw new FormatError('Folder index of record ' + record.number + ' refers to a missing allocation');
			}
			if(visited.has(vcn) || visited.size > 1000000) {
				throw new FormatError('Folder index of record ' + record.number + ' has a loop');
			}
			visited.add(vcn);
			let vcnUnit = indexRecordSize >= this.clusterSize ? this.clusterSize : 512;
			let raw = await allocation.read(vcn * vcnUnit, indexRecordSize);
			if(raw.length < indexRecordSize || raw.toString('latin1', 0, 4) !== 'INDX') {
				throw new FormatError('Missing folder index block in record ' + record.number);
			}
			let fixed = applyFixups(raw, 'folder index block');
			await visitNode(fixed, 0x18);
		};

		await visitNode(rootValue, 0x10);
		return entries;
	}

	/** The volume's upper-case table ($UpCase), for case-insensitive names like Windows */
	upcaseTable(): Promise<Uint16Array> {
		if(!this._upcase) {
			this._upcase = (async () => {
				let table = new Uint16Array(65536);
				for(let i = 0; i < 65536; i++) {
					table[i] = String.fromCharCode(i).toUpperCase().length === 1 ? String.fromCharCode(i).toUpperCase().charCodeAt(0) : i;
				}
				try {
					let record = await this.record(UPCASE_RECORD);
					let stream = record ? this.fileStream(record) : null;
					if(stream && stream.size >= 131072) {
						let raw = await stream.read(0, 131072);
						for(let i = 0; i < 65536; i++) {
							table[i] = raw.readUInt16LE(i * 2);
						}
					}
				}
				catch(e) {
					// Fall back to JavaScript's upper-casing
				}
				return table;
			})();
		}
		return this._upcase;
	}

	async label(): Promise<string | undefined> {
		let record = await this.record(VOLUME_RECORD);
		let name = record && record.attributes.find((a) => a.type === AttributeType.VolumeName && a.isResident);
		return name && name.value!.length ? name.value!.toString('utf16le') : undefined;
	}
}
