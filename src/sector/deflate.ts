import { Reader } from '../reader';


/**
 * Length in bytes of the zlib stream starting at 'start', found by reading only block headers.
 *
 * Works when every deflate block of the stream is "stored" (uncompressed), which is how True Image
 * writes most disk-image blocks. Returns -1 when a compressed block is found (the caller then has to
 * decompress to find the end) or when the stream doesn't look like zlib.
 */
export async function storedZlibLength(reader: Reader, start: number, limit: number): Promise<number> {
	let r = reader.slice();
	try {
		r.seek(start);
		if(start + 2 > limit) {
			return -1;
		}
		let h = await r.readBytes(2);
		if((h[0] & 0x0f) !== 8 || ((h[0] << 8) | h[1]) % 31 !== 0 || (h[1] & 0x20)) {
			return -1;
		}

		let pos = start + 2;
		while(true) {
			if(pos + 5 > limit) {
				return -1;
			}
			r.seek(pos);
			let b = await r.readBytes(5);
			let final = b[0] & 1;
			let type = (b[0] >> 1) & 3;
			if(type !== 0) {
				return -1;
			}
			let len = b.readUInt16LE(1);
			let nlen = b.readUInt16LE(3);
			if((len ^ 0xffff) !== nlen) {
				return -1;
			}
			pos += 5 + len;
			if(final) {
				// Adler-32 follows
				return pos + 4 <= limit ? pos + 4 - start : -1;
			}
		}
	}
	finally {
		await r.close();
	}
}
