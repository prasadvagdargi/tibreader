import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Archive, { ArchiveFile, ArchiveFormat } from '../archive';
import Slice, { SliceConfig, SliceKind } from '../slice';
import { SnapshotFS } from '../fs/types';
import { DiskImage } from '../disk/image';
import { DiskFS } from '../disk/fs';
import { FormatError, NotSupportedError } from '../errors';
import { warn } from '../log';
import { createBlockCache, LRUCache } from '../cache';
import { PAGE_ENVELOPE_SIZE, PAGE_SIZE, PageFile, PageStore, PageType } from './pages';
import { ArchiveHeader, parseMetaKeys, parseSuperblock, readNewestHeader, TREE_SLOT } from './header';
import { readTree } from './lsm';
import { algorithmName, DataKey, decryptSegment, KEYMAP_SLOT, unwrapPasswordKey } from './encryption';
import { OpenOptions } from '../archive';


/** Where a segment is: from the segment_map tree */
interface SegmentLocation {
	firstPage: number;
	sliceId: number;
}

/** One stored piece of a volume: from the data_map tree */
interface Extent {
	volumeId: number;
	offset: number;
	length: number;
	extentId: number;
	segmentId: number;
	/** 0xFFFF: the extent is the whole segment; otherwise its position among the segment's extents */
	indexInSegment: number;
}

/** A non-overlapping piece of a volume as one backup point sees it */
interface Piece {
	start: number;
	end: number;
	segmentId: number;
	/** Where 'start' is in the segment's decompressed data */
	segmentOffset: number;
}

interface BackupPointRecord {
	sliceId: number;
	uuid: Buffer;
	parentUuid: Buffer;
	started: Date;
	type: 'full' | 'incremental' | 'differential' | 'edited';
}

const WHOLE_SEGMENT = 0xffff;
const SG_MAGIC = Buffer.from('SG\x00\x01', 'latin1');
const SE_MAGIC = Buffer.from('SE\x00\x00', 'latin1');
const SG_PAYLOAD_OFFSET = 0x2c;
const MIN_SHOWN_STREAM_SIZE = 1024 * 1024;


/**
 * Decompresses one segment: "SG\0\1" at +8 of its first data page, then (big-endian) decompressed size,
 * stored size, key id (0 = not encrypted), compression; the stored bytes start at +0x2C and continue
 * on the following data pages after their 8-byte envelopes.
 */
async function readSegment(store: PageStore, firstPage: number, segmentId: number, dataKey: DataKey | null): Promise<Buffer> {
	let page = await store.readPage(firstPage);
	let magic = page.subarray(8, 12);
	let isEncrypted = magic.equals(SE_MAGIC);
	if(page[1] !== PageType.Data || !(magic.equals(SG_MAGIC) || isEncrypted)) {
		throw new FormatError('Segment ' + segmentId + ' is missing at page ' + firstPage);
	}
	let decompressedSize = page.readUInt32BE(12);
	let storedSize = page.readUInt32BE(16);
	let keyId = page.readUInt32BE(20);
	let compression = page.readUInt16BE(24);

	if((isEncrypted || keyId !== 0) && !dataKey) {
		throw new NotSupportedError('This .tibx backup is encrypted; open it with its password (experimental)', 'encrypted');
	}
	if(storedSize > 64 * 1024 * 1024 || decompressedSize > 64 * 1024 * 1024) {
		throw new FormatError('Segment ' + segmentId + ' is implausibly large');
	}

	let parts = [ page.subarray(SG_PAYLOAD_OFFSET, SG_PAYLOAD_OFFSET + Math.min(storedSize, PAGE_SIZE - SG_PAYLOAD_OFFSET)) ];
	let collected = parts[0].length;
	for(let p = firstPage + 1; collected < storedSize; p++) {
		let next = await store.readPage(p);
		if(next[1] !== PageType.Data || next.subarray(8, 12).equals(SG_MAGIC) || next.subarray(8, 12).equals(SE_MAGIC)) {
			throw new FormatError('Segment ' + segmentId + ' is cut short at page ' + p);
		}
		let take = Math.min(PAGE_SIZE - PAGE_ENVELOPE_SIZE, storedSize - collected);
		parts.push(next.subarray(PAGE_ENVELOPE_SIZE, PAGE_ENVELOPE_SIZE + take));
		collected += take;
	}
	let stored: Buffer = Buffer.concat(parts);
	if(isEncrypted || keyId !== 0) {
		stored = decryptSegment(stored, dataKey!);
	}

	let data: Buffer;
	if(compression === 0) {
		data = stored;
	}
	else if((compression >> 8) === 0x03) {
		if(typeof (zlib as any).zstdDecompressSync !== 'function') {
			throw new NotSupportedError('Reading .tibx backups needs Node.js 22.15 or newer (for Zstandard)');
		}
		try {
			data = (zlib as any).zstdDecompressSync(stored, { maxOutputLength: Math.max(decompressedSize, 1) });
		}
		catch(e: any) {
			throw new FormatError('Segment ' + segmentId + ' is damaged: ' + e.message);
		}
	}
	else {
		throw new NotSupportedError('Segment ' + segmentId + ' uses unknown compression 0x' + compression.toString(16));
	}

	if(data.length !== decompressedSize) {
		throw new FormatError('Segment ' + segmentId + ' has ' + data.length + ' bytes, expected ' + decompressedSize);
	}
	return data;
}


/**
 * Merges the extents of one volume for a backup point. 'levels' go from oldest to newest backup point;
 * a newer level hides what it overlaps in older ones (an assumption: no real incremental .tibx seen).
 */
function piecesFor(levels: Extent[][], segmentOffsets: Map<string, number>): Piece[] {
	let toPiece = (e: Extent): Piece => ({
		start: e.offset, end: e.offset + e.length, segmentId: e.segmentId,
		segmentOffset: segmentOffsets.get(e.segmentId + ':' + e.indexInSegment) ?? 0,
	});

	let result: Piece[] = [];
	for(let level of levels) {
		let sorted = level.slice().sort((a, b) => a.offset - b.offset);
		let hasOverlap = sorted.some((e, i) => i > 0 && e.offset < sorted[i - 1].offset + sorted[i - 1].length);
		if(!hasOverlap) {
			result = overlay(result, sorted.map(toPiece));
			continue;
		}
		// Rare: extents of one backup point overlap; a later extent id wins
		warn('Overlapping extents in one .tibx backup point; the later ones are used');
		for(let e of level.slice().sort((a, b) => a.extentId - b.extentId)) {
			result = overlay(result, [ toPiece(e) ]);
		}
	}
	return result;
}

/**
 * Puts sorted, non-overlapping 'newer' pieces over sorted, non-overlapping 'older' ones: older pieces
 * survive only where no newer piece is
 */
function overlay(older: Piece[], newer: Piece[]): Piece[] {
	let survivors: Piece[] = [];
	let firstCandidate = 0;
	for(let old of older) {
		while(firstCandidate < newer.length && newer[firstCandidate].end <= old.start) {
			firstCandidate++;
		}
		let cursor = old.start;
		for(let k = firstCandidate; k < newer.length && newer[k].start < old.end && cursor < old.end; k++) {
			if(newer[k].start > cursor) {
				survivors.push({ ...old, start: cursor, end: newer[k].start, segmentOffset: old.segmentOffset + (cursor - old.start) });
			}
			cursor = Math.max(cursor, newer[k].end);
		}
		if(cursor < old.end) {
			survivors.push({ ...old, start: cursor, segmentOffset: old.segmentOffset + (cursor - old.start) });
		}
	}
	return survivors.concat(newer).sort((a, b) => a.start - b.start);
}


/**
 * One stream (volume) of a .tibx backup point as a disk image
 */
class TibxImage implements DiskImage {
	constructor(private _archive: TibxArchive, private _pieces: Piece[], readonly size: number) {}

	async read(offset: number, length: number): Promise<Buffer> {
		let end = Math.min(offset + length, this.size);
		if(offset >= end) {
			return Buffer.alloc(0);
		}
		let out = Buffer.alloc(end - offset);

		// First piece ending after 'offset'
		let low = 0;
		let high = this._pieces.length;
		while(low < high) {
			let mid = (low + high) >> 1;
			if(this._pieces[mid].end <= offset) {
				low = mid + 1;
			}
			else {
				high = mid;
			}
		}

		for(let i = low; i < this._pieces.length && this._pieces[i].start < end; i++) {
			let p = this._pieces[i];
			let from = Math.max(offset, p.start);
			let to = Math.min(end, p.end);
			let data = await this._archive.segment(p.segmentId);
			let at = p.segmentOffset + (from - p.start);
			if(at + (to - from) > data.length) {
				throw new FormatError('Segment ' + p.segmentId + ' is shorter than the extents that use it');
			}
			data.copy(out, from - offset, at, at + (to - from));
		}
		return out;
	}
}


export class TibxSlice extends Slice {
	private _fs?: Promise<DiskFS>;

	constructor(
		private _archive: TibxArchive,
		parent: TibxSlice | null,
		private _record: BackupPointRecord | null,
		private _streams: Array<{ name: string; image: DiskImage }>,
		readonly config: SliceConfig
	) {
		super([], parent);
	}

	get id(): Buffer {
		return this._record ? this._record.uuid : Buffer.alloc(16);
	}

	get creationTime(): Date {
		return this._record ? this._record.started : this._archive.fileTime;
	}

	override get kind(): SliceKind {
		return 'disk';
	}

	/** 'full', 'incremental', 'differential' or 'edited' */
	get backupType() {
		return this._record ? this._record.type : 'full';
	}

	async openFileSystem(): Promise<SnapshotFS> {
		if(!this._fs) {
			this._fs = DiskFS.Create(this._streams, this.creationTime);
			this._fs.catch(() => { this._fs = undefined; });
		}
		return this._fs;
	}

	async close() {}
}


/**
 * A .tibx backup (True Image 2020 and later). See doc/Format-Tibx.md.
 */
export class TibxArchive extends Archive {

	private _segments = new Map<number, SegmentLocation>();
	private _segmentCache: LRUCache<number, Buffer> = createBlockCache<number>();
	fileTime = new Date(0);

	private constructor(name: string, private _store: PageStore, readonly header: ArchiveHeader) {
		super(name, [], []);
	}

	override get format(): ArchiveFormat {
		return 'tibx';
	}

	override async files(): Promise<ArchiveFile[]> {
		return this._store.files.map((f) => ({ fileName: f.fileName, size: f.pageCount * PAGE_SIZE, headerChecksumOk: true }));
	}

	/** Decompressed data of a segment (cached) */
	segment(segmentId: number): Promise<Buffer> {
		return this._segmentCache.getOrLoad(segmentId, async () => {
			let location = this._segments.get(segmentId);
			if(!location) {
				throw new FormatError('Segment ' + segmentId + ' is not in the segment map');
			}
			return readSegment(this._store, location.firstPage, segmentId, this._dataKey);
		});
	}

	private _dataKey: DataKey | null = null;

	/** The encryption algorithm, when the backup is encrypted and was opened with its password */
	get encryption(): string | undefined {
		return this._dataKey ? algorithmName(this._dataKey.algorithmId) : undefined;
	}

	/**
	 * EXPERIMENTAL: finds the data key with the password (header slot 7, password users [0x01][name]),
	 * and checks it by decrypting and decompressing one segment.
	 */
	private async unlock(password: string | undefined, testSegmentId: number) {
		if(password === undefined) {
			throw new NotSupportedError('This .tibx backup is encrypted; open it with its password (experimental)', 'encrypted');
		}
		let keymap = parseSuperblock(this.header.slots[KEYMAP_SLOT] || Buffer.alloc(0), KEYMAP_SLOT);
		if(!keymap) {
			throw new NotSupportedError('This .tibx backup is encrypted, but its key records weren\'t found', 'encrypted');
		}

		let candidates = (await readTree(this._store, keymap)).filter((e) => e.key[0] === 0x01);
		if(candidates.length === 0) {
			throw new NotSupportedError('This .tibx backup is protected by a certificate, not a password; that isn\'t supported', 'encrypted');
		}
		for(let c of candidates) {
			let key = unwrapPasswordKey(c.value!, password);
			if(!key) {
				continue;
			}
			this._dataKey = key;
			try {
				await this.segment(testSegmentId);
				warn('Decrypting .tibx backups is experimental: written from format notes, not yet checked against a backup encrypted by True Image');
				return;
			}
			catch(e: any) {
				this._dataKey = null;
				this._segmentCache.clear();
				if(!(e instanceof FormatError)) {
					throw e;
				}
			}
		}
		throw new FormatError('Wrong password for this backup', 'wrong-password');
	}

	static async OpenFile(fileName: string, options: OpenOptions = {}): Promise<TibxArchive> {
		let dir = path.dirname(fileName);
		let base = path.basename(fileName);
		let m = /^(.*?)(?:-(\d{4}))?\.tibx$/i.exec(base);
		if(!m) {
			throw new FormatError('Unexpected .tibx file name: ' + base, 'unexpected-name');
		}
		let stem = m[1];

		// The archive file and its numbered data files
		let names = (await fs.promises.readdir(dir)).filter((f) => {
			let x = /^(.*?)(?:-(\d{4}))?\.tibx$/i.exec(f);
			return x && x[1].toLowerCase() === stem.toLowerCase();
		});
		let dataFiles = names.filter((f) => /-\d{4}\.tibx$/i.test(f)).sort();
		let mainFile = names.find((f) => !/-\d{4}\.tibx$/i.test(f));

		let opened: PageFile[] = [];
		try {
			for(let f of (dataFiles.length ? dataFiles : [ mainFile! ])) {
				opened.push(await PageStore.openFile(path.join(dir, f)));
			}

			// Newest header across the files; data files also say where they sit in the global page space
			let newest: ArchiveHeader | null = null;
			for(let f of opened) {
				let found = await readNewestHeader(f);
				if(!found) {
					continue;
				}
				let firstPage = await PageStore.readLocalPage(f, 0);
				f.firstGlobalPage = firstPage[1] === PageType.ArchiveHeader ? 0 : found.header.firstGlobalPage;
				if(!newest || found.header.sequence >= newest.sequence) {
					newest = found.header;
				}
			}
			if(dataFiles.length && mainFile) {
				let mainPages = await PageStore.openFile(path.join(dir, mainFile));
				try {
					let found = await readNewestHeader(mainPages);
					if(found && (!newest || found.header.sequence > newest.sequence)) {
						newest = found.header;
					}
				}
				finally {
					await mainPages.reader.close();
				}
			}
			if(!newest) {
				throw new FormatError('No .tibx archive header found in ' + base);
			}

			let store = new PageStore(opened);
			opened = [];
			let archive = new TibxArchive(stem, store, newest);
			try {
				archive.fileTime = (await fs.promises.stat(fileName)).mtime;
				await archive.load(options);
			}
			catch(e) {
				await archive.close();
				throw e;
			}
			return archive;
		}
		catch(e) {
			for(let f of opened) {
				await f.reader.close();
			}
			throw e;
		}
	}

	private async load(options: OpenOptions) {
		let slot = (i: number) => this.header.slots[i] || Buffer.alloc(0);
		let dataMap = parseSuperblock(slot(TREE_SLOT.dataMap), TREE_SLOT.dataMap);
		let segmentMap = parseSuperblock(slot(TREE_SLOT.segmentMap), TREE_SLOT.segmentMap);
		let slicesTree = parseSuperblock(slot(TREE_SLOT.slices), TREE_SLOT.slices);
		if(!dataMap || !segmentMap) {
			throw new FormatError('.tibx header has no data map or segment map');
		}
		if(dataMap.keyLength !== 31 || dataMap.valueLength !== 10 || segmentMap.keyLength !== 8 || segmentMap.valueLength < 12) {
			throw new NotSupportedError('Unexpected .tibx tree layout (data map ' + dataMap.keyLength + '/' + dataMap.valueLength + ', segment map ' + segmentMap.keyLength + '/' + segmentMap.valueLength + ')');
		}

		// segment_map: uint64 id -> uint32 page count (little-endian!), uint32 first page, uint32 backup point id, SHA-1
		for(let e of await readTree(this._store, segmentMap)) {
			let id = Number(e.key.readBigUInt64BE(0));
			this._segments.set(id, { firstPage: e.value!.readUInt32BE(4), sliceId: e.value!.readUInt32BE(8) });
		}

		// data_map: (volume, offset, uint24 length, kind, extent id) -> (segment id, index in segment)
		let extents: Extent[] = [];
		for(let e of await readTree(this._store, dataMap)) {
			extents.push({
				volumeId: Number(e.key.readBigUInt64BE(0)),
				offset: Number(e.key.readBigUInt64BE(8)),
				length: e.key.readUIntBE(16, 3),
				extentId: Number(e.key.readBigUInt64BE(23)),
				segmentId: Number(e.value!.readBigUInt64BE(0)),
				indexInSegment: e.value!.readUInt16BE(8),
			});
		}

		// An encrypted backup needs its password before anything can be read
		if(extents.length > 0) {
			let location = this._segments.get(extents[0].segmentId);
			let first = location ? await this._store.readPage(location.firstPage).catch(() => null) : null;
			if(first && (first.subarray(8, 12).equals(SE_MAGIC) || first.readUInt32BE(20) !== 0)) {
				await this.unlock(options.password, extents[0].segmentId);
			}
		}

		// Extents sharing a segment are stored back to back in index order (an assumption)
		let segmentOffsets = new Map<string, number>();
		let bySegment = new Map<number, Extent[]>();
		for(let e of extents) {
			if(e.indexInSegment !== WHOLE_SEGMENT) {
				let list = bySegment.get(e.segmentId) || [];
				list.push(e);
				bySegment.set(e.segmentId, list);
			}
		}
		for(let [ segmentId, list ] of bySegment) {
			list.sort((a, b) => a.indexInSegment - b.indexInSegment);
			let at = 0;
			for(let e of list) {
				segmentOffsets.set(segmentId + ':' + e.indexInSegment, at);
				at += e.length;
			}
		}

		// Backup points: slices tree, uint32 id -> 132-byte record
		let records: BackupPointRecord[] = [];
		if(slicesTree) {
			for(let e of await readTree(this._store, slicesTree)) {
				let v = e.value!;
				if(v.length < 0x45) {
					continue;
				}
				let flags = v[0x44];
				records.push({
					sliceId: e.key.readUInt32BE(0),
					uuid: Buffer.from(v.subarray(0, 16)),
					started: new Date(Number(v.readBigUInt64BE(0x10))),
					parentUuid: Buffer.from(v.subarray(0x20, 0x30)),
					type: flags & 0x04 ? 'differential' : flags & 0x08 ? 'edited' : (flags & 0x73) ? 'incremental' : 'full',
				});
			}
		}
		records.sort((a, b) => a.sliceId - b.sliceId);

		let meta = parseMetaKeys(slot(TREE_SLOT.metaKeys));
		let config: SliceConfig = {};
		if(meta.product) {
			config.productinfo = { name: meta.product, version: { major: 0, minor: 0 }, build_number: 0 };
			let v = /(\d+)\.(\d+)\.\d+\.(\d+)/.exec(meta.product);
			if(v) {
				config.productinfo.version = { major: parseInt(v[1], 10), minor: parseInt(v[2], 10) };
				config.productinfo.build_number = parseInt(v[3], 10);
			}
		}
		if(meta.hostName) {
			config.computer_name = meta.hostName;
		}
		config.encryption = this.encryption ?? 'none';

		let byUuid = new Map(records.map((r) => [ r.uuid.toString('hex'), r ]));
		let points: Array<BackupPointRecord | null> = records.length ? records : [ null ];
		let slices: TibxSlice[] = [];

		for(let record of points) {
			// The backup points this one is built from, oldest first
			let chain: BackupPointRecord[] = [];
			for(let r: BackupPointRecord | undefined = record || undefined; r && chain.length < 10000; r = byUuid.get(r.parentUuid.toString('hex'))) {
				if(chain.includes(r)) {
					throw new FormatError('.tibx backup chain has a loop');
				}
				chain.unshift(r);
				if(r.parentUuid.every((b) => b === 0)) {
					break;
				}
			}
			let levelOf = new Map(chain.map((r, i) => [ r.sliceId, i ]));

			let volumes = new Map<number, Extent[][]>();
			for(let e of extents) {
				let segment = this._segments.get(e.segmentId);
				let level = record ? (segment ? levelOf.get(segment.sliceId) : undefined) : 0;
				if(level === undefined) {
					continue;
				}
				if(!volumes.has(e.volumeId)) {
					volumes.set(e.volumeId, chain.length ? chain.map(() => []) : [ [] ]);
				}
				volumes.get(e.volumeId)![level].push(e);
			}

			let streams: Array<{ name: string; image: DiskImage }> = [];
			for(let [ volumeId, levels ] of Array.from(volumes.entries()).sort((a, b) => a[0] - b[0])) {
				let pieces = piecesFor(levels, segmentOffsets);
				let size = pieces.reduce((max, p) => Math.max(max, p.end), 0);
				let image = new TibxImage(this, pieces, size);
				if(size < MIN_SHOWN_STREAM_SIZE) {
					// Small streams hold True Image's own metadata unless they start like a disk or volume
					let first = await image.read(0, 512).catch(() => Buffer.alloc(0));
					if(first.length < 512 || first[510] !== 0x55 || first[511] !== 0xaa) {
						continue;
					}
				}
				streams.push({ name: 'Volume ' + volumeId, image });
			}

			if(streams.length === 1) {
				streams[0].name = 'Volume';
			}
			let slice = new TibxSlice(this, slices[slices.length - 1] || null, record, streams, config);
			slices.push(slice);
		}

		this.slices.push(...slices);
	}

	override async close() {
		await super.close();
		this._segmentCache.clear();
		await this._store.close();
	}
}

Archive.AddFileType('tibx', (fileName, options) => TibxArchive.OpenFile(fileName, options));
