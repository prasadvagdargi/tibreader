import { FormatError } from '../errors';


const CHUNK_OUTPUT_SIZE = 4096;

/** Split of a back-reference token: the further into the chunk, the more bits go to the offset */
export function tokenLayout(positionInChunk: number) {
	let lengthMask = 0x0fff;
	let offsetShift = 12;
	for(let p = positionInChunk - 1; p >= 0x10; p >>= 1) {
		lengthMask >>= 1;
		offsetShift--;
	}
	return { lengthMask, offsetShift };
}

/**
 * Decompresses LZNT1 data (NTFS file compression). The input is a series of chunks, each holding up to
 * 4096 bytes of output:
 *   uint16 header: bits 0-11 = chunk data size - 1, bit 15 = compressed
 *   compressed chunks: groups of a flag byte + 8 items (bit clear: literal byte, set: uint16 back-reference)
 *
 * @param expectedOutputSize the size of the compression unit; output the data doesn't cover is zeros
 */
export function lznt1Decompress(input: Buffer, expectedOutputSize: number): Buffer {
	let output = Buffer.alloc(expectedOutputSize);
	let inputPosition = 0;
	let outputPosition = 0;

	while(inputPosition + 2 <= input.length && outputPosition < expectedOutputSize) {
		let header = input.readUInt16LE(inputPosition);
		inputPosition += 2;
		if(header === 0) {
			break;
		}

		let chunkDataSize = (header & 0x0fff) + 1;
		let chunkDataEnd = inputPosition + chunkDataSize;
		if(chunkDataEnd > input.length) {
			throw new FormatError('LZNT1 chunk runs past the end of its data');
		}

		let chunkOutputStart = outputPosition;
		let chunkOutputEnd = Math.min(outputPosition + CHUNK_OUTPUT_SIZE, expectedOutputSize);

		if(!(header & 0x8000)) {
			let storedCount = Math.min(chunkDataSize, chunkOutputEnd - outputPosition);
			input.copy(output, outputPosition, inputPosition, inputPosition + storedCount);
			outputPosition += storedCount;
		}
		else {
			while(inputPosition < chunkDataEnd && outputPosition < chunkOutputEnd) {
				let flags = input[inputPosition++];
				for(let bit = 0; bit < 8 && inputPosition < chunkDataEnd && outputPosition < chunkOutputEnd; bit++) {
					if(!(flags & (1 << bit))) {
						output[outputPosition++] = input[inputPosition++];
						continue;
					}

					if(inputPosition + 2 > chunkDataEnd) {
						throw new FormatError('LZNT1 back-reference cut off');
					}
					let token = input.readUInt16LE(inputPosition);
					inputPosition += 2;

					let { lengthMask, offsetShift } = tokenLayout(outputPosition - chunkOutputStart);
					let matchLength = (token & lengthMask) + 3;
					let matchOffset = (token >>> offsetShift) + 1;
					if(matchOffset > outputPosition - chunkOutputStart) {
						throw new FormatError('LZNT1 back-reference points before the chunk');
					}

					for(let k = 0; k < matchLength && outputPosition < chunkOutputEnd; k++) {
						output[outputPosition] = output[outputPosition - matchOffset];
						outputPosition++;
					}
				}
			}
		}

		inputPosition = chunkDataEnd;
		// A chunk that produced less than 4096 bytes is followed by zeros
		outputPosition = Math.min(chunkOutputStart + CHUNK_OUTPUT_SIZE, expectedOutputSize);
	}

	return output;
}
