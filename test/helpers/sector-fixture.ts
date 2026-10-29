/**
 * Builds small synthetic sector-by-sector (disk image) .tib backups following doc/Format-Sector.md:
 * modern (True Image 2018+, chunk map after the data) and legacy (2014-2016, chunk-map records between
 * the blocks). They test the reader against our understanding of the format, which comes from
 * acronis-tib-reader's notes on real files.
 */
import zlib from 'node:zlib';
import { encodeChunkMap } from '../../src/sector/chunkmap';
import { encodeTlv, encodeUintLE } from '../../src/sector/tlv';
import { writeSliceFiles } from './windows-fixture';


export interface SectorFixtureOptions {
	name?: string;
	era?: 'modern' | 'legacy';
	/** 128 (modern default) or 64 (legacy default) */
	clustersPerBlock?: number;
	/** 'stored' (deflate level 0, like most real blocks), 'deflate', or 'mixed' */
	compression?: 'stored' | 'deflate' | 'mixed';
	/** Swap neighbouring blocks on disk, like True Image's parallel compression does */
	shuffle?: boolean;
	/** Split into .tib files of at most this many bytes */
	volumeSplit?: number;
	encryption?: string;
	/** Write the exact image size into the trailer (default true) */
	partitionSize?: boolean;
	/** Corrupt the stored bytes of this block */
	corruptBlock?: number;
	/** Several partitions' images in one backup point (modern only): one chunk map each */
	extraImages?: Buffer[];
	/** Store only the blocks that differ from this image (an incremental backup point) */
	baseImage?: Buffer;
}

const CLUSTER = 4096;

function metainfoXml(encryption: string) {
	return '<?xml version="1.0" encoding="UTF-8"?><metainfo>' +
		'<productinfo name="True Image"><version major="22" minor="0"/><build number="5554"/></productinfo>' +
		'<task_id id="C1133A11-4824-4C42-8DD6-8A7264522492"/>' +
		'<computer_id id="440688B3-8B53-4AE2-805B-E0FB47662523"/>' +
		'<compression value="normal"/><encryption value="' + encryption + '"/></metainfo>';
}

function chunkHeader(cpb: number, count: number, extraTags: Array<{ tag: number; value: Buffer }> = []) {
	let tlv = encodeTlv([
		{ tag: 2, value: encodeUintLE(512, 2) },
		{ tag: 3, value: encodeUintLE(8) },
		{ tag: 4, value: encodeUintLE(cpb) },
		{ tag: 6, value: encodeUintLE(count, 3) },
		...extraTags
	]);
	return Buffer.concat([ Buffer.from([ tlv.length ]), tlv ]);
}

interface EncodedBlock {
	index: number;
	bytes: Buffer;
}

function encodeBlocks(image: Buffer, cpb: number, opts: SectorFixtureOptions, base?: Buffer): EncodedBlock[] {
	let blockSize = cpb * CLUSTER;
	let n = Math.ceil(image.length / blockSize);
	let out: EncodedBlock[] = [];

	for(let b = 0; b < n; b++) {
		let block = Buffer.alloc(blockSize);
		image.copy(block, 0, b * blockSize, Math.min(image.length, (b + 1) * blockSize));

		if(base) {
			let old = Buffer.alloc(blockSize);
			base.copy(old, 0, b * blockSize, Math.min(base.length, (b + 1) * blockSize));
			if(old.equals(block)) {
				continue;
			}
		}

		// Clusters that are all zeros aren't stored (like unused clusters of the source volume)
		let bitmap = Buffer.alloc(cpb / 8);
		let present: Buffer[] = [];
		for(let c = 0; c < cpb; c++) {
			let cl = block.subarray(c * CLUSTER, (c + 1) * CLUSTER);
			if(cl.some((x) => x !== 0)) {
				bitmap[c >> 3] |= 1 << (c & 7);
				present.push(cl);
			}
		}
		if(present.length === 0 && !base) {
			continue;
		}

		let mode = opts.compression || 'stored';
		let level = mode === 'stored' || (mode === 'mixed' && b % 2 === 0) ? 0 : 6;
		let z = zlib.deflateSync(Buffer.concat(present), { level });
		let bytes = Buffer.concat([ bitmap, z ]);
		if(opts.corruptBlock === b) {
			bytes[bytes.length - 10] ^= 0x55;
		}
		out.push({ index: b, bytes });
	}
	return out;
}

/**
 * Builds the slice data of one backup point. 'start' is where this slice starts in the archive's data
 * (the sum of earlier slices' sizes).
 */
export function buildSectorSlice(image: Buffer, opts: SectorFixtureOptions = {}, start = 0): Buffer {
	let era = opts.era || 'modern';
	let cpb = opts.clustersPerBlock || (era === 'modern' ? 128 : 64);
	let blockSize = cpb * CLUSTER;

	let chunks: Buffer[] = [];
	let pos = start;
	let push = (b: Buffer) => { let at = pos; chunks.push(b); pos += b.length; return at; };

	let images = [ image, ...(opts.extraImages || []) ];
	let maps: Array<{ offsets: number[]; lengths: number[]; image: Buffer }> = [];

	for(let img of images) {
		let blocks = encodeBlocks(img, cpb, opts, img === image ? opts.baseImage : undefined);
		if(opts.shuffle) {
			for(let i = 0; i + 1 < blocks.length; i += 3) {
				[ blocks[i], blocks[i + 1] ] = [ blocks[i + 1], blocks[i] ];
			}
		}

		let n = Math.ceil(img.length / blockSize);
		let map = { offsets: new Array<number>(n).fill(0), lengths: new Array<number>(n).fill(0), image: img };

		if(era === 'legacy') {
			// Two chunk-map records between the blocks: one after the first few blocks, one at the end.
			// Each covers the next run of image blocks, in order.
			let firstCover = Math.min(3, n);
			let covered = 0;
			let writeInline = (upTo: number) => {
				let offs: number[] = [];
				let lens: number[] = [];
				let prev = 0;
				for(let b = covered; b < upTo; b++) {
					offs.push(map.lengths[b] ? map.offsets[b] : prev);
					lens.push(map.lengths[b]);
					prev = map.lengths[b] ? map.offsets[b] + map.lengths[b] : prev;
				}
				push(Buffer.concat([ chunkHeader(cpb, upTo - covered), zlib.deflateSync(encodeChunkMap({ offsets: offs, lengths: lens })) ]));
				covered = upTo;
			};

			for(let blk of blocks) {
				if(blk.index >= firstCover && covered < firstCover) {
					writeInline(firstCover);
				}
				map.offsets[blk.index] = push(blk.bytes);
				map.lengths[blk.index] = blk.bytes.length;
			}
			if(covered < firstCover) {
				writeInline(firstCover);
			}
			writeInline(n);
		}
		else {
			for(let blk of blocks) {
				map.offsets[blk.index] = push(blk.bytes);
				map.lengths[blk.index] = blk.bytes.length;
			}
		}
		maps.push(map);
	}

	let locators: Buffer[] = [];
	if(era === 'modern') {
		// Chunk maps, then other streams: a bare zlib stream (bitmap mirror) and the metainfo XML
		for(let m of maps) {
			let n = m.offsets.length;
			// Unstored blocks keep the running offset, as True Image's delta coding expects
			let prev = 0;
			let offs = m.offsets.map((o, i) => { let v = m.lengths[i] ? o : prev; if(m.lengths[i]) { prev = o + m.lengths[i]; } return v; });
			let region = Buffer.concat([ chunkHeader(cpb, n), zlib.deflateSync(encodeChunkMap({ offsets: offs, lengths: m.lengths })) ]);
			let at = push(region);
			let loc = Buffer.alloc(13);
			loc[0] = 0x06;
			loc.writeUIntLE(at, 1, 6);
			loc[7] = 0x01; loc[8] = 0x00; loc[9] = 0x03;
			loc.writeUIntLE(region.length, 10, 3);
			locators.push(loc);
		}
		push(zlib.deflateSync(Buffer.alloc(64, 0xff)));
		let xml = zlib.deflateSync(Buffer.from(metainfoXml(opts.encryption || 'none')));
		push(Buffer.concat([ Buffer.from([ 3 ]), encodeTlv([ { tag: 0x63, value: Buffer.alloc(0) } ]), xml ]));
		// Stand-in for the MD5 list and dedup filter
		push(Buffer.alloc(256, 0x5a));
	}

	// Metadata area: fixed header, then records; legacy embeds the XML as a zlib stream
	let metaDataOffset = pos;
	let blobParts: Buffer[] = [ Buffer.alloc(80, 0x11) ];
	if(era === 'legacy') {
		blobParts.push(Buffer.from([ 0x4d, 0x00, 0x00, 0x00 ]), zlib.deflateSync(Buffer.from(metainfoXml(opts.encryption || 'none'))));
	}
	for(let loc of locators) {
		blobParts.push(Buffer.from([ 0x9b, 0x00, 0x00 ]), loc);
	}
	blobParts.push(Buffer.from('end of metadata area'));
	push(Buffer.concat(blobParts));

	// Trailer
	let w = era === 'modern' ? 6 : 5;
	let fixed = (v: number) => { let b = Buffer.alloc(w); b.writeUIntLE(v, 0, w); return b; };
	let records = [
		{ tag: 0x0000, value: fixed(metaDataOffset) },
		{ tag: 0x0001, value: Buffer.from([ 0x1d, 0x02 ]) },
	];
	if(opts.partitionSize !== false) {
		records.push({ tag: 0x8000, value: fixed(image.length) }, { tag: 0x8001, value: fixed(image.length) });
	}
	records.push({ tag: 0x8007, value: fixed(metaDataOffset + 48) });
	let body = encodeTlv(records);
	let size = Buffer.alloc(4);
	size.writeUInt32LE(body.length, 0);
	push(Buffer.concat([ body, size, Buffer.from('2B8AE194', 'hex') ]));

	return Buffer.concat(chunks);
}

/**
 * Writes a disk-image backup into 'dir'. Returns the first .tib file.
 */
export function writeSectorBackup(dir: string, image: Buffer, opts: SectorFixtureOptions = {}): string {
	let data = buildSectorSlice(image, opts);
	return writeSliceFiles(dir, (opts.name || 'Disk') + '_full_b1_s1', data, opts.volumeSplit || 0)[0];
}

/**
 * Writes a full backup and incremental ones: images[0] is the full backup, each later one an
 * incremental storing only changed blocks.
 */
export function writeSectorChain(dir: string, images: Buffer[], opts: SectorFixtureOptions = {}): string[] {
	let files: string[] = [];
	let start = 0;
	let seq = 1;
	images.forEach((img, i) => {
		let data = buildSectorSlice(img, { ...opts, baseImage: i > 0 ? images[i - 1] : undefined }, start);
		let base = (opts.name || 'Disk') + (i === 0 ? '_full' : '_inc') + '_b1_s' + (i + 1);
		let written = writeSliceFiles(dir, base, data, 0, seq);
		seq += written.length;
		start += data.length;
		files.push(...written);
	});
	return files;
}

/**
 * Test image: some random clusters, some zero runs, some repeated text
 */
export function sampleImage(size: number, seed = 1): Buffer {
	let b = Buffer.alloc(size);
	let x = seed;
	let rnd = () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x >>> 8; };
	for(let off = 0; off < size; off += CLUSTER) {
		let kind = rnd() % 4;
		if(kind === 0) {
			continue; // unused cluster
		}
		let end = Math.min(off + CLUSTER, size);
		if(kind === 1) {
			b.fill('cluster ' + off + ' ', off, end);
		}
		else {
			for(let i = off; i < end; i++) {
				b[i] = rnd() & 0xff;
			}
		}
	}
	return b;
}
