/**
 * Compressors for the formats the library only decompresses (LZNT1, Xpress Huffman), used to build
 * NTFS test images. Simple and slow on purpose.
 */
import { tokenLayout } from '../../src/ntfs/lznt1';


/**
 * LZNT1 (NTFS compression), greedy matcher
 */
export function lznt1Compress(data: Buffer): Buffer {
	let parts: Buffer[] = [];
	for(let chunkStart = 0; chunkStart < data.length; chunkStart += 4096) {
		let chunk = data.subarray(chunkStart, Math.min(chunkStart + 4096, data.length));
		let body: number[] = [];
		let position = 0;
		while(position < chunk.length) {
			let flagByteIndex = body.length;
			body.push(0);
			let flags = 0;
			for(let bit = 0; bit < 8 && position < chunk.length; bit++) {
				let { lengthMask, offsetShift } = tokenLayout(position);
				let longestAllowedMatch = lengthMask + 3;
				let farthestAllowedOffset = Math.min(position, 1 << (16 - offsetShift));

				let bestLength = 0;
				let bestOffset = 0;
				for(let offset = 1; offset <= farthestAllowedOffset; offset++) {
					let length = 0;
					while(length < longestAllowedMatch && position + length < chunk.length && chunk[position + length] === chunk[position + length - offset]) {
						length++;
					}
					if(length > bestLength) {
						bestLength = length;
						bestOffset = offset;
					}
				}

				if(bestLength >= 3) {
					let token = ((bestOffset - 1) << offsetShift) | (bestLength - 3);
					body.push(token & 0xff, token >> 8);
					flags |= 1 << bit;
					position += bestLength;
				}
				else {
					body.push(chunk[position++]);
				}
			}
			body[flagByteIndex] = flags;
		}

		let isCompressed = body.length < chunk.length;
		let payload = isCompressed ? Buffer.from(body) : chunk;
		let header = Buffer.alloc(2);
		header.writeUInt16LE(((payload.length - 1) & 0x0fff) | 0x3000 | (isCompressed ? 0x8000 : 0), 0);
		parts.push(header, payload);
	}
	return Buffer.concat(parts);
}


/**
 * Xpress Huffman (MS-XCA 2.2) with every symbol given a 9-bit code (a complete, valid code), greedy
 * matcher. The bit stream layout follows MS-XCA's encoder: 16-bit words go into reserved slots, while
 * extra length bytes are written straight to the output, which is how the decoder expects to find them.
 */
export function xpressHuffmanCompress(data: Buffer): Buffer {
	let out = Buffer.alloc(260 + data.length * 4 + 64);
	out.fill(0x99, 0, 256); // every 4-bit length = 9

	let slot1 = 256;
	let slot2 = 258;
	let position = 260;
	let pendingBits = 0;
	let pendingCount = 0;

	let flushWord = () => {
		out.writeUInt16LE(pendingBits & 0xffff, slot1);
		slot1 = slot2;
		slot2 = position;
		position += 2;
		pendingBits = 0;
		pendingCount = 0;
	};

	// A word is flushed (and the next slot reserved) only when its 17th bit arrives: the decoder reads
	// the next word once it has used more than 16 bits, not exactly 16
	let writeBits = (value: number, count: number) => {
		for(let i = count - 1; i >= 0; i--) {
			if(pendingCount === 16) {
				flushWord();
			}
			pendingBits = (pendingBits << 1) | ((value >>> i) & 1);
			pendingCount++;
		}
	};

	let i = 0;
	while(i < data.length) {
		let bestLength = 0;
		let bestOffset = 0;
		for(let offset = 1; offset <= Math.min(i, 8192); offset++) {
			let length = 0;
			while(length < 300 && i + length < data.length && data[i + length] === data[i + length - offset]) {
				length++;
			}
			if(length > bestLength) {
				bestLength = length;
				bestOffset = offset;
			}
		}

		if(bestLength < 3) {
			writeBits(data[i], 9);
			i++;
			continue;
		}

		let offsetBitCount = 31 - Math.clz32(bestOffset);
		let lengthField = bestLength - 3;
		let symbol = 256 + (offsetBitCount << 4) + Math.min(lengthField, 15);
		writeBits(symbol, 9);
		if(lengthField >= 15) {
			if(lengthField - 15 < 255) {
				out[position++] = lengthField - 15;
			}
			else {
				out[position++] = 255;
				out.writeUInt16LE(lengthField, position);
				position += 2;
			}
		}
		writeBits(bestOffset - (1 << offsetBitCount), offsetBitCount);
		i += bestLength;
	}

	// Pad and write the last word; the two reserved slots after it stay zero (the decoder prefetches them)
	if(pendingCount > 0) {
		pendingBits <<= 16 - pendingCount;
		flushWord();
	}
	return Buffer.from(out.subarray(0, position));
}
