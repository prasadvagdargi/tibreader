/**
 * Builds small synthetic Windows .tib backups that follow the layout in doc/Format-Windows.md.
 *
 * They test the code against our understanding of the format (the real-backup test checks that
 * understanding against True Image's output).
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import adler32 from 'adler-32';


export interface FixtureEntry {
	path: string; /**< e.g. "C:" (drive root), "C:/docs", "C:/docs/a.txt" */
	kind: 'root' | 'folder' | 'file';
	data?: Buffer;
	mtime?: Date;
}

export interface FixtureOptions {
	name?: string;
	creationTime?: Date;
	encryption?: string;
	sectorBySector?: boolean;
	/** Split the slice data into volumes of at most this many bytes (multiple .tib files) */
	volumeSplit?: number;
	/** Bytes of file data per block (True Image uses 256 KiB) */
	blockSize?: number;
	/** Store blocks without their trailing zeros, like True Image does */
	trimZeros?: boolean;
	/** Store a wrong MD5 for the first block of this file */
	corruptHashOf?: string;
	/** Store no data for this file, using the 0x0007 record index kind seen in a real backup */
	noDataFor?: string;
}

const MAGIC = 0xA2B924CE;
const FS_TRAILER = Buffer.from('2C8AE194', 'hex');
const SBS_TRAILER = Buffer.from('2B8AE194', 'hex');
const INDEX_MAGIC = Buffer.from('0102001001000000', 'hex');
const NO_DATA_INDEX_MAGIC = Buffer.from('0102070001000000', 'hex');

const u32 = (v: number) => { let b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
const u64 = (v: number) => { let b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; };
const utf16 = (s: string) => Buffer.from(s, 'utf16le');
const md5 = (b: Buffer) => crypto.createHash('md5').update(b).digest();

function zrec(type: number, data: Buffer) {
	return Buffer.concat([ Buffer.from([ type ]), zlib.deflateSync(data) ]);
}

function rawrec(type: number, data: Buffer) {
	return Buffer.concat([ Buffer.from([ type ]), zlib.deflateRawSync(data), Buffer.alloc(4) ]);
}

/**
 * Writes one slice's data as .tib files: header, data, padding and footer (the footer only on the last
 * file). Returns the file names. 'firstSequence' continues the numbering across slices.
 */
export function writeSliceFiles(dir: string, baseName: string, sliceData: Buffer, split = 0, firstSequence = 1): string[] {
	let size = split > 0 ? split : sliceData.length;
	let parts: Buffer[] = [];
	for(let off = 0; off < sliceData.length; off += size) {
		parts.push(sliceData.subarray(off, off + size));
	}

	let archiveKey = Buffer.from('a1a2a3a4', 'hex');
	let sliceKey = Buffer.from('b1b2b3b4', 'hex');
	let files: string[] = [];
	parts.forEach((part, i) => {
		let h = header(firstSequence + i, archiveKey, sliceKey, Buffer.from([ 0xc0, 0xc1, 0xc2, i ]));
		let body: Buffer[] = [ h, part ];
		if(i === parts.length - 1) {
			let pad = (32 - ((part.length + 48) % 32)) % 32;
			let footer = Buffer.alloc(16);
			footer.writeBigUInt64LE(BigInt(sliceData.length), 8);
			body.push(Buffer.alloc(pad), footer, Buffer.from(h).reverse());
		}
		let file = path.join(dir, baseName + '_v' + (i + 1) + '.tib');
		fs.writeFileSync(file, Buffer.concat(body));
		files.push(file);
	});
	return files;
}

function header(sequence: number, archiveKey: Buffer, sliceKey: Buffer, volumeKey: Buffer) {
	let h = Buffer.alloc(32);
	h.writeUInt32LE(MAGIC, 0);
	h.writeUInt16LE(0x20, 4);
	h.writeUInt16LE(0, 6); // Windows
	archiveKey.copy(h, 8);
	sliceKey.copy(h, 12);
	volumeKey.copy(h, 16);
	h.writeUInt32LE(sequence, 20);
	h.writeUInt32LE(32, 28); // block size
	h.writeUInt32LE(adler32.buf(h) >>> 0, 24);
	return h;
}

function trimTrailingZeros(b: Buffer) {
	let end = b.length;
	while(end > 0 && b[end - 1] === 0) {
		end--;
	}
	return b.subarray(0, end);
}

function configRecord(creationTime: Date, id: Buffer, encryption: string) {
	let head = Buffer.alloc(169);
	head.writeBigUInt64LE(BigInt(creationTime.getTime()), 68);
	id.copy(head, 149);
	head.writeUInt32LE(1, 165);

	let xml = '<metainfo>' +
		'<productinfo name="Acronis True Image"><version major="25" minor="4"/><build number="30480"/></productinfo>' +
		'<task_id id="9EC3EA80-3DDD-4321-99FE-870DCC2D16DE"/>' +
		'<computer_id id="440688B3-8B53-4AE2-805B-E0FB47662523"/>' +
		'<compression value="normal"/>' +
		'<encryption value="' + encryption + '"/>' +
		'</metainfo>';
	let key = 'metainfo';
	let value = '\uFEFF' + xml;

	return Buffer.concat([
		head,
		u32(key.length), utf16(key),
		u32(value.length), utf16(value),
		Buffer.alloc(1)
	]);
}

function listingRecord(entries: Array<FixtureEntry & { metaOffset: number }>) {
	let parts: Buffer[] = [ u32(entries.length) ];

	for(let e of entries) {
		let name = e.kind === 'root' ? e.path : e.path.slice(e.path.lastIndexOf('/') + 1);
		let kind = e.kind === 'root' ? 0x83 : e.kind === 'folder' ? 0x80 : 0;
		let size = e.data ? e.data.length : 0;
		let mtime = e.kind === 'root' ? 0 : (e.mtime || new Date(0)).getTime();

		let names = name + '\0\u0002\0\0\0\0';
		let rest = Buffer.concat([
			u32(name.length), utf16(name),
			u32(names.length), utf16(names),
			u64(mtime),
			u32(0x12345678),
			u64(size), u64(size),
			u64(e.metaOffset),
			u32(kind),
			u64(e.metaOffset),
			u32(1),
			u32(0x03c61934),
			Buffer.alloc(18)
		]);

		let p = e.path + '\0';
		parts.push(u32(p.length), utf16(p), u32(rest.length / 2), rest);
	}

	return Buffer.concat(parts);
}


/**
 * Writes a synthetic backup into 'dir'. Returns the path of its first .tib file.
 */
export function writeWindowsBackup(dir: string, entries: FixtureEntry[], opts: FixtureOptions = {}): string {
	let name = opts.name || 'Test';
	let blockSize = opts.blockSize || 256 * 1024;
	let creationTime = opts.creationTime || new Date('2024-06-22T00:30:07.756Z');

	let chunks: Buffer[] = [];
	let pos = 0;
	let push = (b: Buffer) => { let at = pos; chunks.push(b); pos += b.length; return at; };

	// File data first, like True Image
	let indexes = new Map<string, Buffer>();
	for(let e of entries) {
		if(e.kind !== 'file' || !e.data || e.data.length === 0) {
			continue;
		}

		if(opts.noDataFor === e.path) {
			// Layout seen in the real backup: no handles, the security descriptor, then one range
			indexes.set(e.path, Buffer.concat([
				NO_DATA_INDEX_MAGIC, u64(e.data.length), u32(0), Buffer.alloc(64),
				u32(1), u32(0), u32(e.data.length), Buffer.alloc(8)
			]));
			continue;
		}

		let handles: Buffer[] = [];
		for(let off = 0; off < e.data.length; off += blockSize) {
			let block = e.data.subarray(off, off + blockSize);
			let stored = opts.trimZeros ? trimTrailingZeros(block) : block;
			let recordOffset = push(zrec(109, stored));

			let hash = md5(stored);
			if(opts.corruptHashOf === e.path && off === 0) {
				hash[0] ^= 0xff;
			}

			handles.push(u64(off), u64(recordOffset), hash);
		}
		push(zrec(110, Buffer.alloc(0)));

		indexes.set(e.path, Buffer.concat([
			INDEX_MAGIC, u64(e.data.length), u32(handles.length / 3), ...handles, Buffer.alloc(84)
		]));
	}

	// Metadata records of every entry
	let withMeta = entries.map((e) => {
		let mtime = (e.mtime || new Date(0)).getTime();
		let metaOffset = push(rawrec(102, Buffer.alloc(5)));
		push(rawrec(1, u32(e.kind === 'file' ? 0x20 : 0x10)));

		let index = indexes.get(e.path);
		if(index) {
			push(zrec(108, index));
		}
		else {
			push(rawrec(2, Buffer.alloc(64)));
		}

		push(rawrec(5, Buffer.concat([ u64(mtime), u64(mtime) ])));
		return { ...e, metaOffset };
	});

	// Slice metadata: config, listing, end marker, trailer
	let id = crypto.createHash('md5').update(name).digest();
	let metaDataOffset = push(rawrec(101, configRecord(creationTime, id, opts.encryption || 'none')));
	push(rawrec(103, listingRecord(withMeta)));
	push(Buffer.from([ 104 ]));
	push(Buffer.concat([ u64(metaDataOffset), opts.sectorBySector ? SBS_TRAILER : FS_TRAILER ]));

	let sliceData = Buffer.concat(chunks);

	// Split into volumes
	let split = opts.volumeSplit || sliceData.length;
	let parts: Buffer[] = [];
	for(let off = 0; off < sliceData.length; off += split) {
		parts.push(sliceData.subarray(off, off + split));
	}

	let archiveKey = Buffer.from('a1a2a3a4', 'hex');
	let sliceKey = Buffer.from('b1b2b3b4', 'hex');

	let files: string[] = [];
	parts.forEach((part, i) => {
		let h = header(i + 1, archiveKey, sliceKey, Buffer.from([ 0xc0, 0xc1, 0xc2, i ]));
		let body: Buffer[] = [ h, part ];

		if(i === parts.length - 1) {
			let pad = (32 - ((part.length + 48) % 32)) % 32;
			let footer = Buffer.alloc(16);
			footer.writeBigUInt64LE(BigInt(sliceData.length), 8);
			body.push(Buffer.alloc(pad), footer, Buffer.from(h).reverse());
		}

		let file = path.join(dir, name + '_full_b1_s1_v' + (i + 1) + '.tib');
		fs.writeFileSync(file, Buffer.concat(body));
		files.push(file);
	});

	return files[0];
}


/**
 * A small backup used by several tests
 */
export function standardEntries(): FixtureEntry[] {
	let t = (s: string) => new Date(s);

	// Data with a long zero tail, like the journal file in the real backup
	let sparse = Buffer.alloc(300 * 1024);
	sparse.write('JOURNAL', 0);

	let big = crypto.randomBytes(700 * 1024); // 3 blocks, incompressible

	return [
		{ path: 'C:', kind: 'root' },
		{ path: 'C:/empty.txt', kind: 'file', data: Buffer.alloc(0), mtime: t('2021-01-02T03:04:05Z') },
		{ path: 'C:/hello.txt', kind: 'file', data: Buffer.from('hello world\n'), mtime: t('2022-05-06T07:08:09Z') },
		{ path: 'C:/Docs', kind: 'folder', mtime: t('2023-01-01T00:00:00Z') },
		{ path: 'C:/Docs/Café notes.txt', kind: 'file', data: Buffer.from('accents ok'), mtime: t('2023-02-02T00:00:00Z') },
		{ path: 'C:/Docs/big.bin', kind: 'file', data: big, mtime: t('2023-03-03T00:00:00Z') },
		{ path: 'C:/Docs/sparse.dat', kind: 'file', data: sparse, mtime: t('2023-04-04T00:00:00Z') },
		{ path: 'C:/Docs/Empty folder', kind: 'folder', mtime: t('2023-05-05T00:00:00Z') },
	];
}

export function tempDir(prefix = 'tib-test-'): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
