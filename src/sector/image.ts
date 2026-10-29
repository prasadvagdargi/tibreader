import zlib from 'node:zlib';
import { Reader } from '../reader';
import { DiskImage, readAt } from '../disk/image';
import { ChunkMap } from './chunkmap';
import { LRUCache } from '../cache';
import { FormatError } from '../errors';


export interface SectorGeometry {
	/** Bytes per cluster (4096 in every known file) */
	clusterSize: number;
	/** Clusters per block: 128 (True Image 2018+) or 64 (2014-2016) */
	clustersPerBlock: number;
}

export function bitmapLength(g: SectorGeometry) {
	return Math.ceil(g.clustersPerBlock / 8);
}

function popcountBefore(bitmap: Buffer, bit: number): number {
	let c = 0;
	let full = bit >> 3;
	for(let i = 0; i < full; i++) {
		let b = bitmap[i];
		b = b - ((b >> 1) & 0x55);
		b = (b & 0x33) + ((b >> 2) & 0x33);
		c += (b + (b >> 4)) & 0x0f;
	}
	let rem = bit & 7;
	if(rem) {
		let b = bitmap[full] & ((1 << rem) - 1);
		while(b) {
			c += b & 1;
			b >>= 1;
		}
	}
	return c;
}

export function popcount(bitmap: Buffer): number {
	return popcountBefore(bitmap, bitmap.length * 8);
}

interface Block {
	bitmap: Buffer;
	data: Buffer; /**< the present clusters, back to back */
}

/**
 * A partition (or disk) image stored sector by sector: fixed-size blocks, each a bitmap of which
 * clusters are present followed by a zlib stream of those clusters. The chunk map says where each
 * block is.
 */
export class SectorImage implements DiskImage {

	readonly blockSize: number;
	private _bitmapLen: number;

	/**
	 * @param _reader reader over the archive's data (offsets in the chunk map are relative to it)
	 * @param _map one entry per block
	 * @param size image size in bytes (defaults to blocks x block size)
	 * @param _fallback where to read blocks this image doesn't store (the previous backup point, for
	 *        incremental images); null means they read as zeros
	 */
	constructor(
		private _reader: Reader,
		private _map: ChunkMap,
		readonly geometry: SectorGeometry,
		private _cache: LRUCache<string, Buffer>,
		private _cacheKey: string,
		size?: number,
		private _fallback: DiskImage | null = null
	) {
		this.blockSize = geometry.clusterSize * geometry.clustersPerBlock;
		this._bitmapLen = bitmapLength(geometry);
		this.size = size ?? _map.offsets.length * this.blockSize;
	}

	readonly size: number;

	get blockCount() {
		return this._map.offsets.length;
	}

	/** Number of blocks actually stored in the archive */
	get storedBlocks() {
		let n = 0;
		for(let i = 0; i < this._map.lengths.length; i++) {
			if(this._map.lengths[i] > 0) {
				n++;
			}
		}
		return n;
	}

	async read(offset: number, length: number): Promise<Buffer> {
		let end = Math.min(offset + length, this.size);
		if(offset >= end) {
			return Buffer.alloc(0);
		}

		let out = Buffer.alloc(end - offset);
		let cs = this.geometry.clusterSize;

		let pos = offset;
		while(pos < end) {
			let bi = Math.floor(pos / this.blockSize);
			let blockStart = bi * this.blockSize;
			let blockEnd = Math.min(blockStart + this.blockSize, end);

			if(bi >= this._map.lengths.length || this._map.lengths[bi] === 0) {
				if(this._fallback && bi < this._map.lengths.length) {
					let b = await this._fallback.read(pos, blockEnd - pos);
					b.copy(out, pos - offset);
				}
				pos = blockEnd;
				continue;
			}

			let block = await this.loadBlock(bi);
			while(pos < blockEnd) {
				let ci = Math.floor((pos - blockStart) / cs);
				let clusterEnd = Math.min(blockStart + (ci + 1) * cs, blockEnd);
				if(block.bitmap[ci >> 3] & (1 << (ci & 7))) {
					let at = popcountBefore(block.bitmap, ci) * cs + (pos - blockStart - ci * cs);
					block.data.copy(out, pos - offset, at, at + (clusterEnd - pos));
				}
				pos = clusterEnd;
			}
		}

		return out;
	}

	/**
	 * Decompresses one stored block and checks it (zlib's Adler-32, and the size the bitmap promises).
	 * Throws a FormatError on damage.
	 */
	async verifyBlock(i: number): Promise<void> {
		if(this._map.lengths[i] > 0) {
			await this.readBlock(i);
		}
	}

	private loadBlock(i: number): Promise<Block> {
		return this._cache.getOrLoad(this._cacheKey + ':' + i, async () => {
			let b = await this.readBlock(i);
			return Buffer.concat([ b.bitmap, b.data ]);
		}).then((raw) => ({ bitmap: raw.subarray(0, this._bitmapLen), data: raw.subarray(this._bitmapLen) }));
	}

	private async readBlock(i: number): Promise<Block> {
		let off = this._map.offsets[i];
		let len = this._map.lengths[i];
		if(len <= this._bitmapLen) {
			throw new FormatError('Disk block ' + i + ' is too short (' + len + ' bytes)');
		}

		let raw = await readAt(this._reader, off, len);
		let bitmap = Buffer.from(raw.subarray(0, this._bitmapLen));
		let expected = popcount(bitmap) * this.geometry.clusterSize;

		let data: Buffer;
		try {
			data = zlib.inflateSync(raw.subarray(this._bitmapLen), { maxOutputLength: Math.max(expected, 1) });
		}
		catch(e: any) {
			throw new FormatError('Disk block ' + i + ' at ' + off + ' is damaged: ' + e.message);
		}

		if(data.length !== expected) {
			throw new FormatError('Disk block ' + i + ' at ' + off + ' has ' + data.length + ' bytes; its bitmap says ' + expected);
		}

		return { bitmap, data };
	}
}
