import { ReadCompressedStream } from '../compression';
import { Reader, readUint64LE } from '../reader';
import { FormatError } from '../errors';
import { warn } from '../log';

// See doc/Format-Windows.md for the layouts parsed here


// A RecordIndex starts with 01 02, a 16-bit kind, then 01 00 00 00
const INDEX_KIND_BLOCKS = 0x1000; /**< The usual kind: the file's data is stored in blocks */
const INDEX_KIND_NO_DATA = 0x0007; /**< Seen once: no blocks stored, one range over the whole file */

export enum RecordType {
	Attributes = 1, /**< uint32 Windows file attributes of an entry */
	Security = 2, /**< Windows security descriptor of an entry (seen on folders and empty files) */
	Times = 5, /**< Creation and modification time of an entry */
	Config = 101, /**< XML key/value configuration of the slice */
	FileMetaStart = 102, /**< First record of every entry's metadata */
	Listing = 103, /**< List of every file and folder in the slice */
	EndTrailer = 104, /**< End of the metadata */
	RecordIndex = 108, /**< Where each block of a file's data is stored */
	Blob = 109, /**< A block of file data */
	BlobSuffix = 110, /**< Written after the last block of each file (empty) */
}

/**
 * Value of the 'kind' field of a listing entry
 */
export enum EntryKind {
	File = 0,
	Folder = 0x80,
	Root = 0x83, /**< Root of a backed up drive, e.g. "G:" */
}

/**
 * Windows FILE_ATTRIBUTE_* flags (record type 1)
 */
export const FileAttribute = {
	ReadOnly: 0x1,
	Hidden: 0x2,
	System: 0x4,
	Directory: 0x10,
	Archive: 0x20,
} as const;

// Records stored with a raw deflate stream followed by 4 unknown bytes (probably a checksum)
const RAW_DEFLATE_TYPES = new Set<number>([
	RecordType.Attributes, RecordType.Security, RecordType.Times, RecordType.Config,
	RecordType.FileMetaStart, RecordType.Listing
]);

// Records stored as a zlib stream
const ZLIB_TYPES = new Set<number>([ RecordType.Blob, RecordType.BlobSuffix, RecordType.RecordIndex ]);


export interface ConfigAttribute {
	key: string;
	value: string;
}

export interface ListingEntry {
	path: string; /**< Full path with '/' separators, e.g. "G:/Users/me/file.txt" */
	name: string;
	kind: EntryKind;
	mtime: Date;
	size: number;
	metaOffset: number; /**< Offset of the entry's FileMetaStart record, from the start of the archive (after the header) */
}

export interface RecordHandle {
	startOffset: number; /**< Offset inside the file where this block starts */
	recordOffset: number; /**< Offset of the Blob record, from the start of the archive (after the header) */
	hash: Buffer; /**< MD5 of the decompressed block */
}

interface OpaqueRecord {
	// Position of this record in the reader it was read from
	start: number;
	end: number;
}

export interface ConfigRecord extends OpaqueRecord {
	type: RecordType.Config;
	attrs: ConfigAttribute[];
	creationTime?: Date; /**< When the backup was made */
	id?: Buffer; /**< 16 byte identifier (most likely of the slice) */
}

export interface IndexRecord extends OpaqueRecord {
	type: RecordType.RecordIndex;
	kind: number; /**< 0x1000 normally; 0x0007 when no data blocks are stored (see doc/Format-Windows.md) */
	totalSize: number;
	handles: RecordHandle[];
}

export interface AttributesRecord extends OpaqueRecord {
	type: RecordType.Attributes;
	attributes: number;
}

export interface TimesRecord extends OpaqueRecord {
	type: RecordType.Times;
	created: Date;
	modified: Date;
}

export interface EndTrailerRecord extends OpaqueRecord {
	type: RecordType.EndTrailer;
}

export interface ListingRecord extends OpaqueRecord {
	type: RecordType.Listing;
	files: ListingEntry[];
}

export interface BlobRecord extends OpaqueRecord {
	type: RecordType.Blob;
	data: Buffer;
}

export interface UnparsedRecord extends OpaqueRecord {
	type: RecordType.FileMetaStart | RecordType.Security | RecordType.BlobSuffix;
}

export type Record = ConfigRecord | IndexRecord | AttributesRecord | TimesRecord | EndTrailerRecord |
	ListingRecord | BlobRecord | UnparsedRecord;


/**
 * Reads the type of the record at the current position without moving the reader
 */
export async function PeekRecordType(reader: Reader): Promise<number> {
	let pos = reader.pos();
	let type = await reader.readUint8();
	reader.seek(pos);
	return type;
}

export async function ReadRecord(reader: Reader): Promise<Record> {

	let start = reader.pos();

	let type = await reader.readUint8();

	if(type === RecordType.EndTrailer) {
		return { start, end: reader.pos(), type };
	}

	let data: Buffer;
	if(ZLIB_TYPES.has(type)) {
		data = await ReadCompressedStream(reader, -1);
	}
	else if(RAW_DEFLATE_TYPES.has(type)) {
		data = await ReadCompressedStream(reader, -1, true);

		// 4 bytes of something checksum-like (not an Adler-32 of the data)
		reader.skip(4);
	}
	else {
		throw new FormatError('Unknown record type ' + type + ' at ' + start);
	}

	let end = reader.pos();

	switch(type) {
		case RecordType.Blob:
			return { start, end, type, data };

		case RecordType.Config:
			return { start, end, type, ...parseConfig(data) };

		case RecordType.Listing:
			return { start, end, type, files: parseListing(data) };

		case RecordType.RecordIndex:
			return { start, end, type, ...parseIndex(data) };

		case RecordType.Attributes:
			if(data.length < 4) {
				throw new FormatError('Attributes record too short at ' + start);
			}
			return { start, end, type, attributes: data.readUInt32LE(0) };

		case RecordType.Times:
			if(data.length < 16) {
				throw new FormatError('Times record too short at ' + start);
			}
			return {
				start, end, type,
				created: new Date(readUint64LE(data, 0)),
				modified: new Date(readUint64LE(data, 8))
			};

		case RecordType.FileMetaStart:
		case RecordType.Security:
		case RecordType.BlobSuffix:
			return { start, end, type };
	}

	throw new FormatError('Unhandled record type ' + type + ' at ' + start);
}


function readU16String(data: Buffer, pos: number, len: number): string {
	if(pos + len * 2 > data.length) {
		throw new FormatError('String runs past the end of its record');
	}

	return data.subarray(pos, pos + len * 2).toString('utf16le');
}

function stripNul(s: string) {
	let i = s.indexOf('\0');
	return i >= 0 ? s.slice(0, i) : s;
}


// Offsets inside the config record before the attribute list
const CONFIG_CREATION_TIME = 68;
const CONFIG_ID = 149;
const CONFIG_NUM_ATTRS = 165;

function parseConfig(data: Buffer): { attrs: ConfigAttribute[]; creationTime?: Date; id?: Buffer } {
	if(data.length < CONFIG_NUM_ATTRS + 4) {
		throw new FormatError('Config record too short');
	}

	let creationTime: Date | undefined;
	try {
		let ms = readUint64LE(data, CONFIG_CREATION_TIME);
		if(ms > 0) {
			creationTime = new Date(ms);
		}
	}
	catch(e) {
		warn('Config record has an unreadable creation time');
	}

	let id = Buffer.from(data.subarray(CONFIG_ID, CONFIG_ID + 16));

	let pos = CONFIG_NUM_ATTRS;
	let numAttribs = data.readUInt32LE(pos); pos += 4;

	let attrs: ConfigAttribute[] = [];

	// There is always one extra byte at the end
	while(pos < data.length - 1) {
		let keyLength = data.readUInt32LE(pos); pos += 4;
		let key = readU16String(data, pos, keyLength); pos += keyLength * 2;

		let valLength = data.readUInt32LE(pos); pos += 4;
		// The value usually starts with a 0xFFFE byte order mark
		let value = readU16String(data, pos, valLength); pos += valLength * 2;

		attrs.push({ key: stripNul(key), value: value.replace(/^\uFEFF/, '') });
	}

	if(pos + 1 !== data.length || attrs.length !== numAttribs) {
		warn('Config record has ' + attrs.length + ' attributes, expected ' + numAttribs);
	}

	return { attrs, creationTime, id };
}


function parseListing(data: Buffer): ListingEntry[] {
	let pos = 0;

	let numEntries = data.readUInt32LE(pos); pos += 4;

	let files: ListingEntry[] = [];

	while(pos < data.length) {
		let pathLength = data.readUInt32LE(pos); pos += 4;
		let path = stripNul(readU16String(data, pos, pathLength)); pos += pathLength * 2;

		// Size of the rest of the entry, in 2-byte units
		let restSize = data.readUInt32LE(pos) * 2; pos += 4;
		let restEnd = pos + restSize;
		if(restEnd > data.length) {
			throw new FormatError('Listing entry runs past the end of the listing');
		}

		let nameLength = data.readUInt32LE(pos); pos += 4;
		let name = stripNul(readU16String(data, pos, nameLength)); pos += nameLength * 2;

		// The name again with a NUL and some extra units whose purpose is unknown
		let namesLength = data.readUInt32LE(pos); pos += 4;
		pos += namesLength * 2;

		let mtime = readUint64LE(data, pos); pos += 8;

		pos += 4; // Unknown (looks like a hash)

		let size = readUint64LE(data, pos); pos += 8;
		pos += 8; // Size again (always equal so far)

		let metaOffset = readUint64LE(data, pos); pos += 8;

		let kind = data.readUInt32LE(pos); pos += 4;

		if(pos > restEnd) {
			throw new FormatError('Listing entry for ' + path + ' is shorter than expected');
		}

		if(kind !== EntryKind.File && kind !== EntryKind.Folder && kind !== EntryKind.Root) {
			warn('Unknown listing entry kind 0x' + kind.toString(16) + ' for ' + path);
		}

		files.push({
			path,
			name,
			kind,
			mtime: new Date(mtime),
			size,
			metaOffset
		});

		// The remaining fields (meta offset again, a constant id and zero padding) aren't needed
		pos = restEnd;
	}

	if(files.length !== numEntries) {
		throw new FormatError('Listing has ' + files.length + ' entries, expected ' + numEntries);
	}

	return files;
}


function parseIndex(data: Buffer): { kind: number; totalSize: number; handles: RecordHandle[] } {
	if(data.length < 20 || data[0] !== 0x01 || data[1] !== 0x02 || data.readUInt32LE(4) !== 1) {
		throw new FormatError('Bad record index magic: ' + data.subarray(0, 8).toString('hex'));
	}

	let kind = data.readUInt16LE(2);
	if(kind !== INDEX_KIND_BLOCKS && kind !== INDEX_KIND_NO_DATA) {
		warn('Unknown record index kind 0x' + kind.toString(16) + '; reading it like the usual kind');
	}

	let pos = 8;

	// Uncompressed size of the file
	let totalSize = readUint64LE(data, pos); pos += 8;

	let numHandles = data.readUInt32LE(pos); pos += 4;

	if(pos + numHandles * 32 > data.length) {
		throw new FormatError('Record index is shorter than its handle count');
	}

	let handles: RecordHandle[] = [];
	for(let i = 0; i < numHandles; i++) {
		let startOffset = readUint64LE(data, pos); pos += 8;
		let recordOffset = readUint64LE(data, pos); pos += 8;
		let hash = Buffer.from(data.subarray(pos, pos + 16)); pos += 16;

		handles.push({ startOffset, recordOffset, hash });
	}

	// A security descriptor follows the handles (not needed for reading). In the no-data kind, a list of
	// ranges follows it (one range covering the whole file has been seen)

	if(kind === INDEX_KIND_NO_DATA && handles.length > 0) {
		warn('Record index of kind 0x0007 unexpectedly lists ' + handles.length + ' data blocks');
	}

	handles.sort((a, b) => a.startOffset - b.startOffset);

	return { kind, totalSize, handles };
}
