import { FormatError, NotSupportedError } from '../errors';
import { lz4DecompressChain } from './lz4';
import { PAGE_ENVELOPE_SIZE, PAGE_SIZE, PageStore, PageType } from './pages';
import { TreeSuperblock } from './header';


/*
 * Tree pages (LEAF = 0x03, LDIR = 0x04). Body offsets (after the 8-byte page envelope), big-endian:
 *   0x00 "LEAF" / "LDIR", 0x04 version, 0x05 encoding (0 raw, 1 LZ4 chain, bit 0x80 encrypted),
 *   0x06 uint16 cell count, 0x08 uint32 decoded size, 0x0C uint32 stored size, 0x34 cells
 *
 * Cells:
 * - directory pages: [key][uint64 byte offset of the child page] (keys of a fixed size), or
 *   [leb128 key length][leb128 value length][key][value]
 * - leaf pages of fixed-size trees: groups of up to 24 cells behind a 4-byte header (low byte: count;
 *   the other three bytes, in reverse order, a bitmap of which cells are live); deleted cells have no value
 */

const CELL_STREAM_OFFSET = 0x34;

export interface TreeEntry {
	key: Buffer;
	/** null when the entry records a deletion */
	value: Buffer | null;
}

function decodeCellStream(body: Buffer, description: string): { isDirectory: boolean; cellCount: number; cells: Buffer } {
	let magic = body.toString('latin1', 0, 4);
	if(magic !== 'LEAF' && magic !== 'LDIR') {
		throw new FormatError(description + ' is not a tree page');
	}
	let encoding = body[5];
	let cellCount = body.readUInt16BE(6);
	let decodedSize = body.readUInt32BE(8);
	let storedSize = body.readUInt32BE(12);
	if(CELL_STREAM_OFFSET + storedSize > body.length) {
		throw new FormatError(description + ' has more cell data than fits in a page');
	}
	if(encoding & 0x80) {
		throw new NotSupportedError('This .tibx archive is encrypted', 'encrypted');
	}

	let stream = body.subarray(CELL_STREAM_OFFSET, CELL_STREAM_OFFSET + storedSize);
	let cells: Buffer;
	if((encoding & 0x7f) === 0) {
		if(storedSize !== decodedSize) {
			throw new FormatError(description + ': raw cell data has the wrong size');
		}
		cells = Buffer.from(stream);
	}
	else if((encoding & 0x7f) === 1) {
		cells = lz4DecompressChain(stream, decodedSize);
	}
	else {
		throw new NotSupportedError(description + ' uses unknown compression ' + encoding);
	}
	return { isDirectory: magic === 'LDIR', cellCount, cells };
}

function readLeb128(buf: Buffer, at: { position: number }): number {
	let value = 0;
	for(let shift = 0; shift <= 28; shift += 7) {
		if(at.position >= buf.length) {
			throw new FormatError('Tree cell cut off');
		}
		let b = buf[at.position++];
		value += (b & 0x7f) * 2 ** shift;
		if(b < 0x80) {
			return value;
		}
	}
	throw new FormatError('Tree cell length too long');
}

/** Cells with a length prefix each, or of fixed sizes back to back */
export function decodeVariableCells(cells: Buffer, count: number, keyLength: number, valueLength: number): TreeEntry[] {
	let out: TreeEntry[] = [];
	let at = { position: 0 };
	for(let i = 0; i < count; i++) {
		let k = keyLength;
		let v = valueLength;
		if(keyLength === 0) {
			k = readLeb128(cells, at);
			v = readLeb128(cells, at);
		}
		if(at.position + k + v > cells.length) {
			throw new FormatError('Tree cell runs past its page');
		}
		out.push({ key: cells.subarray(at.position, at.position + k), value: cells.subarray(at.position + k, at.position + k + v) });
		at.position += k + v;
	}
	return out;
}

/** Leaf cells of fixed-size trees, in groups with a live-cell bitmap */
export function decodeCompactCells(cells: Buffer, count: number, keyLength: number, valueLength: number): TreeEntry[] {
	let out: TreeEntry[] = [];
	let position = 0;
	while(out.length < count) {
		if(position + 4 > cells.length) {
			throw new FormatError('Tree cell group header cut off');
		}
		let groupCount = cells[position];
		let liveBitmap = cells[position + 3] | (cells[position + 2] << 8) | (cells[position + 1] << 16);
		position += 4;
		if(groupCount === 0 || groupCount > 24) {
			throw new FormatError('Bad tree cell group size ' + groupCount);
		}
		for(let j = 0; j < groupCount && out.length < count; j++) {
			let isLive = (liveBitmap >> j) & 1;
			let end = position + keyLength + (isLive ? valueLength : 0);
			if(end > cells.length) {
				throw new FormatError('Tree cell runs past its page');
			}
			out.push({
				key: cells.subarray(position, position + keyLength),
				value: isLive ? cells.subarray(position + keyLength, end) : null,
			});
			position = end;
		}
	}
	return out;
}

/**
 * Every entry of one on-disk tree, in key order
 */
export async function readTreeFrom(store: PageStore, rootByteOffset: number, superblock: TreeSuperblock): Promise<TreeEntry[]> {
	let out: TreeEntry[] = [];
	let visited = new Set<number>();

	let visit = async (byteOffset: number, depth: number) => {
		if(byteOffset % PAGE_SIZE !== 0 || depth > 16) {
			throw new FormatError('Bad tree page reference ' + byteOffset);
		}
		let pageNumber = byteOffset / PAGE_SIZE;
		if(visited.has(pageNumber)) {
			throw new FormatError('Tree has a loop at page ' + pageNumber);
		}
		visited.add(pageNumber);

		let page = await store.readPage(pageNumber);
		if(page[1] !== PageType.TreeLeaf && page[1] !== PageType.TreeDirectory) {
			throw new FormatError('Page ' + pageNumber + ' should be a tree page but is type ' + page[1]);
		}
		let { isDirectory, cellCount, cells } = decodeCellStream(page.subarray(PAGE_ENVELOPE_SIZE), 'Page ' + pageNumber);

		if(isDirectory) {
			for(let child of decodeVariableCells(cells, cellCount, superblock.keyLength, superblock.keyLength === 0 ? 0 : 8)) {
				await visit(Number(child.value!.readBigUInt64BE(child.value!.length - 8)), depth + 1);
			}
		}
		else if(superblock.keyLength > 0) {
			out.push(...decodeCompactCells(cells, cellCount, superblock.keyLength, superblock.valueLength));
		}
		else {
			out.push(...decodeVariableCells(cells, cellCount, 0, 0));
		}
	};

	await visit(rootByteOffset, 0);
	return out;
}

function decodeMemtree(superblock: TreeSuperblock): TreeEntry[] {
	if(superblock.memtreeEntryCount === 0 || superblock.memtreePayload.length === 0) {
		return [];
	}
	if(superblock.memtreeEncoding & 0x80) {
		throw new NotSupportedError('This .tibx archive is encrypted', 'encrypted');
	}
	let payload = superblock.memtreePayload;
	let cells = (superblock.memtreeEncoding & 0x7f) === 1 ? lz4DecompressChain(payload, payload.readUInt32BE(4)) : payload;
	return superblock.keyLength > 0
		? decodeCompactCells(cells, superblock.memtreeEntryCount, superblock.keyLength, superblock.valueLength)
		: decodeVariableCells(cells, superblock.memtreeEntryCount, 0, 0);
}

/**
 * The live entries of a whole LSM tree: the not-yet-flushed entries in the superblock, then each
 * on-disk tree. For a key found in several, the first one (newest, assumed) wins; deletions remove it.
 * Sorted by key.
 */
export async function readTree(store: PageStore, superblock: TreeSuperblock): Promise<TreeEntry[]> {
	let sources: TreeEntry[][] = [ decodeMemtree(superblock) ];
	for(let root of superblock.treeRoots) {
		sources.push(await readTreeFrom(store, root, superblock));
	}

	let newest = new Map<string, TreeEntry>();
	for(let source of sources) {
		for(let e of source) {
			let id = e.key.toString('hex');
			if(!newest.has(id)) {
				newest.set(id, e);
			}
		}
	}

	return Array.from(newest.values())
		.filter((e) => e.value !== null)
		.sort((a, b) => Buffer.compare(a.key, b.key));
}
