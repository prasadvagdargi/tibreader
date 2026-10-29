/**
 * Builds synthetic .tibx archives following doc/Format-Tibx.md (from acronis-tib-reader's notes on real
 * files): 4 KiB pages with CRC-32C, an archive header with tree superblocks, LSM trees (directory and
 * leaf pages, raw or LZ4), Zstandard segments, backup points (full and incremental), split files.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { sealPage } from '../../src/tibx/pages';
import { lz4CompressBlock } from './compressors';


const PAGE = 4096;
const BODY = PAGE - 8;
const CELL_AREA = BODY - 0x34;

export interface TibxPointSpec {
	/** Stream id -> the stream's bytes (a disk or volume image) at this backup point */
	volumes: { [volumeId: number]: Buffer };
}

export interface TibxFixtureOptions {
	name?: string;
	/** Bytes per extent (and segment); default 64 KiB */
	extentSize?: number;
	/** Split into data files ("NAME-0001.tibx", ...) of about this many pages, plus a small NAME.tibx */
	splitPages?: number;
	/** Use LZ4 for tree pages (default true) */
	lz4Pages?: boolean;
	/** Mark segments as encrypted without any key records (can't be opened) */
	encrypted?: boolean;
	/** Encrypt segments for this password, with key records in header slot 7 */
	password?: string;
	/** 1-3 AES-128/192/256-CBC, 5-7 AES-128/192/256-GCM (default 3) */
	encryptionAlgorithm?: number;
	/** Corrupt one byte of this data segment's first page */
	corruptSegment?: number;
	hostName?: string;
	product?: string;
	/** Put two extents in one segment (index 0 and 1) for the first two extents of the first stream */
	shareFirstSegment?: boolean;
	/** Add metadata streams that should stay hidden (small, no boot sector) */
	metadataStream?: boolean;
}

function u32be(v: number) { let b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function u64be(v: number | bigint) { let b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v), 0); return b; }

function page(type: number, body: Buffer): Buffer {
	if(body.length > BODY) {
		throw new Error('page body too big: ' + body.length);
	}
	let p = Buffer.alloc(PAGE);
	p[0] = 0x41;
	p[1] = type;
	body.copy(p, 8);
	return sealPage(p);
}

interface TreeSpec { keyLength: number; valueLength: number; entries: Array<{ key: Buffer; value: Buffer | null }> }

const HEADER_RESERVE = 4;

/**
 * The global page space being built. For split archives, each data file ends with reserved pages for its
 * own copy of the header; they are part of the global space, so they're reserved as pages are added.
 */
class PageWriter {
	pages: Array<Buffer | null> = [];
	fileStarts = [ 0 ];

	constructor(private _pagesPerFile = 0) {}

	private contentInCurrentFile() {
		return this.pages.length - this.fileStarts[this.fileStarts.length - 1];
	}

	/** Starts a new file if 'count' pages wouldn't fit in the current one (segments must not be split) */
	ensureRoom(count: number) {
		if(this._pagesPerFile && this.contentInCurrentFile() > 0 && this.contentInCurrentFile() + count > this._pagesPerFile) {
			this.closeFile();
		}
	}

	closeFile() {
		for(let i = 0; i < HEADER_RESERVE; i++) {
			this.pages.push(null);
		}
		this.fileStarts.push(this.pages.length);
	}

	add(p: Buffer) {
		this.ensureRoom(1);
		this.pages.push(p);
		return this.pages.length - 1;
	}
}

function compactCells(entries: Array<{ key: Buffer; value: Buffer | null }>): Buffer {
	let parts: Buffer[] = [];
	for(let g = 0; g < entries.length; g += 24) {
		let group = entries.slice(g, g + 24);
		let bitmap = 0;
		group.forEach((e, j) => { if(e.value) { bitmap |= 1 << j; } });
		parts.push(Buffer.from([ group.length, (bitmap >> 16) & 0xff, (bitmap >> 8) & 0xff, bitmap & 0xff ]));
		for(let e of group) {
			parts.push(e.key);
			if(e.value) {
				parts.push(e.value);
			}
		}
	}
	return Buffer.concat(parts);
}

function treePage(magic: 'LEAF' | 'LDIR', cellCount: number, cells: Buffer, lz4: boolean): Buffer {
	let stored = cells;
	let encoding = 0;
	if(lz4 && cells.length > 64) {
		// Two chained blocks, the second referring back into the first
		let half = Math.floor(cells.length / 2);
		let b1 = lz4CompressBlock(cells.subarray(0, half));
		let b2 = lz4CompressBlock(cells.subarray(half), cells.subarray(0, half));
		let chained = Buffer.concat([ u32be(b1.length), u32be(half), b1, u32be(b2.length), u32be(cells.length - half), b2 ]);
		if(chained.length <= CELL_AREA) {
			stored = chained;
			encoding = 1;
		}
	}
	if(stored.length > CELL_AREA) {
		throw new Error('tree page too full');
	}
	let body = Buffer.alloc(0x34 + stored.length);
	body.write(magic, 0, 'latin1');
	body[4] = 1;
	body[5] = encoding;
	body.writeUInt16BE(cellCount, 6);
	body.writeUInt32BE(cells.length, 8);
	body.writeUInt32BE(stored.length, 12);
	stored.copy(body, 0x34);
	return page(magic === 'LEAF' ? 0x03 : 0x04, body);
}

/** Writes a tree's pages; returns the root's byte offset */
function writeTree(w: PageWriter, tree: TreeSpec, lz4: boolean): number {
	let entries = tree.entries.slice().sort((a, b) => Buffer.compare(a.key, b.key));
	let perEntry = tree.keyLength + tree.valueLength;
	// Leaves sized so even raw cells fit
	let perLeaf = Math.max(1, Math.floor((CELL_AREA - 4 * Math.ceil(CELL_AREA / (perEntry * 24 + 4))) / perEntry));
	perLeaf = Math.min(perLeaf, 200);
	let level: Array<{ firstKey: Buffer; offset: number }> = [];
	for(let i = 0; i < entries.length; i += perLeaf) {
		let chunk = entries.slice(i, i + perLeaf);
		let at = w.add(treePage('LEAF', chunk.length, compactCells(chunk), lz4 && level.length % 2 === 0));
		level.push({ firstKey: chunk[0].key, offset: at * PAGE });
	}
	while(level.length > 1) {
		let perDir = Math.floor(CELL_AREA / (tree.keyLength + 8));
		let next: typeof level = [];
		for(let i = 0; i < level.length; i += perDir) {
			let chunk = level.slice(i, i + perDir);
			let cells = Buffer.concat(chunk.flatMap((c) => [ c.firstKey, u64be(c.offset) ]));
			let at = w.add(treePage('LDIR', chunk.length, cells, lz4));
			next.push({ firstKey: chunk[0].firstKey, offset: at * PAGE });
		}
		level = next;
	}
	return level.length ? level[0].offset : -1;
}

function superblock(tree: TreeSpec, roots: number[], memtree?: Array<{ key: Buffer; value: Buffer | null }>): Buffer {
	let sb = Buffer.alloc(0x178);
	sb.write('L-SB', 0, 'latin1');
	sb[4] = 1;
	sb[6] = 8;
	sb.writeUInt32BE(1, 8);
	sb.writeUInt32BE(tree.keyLength, 0x10);
	sb.writeUInt32BE(tree.valueLength, 0x14);
	let slots = [ ...roots.map((r) => ({ root: BigInt(r), bytes: 4096n, items: 1 })), { root: 0xffffffffffffffffn, bytes: 0n, items: 0 } ];
	slots.forEach((s, i) => {
		let at = 0x18 + i * 32;
		sb.writeBigUInt64BE(s.root, at);
		sb.writeBigUInt64BE(s.bytes, at + 8);
		sb.writeUInt32BE(s.items, at + 16);
	});
	sb[5] = Math.max(0, slots.length - 2);
	let extra = Buffer.alloc(0);
	if(memtree && memtree.length) {
		let cells = compactCells(memtree.slice().sort((a, b) => Buffer.compare(a.key, b.key)));
		let block = lz4CompressBlock(cells);
		extra = Buffer.concat([ u32be(block.length), u32be(cells.length), block ]);
		sb[0x158] = 1;
		sb.writeUInt16BE(memtree.length, 0x15a);
		sb.writeUInt32BE(extra.length, 0x15c);
	}
	return Buffer.concat([ sb, extra ]);
}

/**
 * Header slot 7: the key records. One password user, "[0x01]user" -> format 1, algorithm, PBKDF2
 * iterations log2 (10 here, to keep tests fast), 0, salt, AES-256-CBC(KEK, zero IV)(data key).
 * Raw (uncompressed) mem-tree with length-prefixed cells, as for variable-size trees.
 */
function keymapSuperblock(password: string, algorithm: number, dataKey: Buffer): Buffer {
	let salt = crypto.randomBytes(16);
	let kek = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1 << 10, 32, 'sha256');
	let c = crypto.createCipheriv('aes-256-cbc', kek, Buffer.alloc(16));
	let wrapped = Buffer.concat([ c.update(dataKey), c.final() ]);
	let value = Buffer.concat([ Buffer.from([ 0x01, algorithm, 10, 0 ]), salt, wrapped ]);
	let key = Buffer.concat([ Buffer.from([ 0x01 ]), Buffer.from('user') ]);
	// A certificate user too, which a password can't open
	let certKey = Buffer.concat([ Buffer.from([ 0x02 ]), Buffer.alloc(32, 7), u32be(1) ]);
	let certValue = Buffer.concat([ Buffer.from([ 0x02, algorithm, 0, 0 ]), Buffer.alloc(256, 9) ]);
	let cell = (k: Buffer, v: Buffer) => Buffer.concat([ Buffer.from([ k.length ]), leb128(v.length), k, v ]);
	let cells = Buffer.concat([ cell(key, value), cell(certKey, certValue) ]);

	let sb = Buffer.alloc(0x178);
	sb.write('L-SB', 0, 'latin1');
	sb[4] = 1;
	sb[5] = 0;
	sb.writeBigUInt64BE(0xffffffffffffffffn, 0x18);
	sb[0x158] = 0;
	sb.writeUInt16BE(2, 0x15a);
	sb.writeUInt32BE(cells.length, 0x15c);
	return Buffer.concat([ sb, cells ]);
}

function leb128(n: number): Buffer {
	let out: number[] = [];
	do {
		let b = n & 0x7f;
		n >>>= 7;
		out.push(n ? b | 0x80 : b);
	} while(n);
	return Buffer.from(out);
}

function headerBody(slots: Buffer[], sequence: number, firstGlobalPage: number): Buffer {
	let dir = Buffer.concat(slots.map((s) => {
		let padded = Buffer.alloc(4 + ((s.length + 3) & ~3));
		padded.writeUInt32BE(s.length, 0);
		s.copy(padded, 4);
		return padded;
	}));
	let body = Buffer.alloc(0x400 + dir.length);
	body.write('ARCH', 0, 'latin1');
	body.writeUInt32BE(body.length, 4);
	body.writeUInt16BE(8, 8);
	body.writeBigUInt64BE(BigInt(sequence), 0x188);
	body.writeBigUInt64BE(BigInt(firstGlobalPage), 0x210);
	dir.copy(body, 0x400);
	return body;
}

function headerPages(body: Buffer): Buffer[] {
	let out: Buffer[] = [];
	for(let at = 0; at < body.length; at += BODY) {
		out.push(page(0x01, body.subarray(at, at + BODY)));
	}
	return out;
}

/**
 * Writes a .tibx archive to 'dir'; returns the path of NAME.tibx. points[0] is the full backup, later
 * points are incremental and store only extents that changed.
 */
export function writeTibx(dir: string, points: TibxPointSpec[], opts: TibxFixtureOptions = {}): string {
	let name = opts.name || 'Disk';
	let extentSize = opts.extentSize || 64 * 1024;
	let w = new PageWriter(opts.splitPages || 0);
	// Page 0: an old header copy (single file), so the file is recognized; the reader must use the
	// newest one at the end. Split archives: a filler data page.
	w.add(page(0xff, Buffer.alloc(16)));

	let dataMap: TreeSpec = { keyLength: 31, valueLength: 10, entries: [] };
	let segmentMap: TreeSpec = { keyLength: 8, valueLength: 32, entries: [] };
	let slices: Array<{ key: Buffer; value: Buffer | null }> = [];
	let nextSegment = 4;
	let nextExtent = 1;
	let sliceUuids: Buffer[] = [];

	let algorithm = opts.encryptionAlgorithm || 3;
	let algorithmNames: { [id: number]: [ string, number ] } = {
		1: [ 'aes-128-cbc', 16 ], 2: [ 'aes-192-cbc', 24 ], 3: [ 'aes-256-cbc', 32 ],
		5: [ 'aes-128-gcm', 16 ], 6: [ 'aes-192-gcm', 24 ], 7: [ 'aes-256-gcm', 32 ],
	};
	let dataKey = crypto.randomBytes(algorithmNames[algorithm][1]);
	let encrypt = (plain: Buffer): Buffer => {
		let [ cipherName ] = algorithmNames[algorithm];
		let iv = crypto.randomBytes(16);
		if(cipherName.endsWith('gcm')) {
			let c = crypto.createCipheriv(cipherName as crypto.CipherGCMTypes, dataKey, iv);
			let ct = Buffer.concat([ c.update(plain), c.final() ]);
			return Buffer.concat([ iv, c.getAuthTag(), ct ]);
		}
		let c = crypto.createCipheriv(cipherName, dataKey, iv);
		return Buffer.concat([ iv, c.update(plain), c.final() ]);
	};

	let writeSegment = (data: Buffer, sliceId: number): number => {
		let id = nextSegment++;
		let compressed = zlib.zstdCompressSync(data);
		let isCompressed = compressed.length < data.length;
		let stored = isCompressed ? compressed : data;
		if(opts.password !== undefined) {
			stored = encrypt(stored);
		}
		w.ensureRoom(1 + Math.ceil(Math.max(0, stored.length - (PAGE - 0x2c)) / BODY));
		let first = Buffer.alloc(BODY);
		first.write(opts.password !== undefined ? 'SE\x00\x00' : 'SG\x00\x01', 0, 'latin1');
		first.writeUInt32BE(data.length, 4);
		first.writeUInt32BE(stored.length, 8);
		first.writeUInt32BE(opts.encrypted || opts.password !== undefined ? 1 : 0, 12);
		first.writeUInt16BE(isCompressed ? 0x0301 : 0, 16);
		let firstTake = Math.min(stored.length, PAGE - 0x2c);
		stored.copy(first, 0x2c - 8, 0, firstTake);
		let firstPage = w.add(page(0xff, first));
		if(opts.corruptSegment === id) {
			w.pages[firstPage]![100] ^= 0xff;
		}
		for(let at = firstTake; at < stored.length; at += BODY) {
			w.add(page(0xff, stored.subarray(at, at + BODY)));
		}
		let value = Buffer.alloc(32);
		value.writeUInt32LE(w.pages.length - firstPage, 0);
		value.writeUInt32BE(firstPage, 4);
		value.writeUInt32BE(sliceId, 8);
		segmentMap.entries.push({ key: u64be(id), value });
		return id;
	};

	let addExtent = (volumeId: number, offset: number, length: number, segmentId: number, index = 0xffff) => {
		let key = Buffer.alloc(31);
		key.writeBigUInt64BE(BigInt(volumeId), 0);
		key.writeBigUInt64BE(BigInt(offset), 8);
		key.writeUIntBE(length, 16, 3);
		key.writeUInt32BE(2, 19);
		key.writeBigUInt64BE(BigInt(nextExtent++), 23);
		let value = Buffer.alloc(10);
		value.writeBigUInt64BE(BigInt(segmentId), 0);
		value.writeUInt16BE(index, 8);
		dataMap.entries.push({ key, value });
	};

	points.forEach((point, pi) => {
		let sliceId = pi + 1;
		let previous = pi > 0 ? points[pi - 1] : null;
		let volumes = { ...point.volumes };
		if(opts.metadataStream && pi === 0) {
			volumes[2] = Buffer.from('True Image keeps its own small metadata streams in the archive'.repeat(20));
		}

		for(let [ idText, data ] of Object.entries(volumes)) {
			let volumeId = Number(idText);
			let shared = opts.shareFirstSegment && pi === 0 && volumeId === Number(Object.keys(volumes)[0]);
			for(let off = 0; off < data.length; off += extentSize) {
				let chunk = data.subarray(off, Math.min(off + extentSize, data.length));
				let old = previous && previous.volumes[volumeId] ? previous.volumes[volumeId].subarray(off, off + chunk.length) : null;
				if(old && old.equals(chunk)) {
					continue;
				}
				if(!old && chunk.every((b) => b === 0)) {
					continue; // never stored: reads as zeros
				}
				if(shared && off === 0 && data.length >= 2 * extentSize) {
					let second = data.subarray(extentSize, 2 * extentSize);
					let segment = writeSegment(Buffer.concat([ chunk, second ]), sliceId);
					addExtent(volumeId, 0, chunk.length, segment, 0);
					addExtent(volumeId, extentSize, second.length, segment, 1);
					off += extentSize;
					continue;
				}
				addExtent(volumeId, off, chunk.length, writeSegment(chunk, sliceId));
			}
		}

		let uuid = Buffer.alloc(16, 0x10 + sliceId);
		sliceUuids.push(uuid);
		let record = Buffer.alloc(132);
		uuid.copy(record, 0);
		record.writeBigUInt64BE(BigInt(Date.UTC(2025, 0, 1 + pi, 12, 0, 0)), 0x10);
		record.writeBigUInt64BE(BigInt(Date.UTC(2025, 0, 1 + pi, 12, 30, 0)), 0x18);
		if(pi > 0) {
			sliceUuids[pi - 1].copy(record, 0x20);
			record[0x44] = 0x01;
		}
		slices.push({ key: u32be(sliceId), value: record });
	});
	// A deleted backup point (a tombstone) must not show up
	slices.push({ key: u32be(999), value: null });

	let lz4 = opts.lz4Pages !== false;
	let dataRoot = writeTree(w, dataMap, lz4);
	let segmentRoot = writeTree(w, segmentMap, lz4);

	let meta = Buffer.from([ 'disk', '', '', 'DISK-GUID', opts.hostName || 'TEST-PC', opts.product || 'ACPHO 27.3.1.40173 Win', '', '', '', '', 'INSTALL-GUID' ].join('\0') + '\0');
	let slots = (firstGlobalPage: number, sequence: number) => {
		let s: Buffer[] = Array.from({ length: 19 }, () => Buffer.alloc(0));
		s[1] = superblock(dataMap, [ dataRoot ]);
		s[2] = superblock(segmentMap, [ segmentRoot ]);
		s[5] = superblock({ keyLength: 4, valueLength: 132, entries: [] }, [], slices);
		if(opts.password !== undefined) {
			s[7] = keymapSuperblock(opts.password, algorithm, dataKey);
		}
		s[9] = meta;
		s[18] = Buffer.concat([ u32be(0), u64be(0) ]);
		return headerBody(s, sequence, firstGlobalPage);
	};

	let files = new Map<string, Buffer>();
	if(!opts.splitPages) {
		// An old, incomplete header copy at page 0 (lower sequence)
		w.pages[0] = page(0x01, headerBody(Array.from({ length: 19 }, () => Buffer.alloc(0)), 1, 0));
		for(let p of headerPages(slots(0, 7))) {
			w.add(p);
		}
		files.set(name + '.tibx', Buffer.concat(w.pages as Buffer[]));
	}
	else {
		w.closeFile();
		for(let k = 0; k + 1 < w.fileStarts.length; k++) {
			let start = w.fileStarts[k];
			let end = w.fileStarts[k + 1];
			let headers = headerPages(slots(start, 10 + k));
			if(headers.length > HEADER_RESERVE) {
				throw new Error('header needs more reserved pages');
			}
			// Unused reserved pages become filler data pages before the header
			let reserved = end - HEADER_RESERVE;
			let filler = Array.from({ length: HEADER_RESERVE - headers.length }, () => page(0xff, Buffer.alloc(16)));
			[ ...filler, ...headers ].forEach((p, i) => { w.pages[reserved + i] = p; });
			files.set(name + '-' + String(k + 1).padStart(4, '0') + '.tibx', Buffer.concat(w.pages.slice(start, end) as Buffer[]));
		}
		// The small archive file: just a header (older than the data files' headers)
		files.set(name + '.tibx', Buffer.concat(headerPages(slots(0, 2))));
	}

	for(let [ f, buf ] of files) {
		fs.writeFileSync(path.join(dir, f), buf);
	}
	return path.join(dir, name + '.tibx');
}
