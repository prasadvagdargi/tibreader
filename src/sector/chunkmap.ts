import { FormatError } from '../errors';


/**
 * Where each block of a disk image is stored: one entry per block of the image, in image order.
 * A length of 0 means the block wasn't stored (it reads as zeros).
 */
export interface ChunkMap {
	/** Offsets of the stored blocks (archive offsets: from the start of the archive's data) */
	offsets: Float64Array;
	/** Bytes the stored block takes in the archive (cluster bitmap + zlib stream), 0 if not stored */
	lengths: Uint32Array;
}

/**
 * Decodes chunk-map records, after zlib decompression (see doc/Format-Sector.md):
 * - the N records of 'recordSize' bytes are stored column by column (byte 0 of every record, then
 *   byte 1, ...), which compresses better;
 * - each record is { uint64 offset delta, uint32 length } (20-byte records have 8 more bytes, ignored);
 * - the delta is zigzag-coded (bit 0 is the sign, then the magnitude) and relative to the end of the
 *   previous block (offset + length).
 */
export function decodeChunkMap(plain: Buffer, recordSize = 12): ChunkMap {
	if(recordSize !== 12 && recordSize !== 20) {
		throw new FormatError('Unsupported chunk-map record size ' + recordSize);
	}
	if(plain.length % recordSize !== 0) {
		throw new FormatError('Chunk map is ' + plain.length + ' bytes, not a multiple of ' + recordSize);
	}

	let n = plain.length / recordSize;
	let offsets = new Float64Array(n);
	let lengths = new Uint32Array(n);

	// Byte c of record r is at c * n + r
	let col = (c: number, r: number) => plain[c * n + r];
	let u32 = (c: number, r: number) => (col(c, r) | (col(c + 1, r) << 8) | (col(c + 2, r) << 16) | (col(c + 3, r) << 24)) >>> 0;

	let running = 0;
	for(let r = 0; r < n; r++) {
		let lo = u32(0, r);
		let hi = u32(4, r);
		let len = u32(8, r);

		if(hi >= 2 ** 22) {
			throw new FormatError('Chunk-map offset delta too large in record ' + r);
		}

		// (hi:lo) >> 1, exact as long as it stays below 2^53
		let mag = hi * 2 ** 31 + (lo >>> 1);
		let delta = (lo & 1) ? -mag : mag;
		let off = running + delta;
		if(off < 0 || !Number.isSafeInteger(off)) {
			throw new FormatError('Chunk-map record ' + r + ' points outside of the archive');
		}

		offsets[r] = off;
		lengths[r] = len;
		running = off + len;
	}

	return { offsets, lengths };
}

/**
 * Encodes a chunk map the way True Image does (inverse of decodeChunkMap; result still needs zlib)
 */
export function encodeChunkMap(map: { offsets: ArrayLike<number>; lengths: ArrayLike<number> }): Buffer {
	let n = map.offsets.length;
	let out = Buffer.alloc(n * 12);
	let running = 0;

	for(let r = 0; r < n; r++) {
		let delta = map.offsets[r] - running;
		let mag = Math.abs(delta);
		let hi = Math.floor(mag / 2 ** 31);
		let lo = ((mag % 2 ** 31) * 2 + (delta < 0 ? 1 : 0)) >>> 0;
		let len = map.lengths[r];

		let put = (c: number, v: number) => {
			for(let k = 0; k < 4; k++) {
				out[(c + k) * n + r] = (v >>> (8 * k)) & 0xff;
			}
		};
		put(0, lo);
		put(4, hi);
		put(8, len);

		running = map.offsets[r] + len;
	}

	return out;
}
