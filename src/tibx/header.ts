import { FormatError } from '../errors';
import { PAGE_ENVELOPE_SIZE, PAGE_SIZE, PageFile, PageStore, PageType } from './pages';


/*
 * The archive header (see doc/Format-Tibx.md): ARCH pages near the end of the file (the newest one,
 * by commit sequence, wins), continued on further ARCH pages up to the header size. Offsets below are
 * into the header body, which starts after each page's 8-byte envelope. Integers are big-endian.
 *
 *   0x000  "ARCH"
 *   0x004  uint32 header size
 *   0x008  uint16 header version (8 in True Image 2020-2025)
 *   0x188  uint64 commit sequence
 *   0x210  uint64 first global page of this file (data files of a split archive)
 *   0x400  directory of 19 slots: uint32 length, value, padded to 4 bytes
 */

export const TREE_SLOT = {
	dataMap: 1,
	segmentMap: 2,
	slices: 5,
	metaKeys: 9,
	volumeTable: 18,
} as const;

export interface ArchiveHeader {
	version: number;
	sequence: number;
	firstGlobalPage: number;
	slots: Buffer[];
}

/** Superblock of one LSM tree ("L-SB"), kept in a header slot */
export interface TreeSuperblock {
	keyLength: number;
	valueLength: number;
	/** Root page byte offsets (global) of the frozen on-disk trees, newest first (assumed) */
	treeRoots: number[];
	/** Entries not yet written to an on-disk tree */
	memtreeEncoding: number;
	memtreeEntryCount: number;
	memtreePayload: Buffer;
}

const HEADER_SCAN_PAGES = 64;
const EMPTY_TREE = 0xffffffffffffffffn;

export function parseHeaderBody(body: Buffer): ArchiveHeader {
	if(body.toString('latin1', 0, 4) !== 'ARCH') {
		throw new FormatError('Not a .tibx archive header');
	}
	let size = body.readUInt32BE(4);
	let version = body.readUInt16BE(8);
	if(size < 0x400 || size > 16 * 1024 * 1024) {
		throw new FormatError('Implausible .tibx header size ' + size);
	}
	if(body.length < size) {
		throw new FormatError('.tibx archive header is cut short');
	}

	// Some slots don't exist in older header versions
	let skipped = version < 7 ? new Set([ 8, 12, 13, 14, 15, 16 ]) : version < 8 ? new Set([ 12, 13, 14, 15, 16 ]) : new Set<number>();
	let slots: Buffer[] = [];
	let position = 0x400;
	for(let i = 0; i < 19; i++) {
		if(skipped.has(i) || position + 4 > size) {
			slots.push(Buffer.alloc(0));
			continue;
		}
		let length = body.readUInt32BE(position);
		if(position + 4 + length > size) {
			throw new FormatError('.tibx header slot ' + i + ' runs past the header');
		}
		slots.push(Buffer.from(body.subarray(position + 4, position + 4 + length)));
		position += (length + 7) & ~3;
	}

	let firstGlobalPage = body.length >= 0x218 ? Number(body.readBigUInt64BE(0x210)) : 0;
	return {
		version,
		sequence: Number(body.readBigUInt64BE(0x188)),
		firstGlobalPage: Number.isSafeInteger(firstGlobalPage) ? firstGlobalPage : 0,
		slots,
	};
}

/**
 * Finds the newest archive header in the last pages of one file
 */
export async function readNewestHeader(file: PageFile): Promise<{ header: ArchiveHeader; localPage: number } | null> {
	let best: { body: Buffer; localPage: number; sequence: number } | null = null;
	for(let p = file.pageCount - 1; p >= 0 && p >= file.pageCount - HEADER_SCAN_PAGES; p--) {
		let page: Buffer;
		try {
			page = await PageStore.readLocalPage(file, p);
		}
		catch(e) {
			continue;
		}
		let body = page.subarray(PAGE_ENVELOPE_SIZE);
		if(page[1] !== PageType.ArchiveHeader || body.toString('latin1', 0, 4) !== 'ARCH') {
			continue;
		}
		let sequence = Number(body.readBigUInt64BE(0x188));
		if(!best || sequence > best.sequence) {
			best = { body: Buffer.from(body), localPage: p, sequence };
		}
	}

	// The archive file of a single-file archive also starts with one; use it if the tail has none
	if(!best) {
		let first = await PageStore.readLocalPage(file, 0).catch(() => null);
		if(first && first[1] === PageType.ArchiveHeader && first.toString('latin1', 8, 12) === 'ARCH') {
			best = { body: Buffer.from(first.subarray(PAGE_ENVELOPE_SIZE)), localPage: 0, sequence: 0 };
		}
	}
	if(!best) {
		return null;
	}

	// Continuation pages (also ARCH pages, without the magic) until the header size is reached
	let size = best.body.readUInt32BE(4);
	let parts = [ best.body ];
	let total = best.body.length;
	for(let p = best.localPage + 1; total < size && p < file.pageCount; p++) {
		let page = await PageStore.readLocalPage(file, p);
		if(page[1] !== PageType.ArchiveHeader) {
			break;
		}
		parts.push(page.subarray(PAGE_ENVELOPE_SIZE));
		total += PAGE_SIZE - PAGE_ENVELOPE_SIZE;
	}
	return { header: parseHeaderBody(Buffer.concat(parts)), localPage: best.localPage };
}

export function parseSuperblock(slot: Buffer, slotIndex: number): TreeSuperblock | null {
	if(slot.length === 0) {
		return null;
	}
	if(slot.length < 0x178 || slot.toString('latin1', 0, 4) !== 'L-SB') {
		throw new FormatError('.tibx header slot ' + slotIndex + ' is not a tree superblock');
	}
	let treeCount = slot[5] + 2;
	let treeRoots: number[] = [];
	for(let i = 0; i < treeCount && 0x18 + (i + 1) * 32 <= 0x158; i++) {
		let at = 0x18 + i * 32;
		let root = slot.readBigUInt64BE(at);
		let bytes = slot.readBigUInt64BE(at + 8);
		let items = slot.readUInt32BE(at + 16);
		if(root === EMPTY_TREE || (root === 0n && bytes === 0n && items === 0)) {
			continue;
		}
		treeRoots.push(Number(root));
	}
	let extraLength = slot.readUInt32BE(0x15c);
	return {
		keyLength: slot.readUInt32BE(0x10),
		valueLength: slot.readUInt32BE(0x14),
		treeRoots,
		memtreeEncoding: slot[0x158],
		memtreeEntryCount: slot.readUInt16BE(0x15a),
		memtreePayload: slot.subarray(0x178, Math.min(slot.length, 0x178 + extraLength)),
	};
}

/**
 * Header slot 9: NUL-separated strings in fixed positions (0 type, 3 disk GUID, 4 host name,
 * 5 product and version, 10 installation GUID; others unknown)
 */
export function parseMetaKeys(slot: Buffer): { type?: string; diskGuid?: string; hostName?: string; product?: string; installGuid?: string } {
	let values = slot.toString('utf8').split('\0');
	let at = (i: number) => (values[i] ? values[i] : undefined);
	return { type: at(0), diskGuid: at(3), hostName: at(4), product: at(5), installGuid: at(10) };
}

/** Header slot 18: 12-byte records { uint32 index, uint64 byte offset on the source disk } */
export function parseVolumeTable(slot: Buffer): Array<{ index: number; diskOffset: number }> {
	let out: Array<{ index: number; diskOffset: number }> = [];
	for(let at = 0; at + 12 <= slot.length; at += 12) {
		out.push({ index: slot.readUInt32BE(at), diskOffset: Number(slot.readBigUInt64BE(at + 4)) });
	}
	return out;
}
