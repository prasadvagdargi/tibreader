import { FormatError } from '../errors';


const SYMBOL_COUNT = 512;
const LOOKUP_BITS = 15;
const NO_SYMBOL = 0xffff;

/**
 * Decompresses "LZ77+Huffman" (Xpress Huffman, MS-XCA section 2.2), used by Windows' Compact OS
 * (WOF) for 4K/8K/16K chunks. Only single-block input (output up to 64 KiB) is supported, which
 * covers every WOF chunk size.
 *
 * Input: 256 bytes of 4-bit code lengths for 512 symbols, then a bit stream read as 16-bit
 * little-endian words. Symbols 0-255 are literals; 256-511 are matches (low 4 bits: length - 3,
 * with 15 meaning more length bytes follow; high bits: number of offset bits).
 */
export function xpressHuffmanDecompress(input: Buffer, expectedOutputSize: number): Buffer {
	if(expectedOutputSize > 65536) {
		throw new FormatError('Xpress Huffman output larger than one block is not supported');
	}
	if(input.length < 260) {
		throw new FormatError('Xpress Huffman data too short');
	}

	let codeLengthOfSymbol = new Uint8Array(SYMBOL_COUNT);
	for(let i = 0; i < 256; i++) {
		codeLengthOfSymbol[2 * i] = input[i] & 0x0f;
		codeLengthOfSymbol[2 * i + 1] = input[i] >> 4;
	}

	// Canonical codes (by length, then symbol value); the table maps the next 15 bits to a symbol
	let symbolForNext15Bits = new Uint16Array(1 << LOOKUP_BITS).fill(NO_SYMBOL);
	let nextCode = 0;
	for(let codeLength = 1; codeLength <= LOOKUP_BITS; codeLength++) {
		for(let symbol = 0; symbol < SYMBOL_COUNT; symbol++) {
			if(codeLengthOfSymbol[symbol] !== codeLength) {
				continue;
			}
			let firstEntry = nextCode << (LOOKUP_BITS - codeLength);
			let entryCount = 1 << (LOOKUP_BITS - codeLength);
			if(firstEntry + entryCount > symbolForNext15Bits.length) {
				throw new FormatError('Xpress Huffman code lengths are invalid');
			}
			symbolForNext15Bits.fill(symbol, firstEntry, firstEntry + entryCount);
			nextCode++;
		}
		nextCode <<= 1;
	}

	let output = Buffer.alloc(expectedOutputSize);
	let outputPosition = 0;
	let inputPosition = 256;

	let readWord = (at: number) => (at + 1 < input.length ? input.readUInt16LE(at) : at < input.length ? input[at] : 0);

	// The next 32 bits of the stream, most significant first; 'spareBitCount' says how many bits beyond
	// the first 16 are still valid (refilled 16 bits at a time)
	let upcomingBits = ((readWord(inputPosition) << 16) | readWord(inputPosition + 2)) >>> 0;
	inputPosition += 4;
	let spareBitCount = 16;

	let consumeBits = (count: number) => {
		if(count === 0) {
			return;
		}
		upcomingBits = count === 32 ? 0 : (upcomingBits << count) >>> 0;
		spareBitCount -= count;
		if(spareBitCount < 0) {
			upcomingBits = (upcomingBits | (readWord(inputPosition) << -spareBitCount)) >>> 0;
			inputPosition += 2;
			spareBitCount += 16;
		}
	};

	while(outputPosition < expectedOutputSize) {
		let symbol = symbolForNext15Bits[upcomingBits >>> (32 - LOOKUP_BITS)];
		if(symbol === NO_SYMBOL) {
			throw new FormatError('Invalid Xpress Huffman code');
		}
		consumeBits(codeLengthOfSymbol[symbol]);

		if(symbol < 256) {
			output[outputPosition++] = symbol;
			continue;
		}

		let matchSymbol = symbol - 256;
		let matchLength = matchSymbol & 15;
		let offsetBitCount = matchSymbol >> 4;

		if(matchLength === 15) {
			if(inputPosition >= input.length) {
				throw new FormatError('Xpress Huffman data cut off');
			}
			matchLength = input[inputPosition++];
			if(matchLength === 255) {
				if(inputPosition + 2 > input.length) {
					throw new FormatError('Xpress Huffman data cut off');
				}
				matchLength = input.readUInt16LE(inputPosition);
				inputPosition += 2;
				if(matchLength < 15) {
					throw new FormatError('Invalid Xpress Huffman match length');
				}
				matchLength -= 15;
			}
			matchLength += 15;
		}
		matchLength += 3;

		let matchOffset = (offsetBitCount === 0 ? 0 : upcomingBits >>> (32 - offsetBitCount)) + (1 << offsetBitCount);
		consumeBits(offsetBitCount);

		if(matchOffset > outputPosition) {
			throw new FormatError('Xpress Huffman match points before the start');
		}
		for(let k = 0; k < matchLength && outputPosition < expectedOutputSize; k++) {
			output[outputPosition] = output[outputPosition - matchOffset];
			outputPosition++;
		}
	}

	return output;
}
