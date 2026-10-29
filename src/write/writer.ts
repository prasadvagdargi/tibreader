import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import adler32 from 'adler-32';
import { EntryKind, FileAttribute, RecordType } from '../win/record';
import { TIB_MAGIC } from '../detect';


/**
 * One entry to put in a new backup. Parents must come before their children (missing parents are
 * added automatically).
 */
export interface BackupEntry {
	/** Path as True Image stores it: a drive and '/' separators, e.g. "C:/Users/me/notes.txt" */
	backupPath: string;
	type: 'file' | 'directory';
	size: number;
	modified: Date;
	created?: Date;
	/** Windows FILE_ATTRIBUTE_* flags (default: archive for files, directory for folders) */
	attributes?: number;
	/** Reads up to 'length' bytes at 'offset' (files only) */
	read?: (offset: number, length: number) => Promise<Buffer>;
}

export interface WriteProgress {
	files: number;
	bytes: number;
	path: string;
}

export interface WriteBackupOptions {
	/** zlib level 0-9 (default 6, True Image's "normal") */
	compressionLevel?: number;
	/** When the backup was made (default: now) */
	creationTime?: Date;
	signal?: AbortSignal;
	onProgress?: (progress: WriteProgress) => void;
	/** Replace an existing output file (default: refuse) */
	overwrite?: boolean;
}

export interface WriteBackupResult {
	file: string;
	files: number;
	folders: number;
	bytes: number;
}

/** True Image's block size for file data */
const BLOCK_SIZE = 256 * 1024;
const VOLUME_BLOCK = 32;
const FS_TRAILER_MAGIC = Buffer.from('2C8AE194', 'hex');
const INDEX_MAGIC_BLOCKS = Buffer.from('0102001001000000', 'hex');

/**
 * A minimal self-relative security descriptor: Everyone has full control, inherited by children
 */
function everyoneFullControl(): Buffer {
	let everyone = Buffer.from([ 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 ]); // S-1-1-0
	let ace = Buffer.concat([ Buffer.from([ 0x00, 0x03 ]), u16(8 + everyone.length), u32(0x001f01ff), everyone ]);
	let acl = Buffer.concat([ Buffer.from([ 2, 0 ]), u16(8 + ace.length), u16(1), u16(0), ace ]);
	let header = Buffer.concat([ Buffer.from([ 1, 0 ]), u16(0x8004), u32(0), u32(0), u32(0), u32(20) ]);
	return Buffer.concat([ header, acl ]);
}

function u16(v: number) { let b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v: number) { let b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }
function u64(v: number) { let b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function utf16(s: string) { return Buffer.from(s, 'utf16le'); }

/**
 * Splits "C:/Users/me" into its parts and checks it is a path True Image could store
 */
export function checkBackupPath(backupPath: string): string[] {
	let parts = backupPath.split('/');
	if(!/^[A-Za-z]:$/.test(parts[0]) || parts.some((p, i) => i > 0 && (p === '' || p === '.' || p === '..'))) {
		throw new Error('Not a valid backup path (expected "X:/folder/file"): ' + backupPath);
	}
	return parts;
}

/**
 * The file name True Image would use for the first file of a new backup: "NAME_full_b1_s1_v1.tib"
 */
export function backupFileName(output: string): string {
	if(/_(full|inc|diff)_b\d+_s\d+_v\d+\.tib$/i.test(output)) {
		return output;
	}
	return output.replace(/\.tib$/i, '') + '_full_b1_s1_v1.tib';
}

interface WrittenEntry {
	backupPath: string;
	name: string;
	kind: EntryKind;
	size: number;
	modified: Date;
	created: Date;
	attributes: number;
	/** Archive offsets of the blocks (files with data) */
	handles: Buffer[];
	metaOffset: number;
}


/**
 * Writes a new Windows file/folder backup (one .tib file) in the format described in
 * doc/Format-Windows.md. Existing backups are never modified.
 *
 * NOTE: This library reads the result. Whether True Image accepts it is unknown: some fields are
 * written as zeros or guesses (see doc/Format-Windows.md, "Writing").
 */
export async function writeFileBackup(output: string, entries: AsyncIterable<BackupEntry> | Iterable<BackupEntry>, opts: WriteBackupOptions = {}): Promise<WriteBackupResult> {
	let file = backupFileName(output);
	if(!opts.overwrite && fs.existsSync(file)) {
		throw new Error('Not replacing ' + file + ' (it exists)');
	}

	let creationTime = opts.creationTime || new Date();
	let level = opts.compressionLevel ?? 6;
	let tmp = file + '.' + process.pid + '.partial';
	let fh = await fs.promises.open(tmp, 'w');
	let position = 0; // archive offset: bytes written after the header
	let written: WrittenEntry[] = [];
	let byPath = new Map<string, WrittenEntry>();
	let result: WriteBackupResult = { file, files: 0, folders: 0, bytes: 0 };

	let write = async (b: Buffer) => {
		await fh.write(b, 0, b.length, 32 + position);
		let at = position;
		position += b.length;
		return at;
	};

	try {
		// Header: magic, length 0x20, version 0, archive id (8 bytes), volume id (4), sequence 1,
		// Adler-32 of the header, block size 32
		let header = Buffer.alloc(32);
		header.writeUInt32LE(TIB_MAGIC, 0);
		header.writeUInt16LE(0x20, 4);
		header.writeUInt16LE(0, 6);
		crypto.randomBytes(12).copy(header, 8);
		header.writeUInt32LE(1, 20);
		header.writeUInt32LE(VOLUME_BLOCK, 28);
		header.writeUInt32LE(adler32.buf(header) >>> 0, 24);
		await fh.write(header, 0, 32, 0);

		let ensureParents = (parts: string[]) => {
			for(let i = 1; i < parts.length; i++) {
				let p = parts.slice(0, i).join('/');
				if(!byPath.has(p.toLowerCase())) {
					add({ backupPath: p, name: parts[i - 1], kind: i === 1 ? EntryKind.Root : EntryKind.Folder, size: 0, modified: i === 1 ? new Date(0) : creationTime, created: creationTime, attributes: FileAttribute.Directory, handles: [], metaOffset: 0 });
				}
			}
		};
		let add = (e: WrittenEntry) => {
			written.push(e);
			byPath.set(e.backupPath.toLowerCase(), e);
		};

		// File data first, like True Image
		for await (let entry of entries) {
			opts.signal?.throwIfAborted();
			let parts = checkBackupPath(entry.backupPath);
			let existing = byPath.get(entry.backupPath.toLowerCase());
			if(existing) {
				// A folder already added (e.g. a shared parent of two sources) is fine
				if(entry.type === 'directory' && existing.kind !== EntryKind.File) {
					continue;
				}
				throw new Error('Duplicate path in new backup: ' + entry.backupPath);
			}
			ensureParents(parts);

			let isRoot = parts.length === 1;
			let w: WrittenEntry = {
				backupPath: entry.backupPath,
				name: parts[parts.length - 1],
				kind: entry.type === 'file' ? EntryKind.File : isRoot ? EntryKind.Root : EntryKind.Folder,
				size: entry.type === 'file' ? entry.size : 0,
				modified: isRoot ? new Date(0) : entry.modified,
				created: entry.created || entry.modified,
				attributes: entry.attributes ?? (entry.type === 'file' ? FileAttribute.Archive : FileAttribute.Directory),
				handles: [],
				metaOffset: 0,
			};
			if(entry.type === 'file' && isRoot) {
				throw new Error('A drive can\'t be a file: ' + entry.backupPath);
			}

			if(entry.type === 'file' && entry.size > 0) {
				if(!entry.read) {
					throw new Error('No way to read ' + entry.backupPath);
				}
				for(let offset = 0; offset < entry.size; offset += BLOCK_SIZE) {
					opts.signal?.throwIfAborted();
					let block = await entry.read(offset, Math.min(BLOCK_SIZE, entry.size - offset));
					if(block.length !== Math.min(BLOCK_SIZE, entry.size - offset)) {
						throw new Error(entry.backupPath + ' changed size while it was being backed up');
					}

					// Trailing zeros aren't stored; an all-zero block (after the first) isn't stored at all
					let end = block.length;
					while(end > 0 && block[end - 1] === 0) {
						end--;
					}
					if(end === 0 && offset > 0) {
						continue;
					}
					let stored = block.subarray(0, end);
					let recordOffset = await write(Buffer.concat([ Buffer.from([ RecordType.Blob ]), zlib.deflateSync(stored, { level }) ]));
					w.handles.push(Buffer.concat([ u64(offset), u64(recordOffset), crypto.createHash('md5').update(stored).digest() ]));
					result.bytes += block.length;
				}
				await write(Buffer.concat([ Buffer.from([ RecordType.BlobSuffix ]), zlib.deflateSync(Buffer.alloc(0), { level }) ]));
			}

			add(w);
			if(w.kind === EntryKind.File) {
				result.files++;
			}
			else {
				result.folders++;
			}
			opts.onProgress?.({ files: result.files, bytes: result.bytes, path: entry.backupPath });
		}

		// Metadata of every entry: FileMetaStart, Attributes, Security (folders, empty files) or
		// RecordIndex (files with data), Times
		let security = everyoneFullControl();
		for(let e of written) {
			e.metaOffset = await write(rawRecord(RecordType.FileMetaStart, Buffer.alloc(5)));
			await write(rawRecord(RecordType.Attributes, u32(e.attributes)));
			if(e.handles.length > 0) {
				let index = Buffer.concat([ INDEX_MAGIC_BLOCKS, u64(e.size), u32(e.handles.length), ...e.handles, security ]);
				await write(Buffer.concat([ Buffer.from([ RecordType.RecordIndex ]), zlib.deflateSync(index, { level }) ]));
			}
			else {
				await write(rawRecord(RecordType.Security, security));
			}
			await write(rawRecord(RecordType.Times, Buffer.concat([ u64(e.created.getTime()), u64(e.modified.getTime()) ])));
		}

		// Settings (config record), file listing, end marker, trailer
		let metaDataOffset = position;
		let totalSize = written.reduce((s, e) => s + e.size, 0);
		let id = crypto.randomBytes(16);
		await write(rawRecord(RecordType.Config, configRecord(creationTime, metaDataOffset, totalSize, id)));
		await write(rawRecord(RecordType.Listing, listingRecord(written)));
		await write(Buffer.from([ RecordType.EndTrailer ]));
		await write(Buffer.concat([ u64(written.length), u64(metaDataOffset), FS_TRAILER_MAGIC ]));

		// Footer: zero padding to the block size, 8 unknown bytes, the slice size, the header reversed
		let sliceSize = position;
		let padding = (VOLUME_BLOCK - ((32 + sliceSize + 48) % VOLUME_BLOCK)) % VOLUME_BLOCK;
		let footer = Buffer.concat([ Buffer.alloc(padding), Buffer.alloc(8), u64(sliceSize), Buffer.from(header).reverse() ]);
		await fh.write(footer, 0, footer.length, 32 + sliceSize);
		await fh.close();

		await fs.promises.rename(tmp, file);
		return result;
	}
	catch(e) {
		await fh.close().catch(() => {});
		await fs.promises.rm(tmp, { force: true });
		throw e;
	}
}

/**
 * Records stored as raw deflate plus 4 bytes. What the 4 bytes are isn't known (not Adler-32 of the
 * data); this reader ignores them. Written as the CRC-32 of the data, a guess.
 */
function rawRecord(type: number, data: Buffer): Buffer {
	return Buffer.concat([ Buffer.from([ type ]), zlib.deflateRawSync(data), u32(zlib.crc32(data)) ]);
}

function configRecord(creationTime: Date, metaDataOffset: number, totalSize: number, id: Buffer): Buffer {
	let head = Buffer.alloc(169);
	head.writeBigUInt64LE(BigInt(creationTime.getTime()), 68);
	head.writeBigUInt64LE(BigInt(metaDataOffset), 92);
	head.writeBigUInt64LE(BigInt(totalSize), 117);
	head.writeBigUInt64LE(BigInt(metaDataOffset), 133);
	id.copy(head, 149);
	head.writeUInt32LE(1, 165);

	let computerId = crypto.randomUUID().toUpperCase();
	let xml = '<metainfo>' +
		'<productinfo name="tibreader"><version major="0" minor="1"/><build number="0"/></productinfo>' +
		'<task_id id="' + crypto.randomUUID().toUpperCase() + '"/>' +
		'<computer_id id="' + computerId + '"/>' +
		'<compression value="normal"/>' +
		'<encryption value="none"/>' +
		'</metainfo>';
	let key = 'metainfo';
	let value = '\uFEFF' + xml;
	return Buffer.concat([ head, u32(key.length), utf16(key), u32(value.length), utf16(value), Buffer.alloc(1) ]);
}

function listingRecord(entries: WrittenEntry[]): Buffer {
	let parts: Buffer[] = [ u32(entries.length) ];
	for(let e of entries) {
		let names = e.name + '\0\u0002\0\0\0\0';
		let rest = Buffer.concat([
			u32(e.name.length), utf16(e.name),
			u32(names.length), utf16(names),
			u64(e.kind === EntryKind.Root ? 0 : e.modified.getTime()),
			u32(crc32Of(path.posix.dirname(e.backupPath).toLowerCase())),
			u64(e.size), u64(Math.ceil(e.size / 4096) * 4096),
			u64(e.metaOffset),
			u32(e.kind),
			u64(e.metaOffset),
			u32(1),
			u32(0),
			Buffer.alloc(18),
		]);
		let p = e.backupPath + '\0';
		parts.push(u32(p.length), utf16(p), u32(rest.length / 2), rest);
	}
	return Buffer.concat(parts);
}

/** Stand-in for the per-parent hash True Image stores in the listing (its real function is unknown) */
function crc32Of(s: string) {
	return zlib.crc32(Buffer.from(s, 'utf16le'));
}
