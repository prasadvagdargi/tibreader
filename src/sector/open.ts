import zlib from 'node:zlib';
import { Reader } from '../reader';
import { readAt, DiskImage } from '../disk/image';
import { FormatError } from '../errors';
import { warn } from '../log';
import { LRUCache } from '../cache';
import { ReadCompressedStream } from '../compression';
import { SliceConfig } from '../slice';
import { parseTlv, tlvMap, uintLE, TlvRecord } from './tlv';
import { ChunkMap, decodeChunkMap } from './chunkmap';
import { SectorGeometry, SectorImage, bitmapLength } from './image';
import { storedZlibLength } from './deflate';
import { loadCachedChunkMap, saveCachedChunkMap } from './indexcache';


export const DEFAULT_GEOMETRY: SectorGeometry = { clusterSize: 4096, clustersPerBlock: 128 };
export const LEGACY_GEOMETRY: SectorGeometry = { clusterSize: 4096, clustersPerBlock: 64 };

export interface SectorTrailer {
	records: TlvRecord[];
	/** Archive offset of the metadata area (concatenated data coordinates) */
	metaDataOffset: number;
	/** Size of the backed-up partition, when stored */
	partitionSize?: number;
	/** Archive offset where the trailer body starts (the metadata area ends there) */
	bodyStart: number;
}

/**
 * Parses the trailer at the end of a sector-by-sector slice:
 *   [body: tag/length records] [uint32 body size] [2B 8A E1 94]
 * Tag 0x0000 is the metadata offset, 0x8000 the partition size.
 */
export async function readSectorTrailer(abs: Reader, sliceStart: number, sliceEnd: number): Promise<SectorTrailer> {
	if(sliceEnd - sliceStart < 16) {
		throw new FormatError('Disk-image backup point is too small');
	}
	let tail = await readAt(abs, sliceEnd - 8, 8);
	let size = tail.readUInt32LE(0);
	if(size < 3 || size > 4096 || sliceEnd - 8 - size < sliceStart) {
		throw new FormatError('Implausible disk-image trailer size ' + size);
	}

	let bodyStart = sliceEnd - 8 - size;
	let body = await readAt(abs, bodyStart, size);
	let records = parseTlv(body);
	let m = tlvMap(records);

	let meta = m.get(0x0000);
	if(!meta) {
		throw new FormatError('Disk-image trailer has no metadata offset');
	}
	let metaDataOffset = uintLE(meta);
	if(metaDataOffset < sliceStart || metaDataOffset > bodyStart) {
		throw new FormatError('Disk-image metadata offset ' + metaDataOffset + ' is outside of its backup point');
	}

	let ps = m.get(0x8000);
	return { records, metaDataOffset, bodyStart, partitionSize: ps ? uintLE(ps) : undefined };
}


export interface SectorDisk {
	era: 'modern' | 'legacy';
	images: Array<{ name: string; image: SectorImage }>;
	config: SliceConfig;
	trailer: SectorTrailer;
}

export interface OpenSectorOptions {
	cache: LRUCache<string, Buffer>;
	/** Unique per backup point; used as the block cache key and the on-disk index key */
	id: string;
	/** Identifies the backup files for the on-disk index cache (path, size, time); none disables it */
	indexKey?: string;
	/** The previous backup point's images, for incremental backups */
	parent?: SectorDisk | null;
}


/**
 * Opens the disk image(s) of one sector-by-sector backup point.
 *
 * @param abs reader over the archive's data up to the end of this backup point
 * @param sliceStart archive offset where this backup point's data starts
 */
export async function openSectorDisk(abs: Reader, sliceStart: number, opts: OpenSectorOptions): Promise<SectorDisk> {
	let sliceEnd = await abs.length();
	let trailer = await readSectorTrailer(abs, sliceStart, sliceEnd);

	// The metadata area runs from the metadata offset to the trailer
	let blobStart = trailer.metaDataOffset;
	let blobLen = trailer.bodyStart - blobStart;
	if(blobLen > 1024 * 1024) {
		warn('Disk-image metadata area is unusually large (' + blobLen + ' bytes); only its end is searched');
		blobStart = trailer.bodyStart - 64 * 1024;
		blobLen = 64 * 1024;
	}
	let blob = await readAt(abs, blobStart, blobLen);

	let config: SliceConfig = {};
	let maps: Array<{ map: ChunkMap; geometry: SectorGeometry; regionEnd: number }> = [];
	let era: 'modern' | 'legacy';

	let regions = findChunkMapLocators(blob, trailer.metaDataOffset, sliceStart);
	if(regions.length > 0) {
		era = 'modern';
		for(let r of regions) {
			try {
				maps.push(await readChunkMapRegion(abs, r.offset, r.size));
			}
			catch(e: any) {
				if(regions.length === 1) {
					throw e;
				}
				warn('Skipping an unreadable chunk map at ' + r.offset + ': ' + e.message);
			}
		}
		if(maps.length === 0) {
			throw new FormatError('No readable chunk map in this disk image');
		}
		Object.assign(config, await findMetainfoAfter(abs, maps[maps.length - 1].regionEnd, trailer.metaDataOffset));
	}
	else {
		era = 'legacy';
		let cached = opts.indexKey ? loadCachedChunkMap(opts.indexKey) : null;
		if(cached) {
			maps.push({ map: cached.map, geometry: cached.geometry, regionEnd: 0 });
		}
		else {
			let walked = await walkLegacyBlockStream(abs, sliceStart, trailer.metaDataOffset);
			maps.push({ map: walked.map, geometry: walked.geometry, regionEnd: 0 });
			if(opts.indexKey) {
				saveCachedChunkMap(opts.indexKey, walked.map, walked.geometry);
			}
		}
	}

	if(Object.keys(config).length === 0) {
		Object.assign(config, findMetainfoIn(blob));
	}

	let images = maps.map((m, i) => {
		let blockSize = m.geometry.clusterSize * m.geometry.clustersPerBlock;
		let n = m.map.offsets.length;
		let size = n * blockSize;
		// The trailer's partition size is exact; use it when it fits this (only) image
		if(maps.length === 1 && trailer.partitionSize && trailer.partitionSize <= size && trailer.partitionSize > size - blockSize) {
			size = trailer.partitionSize;
		}

		let fallback: DiskImage | null = null;
		if(opts.parent && opts.parent.images[i]) {
			fallback = opts.parent.images[i].image;
		}

		return {
			name: maps.length === 1 ? 'Volume' : 'Volume ' + (i + 1),
			image: new SectorImage(abs, m.map, m.geometry, opts.cache, opts.id + ':' + i, size, fallback)
		};
	});

	return { era, images, config, trailer };
}


/**
 * Finds modern chunk-map locators in the metadata area: the 13 bytes `06 <V: 6 bytes> 01 00 03 <S: 3 bytes>`
 * where V is the archive offset of the chunk-map region and S its size. (acronis-tib-reader found this
 * pattern inside TLV tag 0x9B; the surrounding area isn't fully understood, so it is searched for.)
 */
export function findChunkMapLocators(blob: Buffer, metaDataOffset: number, sliceStart: number): Array<{ offset: number; size: number }> {
	let found = new Map<number, number>();
	for(let i = 0; i + 13 <= blob.length; i++) {
		if(blob[i] !== 0x06 || blob[i + 7] !== 0x01 || blob[i + 8] !== 0x00 || blob[i + 9] !== 0x03) {
			continue;
		}
		let v = blob.readUIntLE(i + 1, 6);
		let s = blob.readUIntLE(i + 10, 3);
		if(v >= sliceStart && v < metaDataOffset && v + s <= metaDataOffset && s > 20 && !found.has(v)) {
			found.set(v, s);
		}
	}
	return Array.from(found.entries()).sort((a, b) => a[0] - b[0]).map(([ offset, size ]) => ({ offset, size }));
}

/** Geometry from a chunk-map header: tag 2 bytes/sector, 3 sectors/cluster, 4 clusters/block */
function geometryFrom(m: Map<number, Buffer>, fallback: SectorGeometry): SectorGeometry {
	let bytesPerSector = m.has(2) ? uintLE(m.get(2)!) : 0;
	let sectorsPerCluster = m.has(3) ? uintLE(m.get(3)!) : 0;
	let clustersPerBlock = m.has(4) ? uintLE(m.get(4)!) : fallback.clustersPerBlock;
	let clusterSize = bytesPerSector && sectorsPerCluster ? bytesPerSector * sectorsPerCluster : fallback.clusterSize;

	if(clusterSize < 512 || clusterSize > 1024 * 1024 || clustersPerBlock < 8 || clustersPerBlock > 4096 || clustersPerBlock % 8 !== 0) {
		throw new FormatError('Implausible disk-image geometry: ' + clusterSize + ' bytes x ' + clustersPerBlock);
	}
	return { clusterSize, clustersPerBlock };
}

function recordSizeFrom(m: Map<number, Buffer>, plainLength: number, count?: number): number {
	// Tags 0xC7/0xDF mark 20-byte records (whole-disk and "hybrid" chunk maps)
	if(m.has(0xc7) || m.has(0xdf)) {
		return 20;
	}
	if(count && plainLength === count * 20) {
		return 20;
	}
	return 12;
}

/**
 * A chunk-map region: [uint8 L] [L bytes of tag/length records] [zlib stream]
 */
async function readChunkMapRegion(abs: Reader, offset: number, size: number) {
	let head = await readAt(abs, offset, Math.min(size, 80));
	let L = head[0];
	if(L < 3 || 1 + L + 2 > head.length) {
		throw new FormatError('Bad chunk-map header at ' + offset);
	}
	let m = tlvMap(parseTlv(head.subarray(1, 1 + L)));
	let geometry = geometryFrom(m, DEFAULT_GEOMETRY);
	let count = m.has(6) ? uintLE(m.get(6)!) : undefined;

	let compressed = await readAt(abs, offset + 1 + L, size - 1 - L);
	let plain: Buffer;
	try {
		plain = zlib.inflateSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
	}
	catch(e: any) {
		throw new FormatError('Chunk map at ' + offset + ' is damaged: ' + e.message);
	}

	let recordSize = recordSizeFrom(m, plain.length, count);
	if(count !== undefined && plain.length !== count * recordSize) {
		throw new FormatError('Chunk map at ' + offset + ' has ' + plain.length + ' bytes for ' + count + ' records');
	}
	if(recordSize === 20) {
		warn('This disk image uses 20-byte chunk-map records, which have not been checked against a real file');
	}

	return { map: decodeChunkMap(plain, recordSize), geometry, regionEnd: offset + size };
}

function isZlibHeader(a: number, b: number) {
	return (a & 0x0f) === 8 && (a >> 4) <= 7 && ((a << 8) | b) % 31 === 0 && !(b & 0x20);
}

/**
 * True Image 2014-2016: the chunk map is split into records between the blocks:
 *   [uint8 L] [L bytes of tag/length records (tag 6 = record count)] [zlib stream of records]
 * Walks every block from the start of the backup point to find them. Slow for big images
 * (reads every block header), so the result is cached.
 */
export async function walkLegacyBlockStream(abs: Reader, start: number, end: number): Promise<{ map: ChunkMap; geometry: SectorGeometry }> {
	let geometry = LEGACY_GEOMETRY;

	for(let attempt = 0; attempt < 2; attempt++) {
		let bl = bitmapLength(geometry);
		let records: Buffer[] = [];
		let found: SectorGeometry | null = null;
		let pos = start;
		let blocks = 0;

		while(pos + bl + 2 <= end) {
			let head = await readAt(abs, pos, Math.min(80, end - pos));

			// Inline chunk-map record?
			let L = head[0];
			if(L >= 8 && L <= 64 && 1 + L + 2 <= head.length && isZlibHeader(head[1 + L], head[2 + L])) {
				let tlv = parseTlv(head.subarray(1, 1 + L));
				let consumed = tlv.reduce((n, r) => n + 3 + (r.value.length >= 0x80 ? 1 : 0) + r.value.length, 0);
				let m = tlvMap(tlv);
				if(consumed === L && m.has(6)) {
					let g = geometryFrom(m, geometry);
					if(!found) {
						found = g;
					}
					let r = abs.slice();
					let plain: Buffer;
					try {
						r.seek(pos + 1 + L);
						plain = await ReadCompressedStream(r, -1);
						pos = r.pos();
					}
					finally {
						await r.close();
					}
					records.push(plain);
					continue;
				}
			}

			// A block: bitmap, then a zlib stream
			if(!isZlibHeader(head[bl], head[bl + 1])) {
				break;
			}
			let len = await storedZlibLength(abs, pos + bl, end);
			if(len < 0) {
				let r = abs.slice();
				try {
					r.seek(pos + bl);
					await ReadCompressedStream(r, -1);
					len = r.pos() - (pos + bl);
				}
				finally {
					await r.close();
				}
			}
			pos += bl + len;
			blocks++;
		}

		if(found && (found.clustersPerBlock !== geometry.clustersPerBlock || found.clusterSize !== geometry.clusterSize) && attempt === 0) {
			// Blocks were walked with the wrong bitmap size; walk again with the real geometry
			geometry = found;
			continue;
		}

		if(records.length === 0) {
			throw new FormatError('This disk image has no chunk map that this reader can find (walked ' + blocks + ' blocks)');
		}

		let maps = records.map((p) => decodeChunkMap(p, 12));
		let n = maps.reduce((s, m) => s + m.offsets.length, 0);
		let offsets = new Float64Array(n);
		let lengths = new Uint32Array(n);
		let at = 0;
		for(let m of maps) {
			offsets.set(m.offsets, at);
			lengths.set(m.lengths, at);
			at += m.offsets.length;
		}
		return { map: { offsets, lengths }, geometry: found || geometry };
	}

	throw new FormatError('Could not walk the disk image');
}


/**
 * Modern files keep the metainfo XML in a stream after the chunk map:
 * streams are either bare zlib or [uint8 L][L bytes][zlib].
 */
async function findMetainfoAfter(abs: Reader, start: number, end: number): Promise<SliceConfig> {
	let pos = start;
	for(let i = 0; i < 10 && pos + 3 < end; i++) {
		let head = await readAt(abs, pos, Math.min(80, end - pos));
		let zpos = pos;
		if(!isZlibHeader(head[0], head[1])) {
			let L = head[0];
			if(1 + L + 2 > head.length || !isZlibHeader(head[1 + L], head[2 + L])) {
				break;
			}
			zpos = pos + 1 + L;
		}

		let r = abs.slice();
		let plain: Buffer;
		try {
			r.seek(zpos);
			plain = await ReadCompressedStream(r, -1, false, 128 * 1024 * 1024);
			pos = r.pos();
		}
		catch(e) {
			break;
		}
		finally {
			await r.close();
		}

		let cfg = parseMetainfoXml(plain);
		if(cfg) {
			return cfg;
		}
	}
	return {};
}

/** Legacy files embed small zlib streams in the metadata area; one of them is the metainfo XML */
export function findMetainfoIn(blob: Buffer): SliceConfig {
	for(let i = 0; i + 2 < blob.length; i++) {
		if(!isZlibHeader(blob[i], blob[i + 1])) {
			continue;
		}
		try {
			let plain = zlib.inflateSync(blob.subarray(i), { maxOutputLength: 1024 * 1024 });
			let cfg = parseMetainfoXml(plain);
			if(cfg) {
				return cfg;
			}
		}
		catch(e) {
			// Not a zlib stream; keep looking
		}
	}
	return {};
}

/**
 * Reads the settings from a <metainfo> XML document (UTF-8 or UTF-16). Lenient: missing parts are left out.
 */
export function parseMetainfoXml(data: Buffer): SliceConfig | null {
	let text = data.length >= 2 && data[0] === 0xff && data[1] === 0xfe ? data.toString('utf16le') : data.toString('utf8');
	if(!/<metainfo[\s>]/.test(text)) {
		return null;
	}

	let cfg: SliceConfig = {};
	let attr = (tag: string, name: string) => {
		let m = new RegExp('<' + tag + '\\b[^>]*\\b' + name + '="([^"]*)"').exec(text);
		return m ? m[1] : undefined;
	};

	let product = attr('productinfo', 'name');
	let major = attr('version', 'major');
	let minor = attr('version', 'minor');
	let build = attr('build', 'number');
	if(product !== undefined || major !== undefined) {
		cfg.productinfo = {
			name: product || '',
			version: { major: parseInt(major || '0', 10), minor: parseInt(minor || '0', 10) },
			build_number: parseInt(build || '0', 10)
		};
	}

	let task = attr('task_id', 'id');
	if(task) {
		cfg.task_id = task;
	}
	let computer = attr('computer_id', 'id');
	if(computer) {
		cfg.machine_id = computer;
	}
	let compression = attr('compression', 'value');
	if(compression) {
		cfg.compression = compression;
	}
	let encryption = attr('encryption', 'value');
	if(encryption) {
		cfg.encryption = encryption;
	}
	return cfg;
}
