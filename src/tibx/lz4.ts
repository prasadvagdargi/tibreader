import { FormatError } from '../errors';


/**
 * Decompresses one LZ4 block into 'output' at 'outputStart', writing exactly 'expectedSize' bytes.
 * Matches may reach back into bytes already in 'output' before 'outputStart' (how .tibx chains
 * blocks: each one uses the previous output as its dictionary).
 */
export function lz4DecompressBlockInto(input: Buffer, output: Buffer, outputStart: number, expectedSize: number): void {
	let inputPosition = 0;
	let outputPosition = outputStart;
	let outputEnd = outputStart + expectedSize;
	if(outputEnd > output.length) {
		throw new FormatError('LZ4 block is larger than its buffer');
	}

	let readLength = (initial: number) => {
		let length = initial;
		if(initial === 15) {
			let more: number;
			do {
				if(inputPosition >= input.length) {
					throw new FormatError('LZ4 data cut off');
				}
				more = input[inputPosition++];
				length += more;
			} while(more === 255);
		}
		return length;
	};

	while(inputPosition < input.length) {
		let token = input[inputPosition++];

		let literalCount = readLength(token >> 4);
		if(inputPosition + literalCount > input.length || outputPosition + literalCount > outputEnd) {
			throw new FormatError('LZ4 literals run past the end');
		}
		input.copy(output, outputPosition, inputPosition, inputPosition + literalCount);
		inputPosition += literalCount;
		outputPosition += literalCount;

		// The last sequence has literals only
		if(inputPosition >= input.length) {
			break;
		}

		if(inputPosition + 2 > input.length) {
			throw new FormatError('LZ4 match offset cut off');
		}
		let matchOffset = input.readUInt16LE(inputPosition);
		inputPosition += 2;
		let matchLength = readLength(token & 0x0f) + 4;
		if(matchOffset === 0 || matchOffset > outputPosition) {
			throw new FormatError('LZ4 match points outside of the data');
		}
		if(outputPosition + matchLength > outputEnd) {
			throw new FormatError('LZ4 match runs past the end');
		}
		for(let k = 0; k < matchLength; k++) {
			output[outputPosition] = output[outputPosition - matchOffset];
			outputPosition++;
		}
	}

	if(outputPosition !== outputEnd) {
		throw new FormatError('LZ4 block gave ' + (outputPosition - outputStart) + ' bytes, expected ' + expectedSize);
	}
}

/**
 * A chain of LZ4 blocks, each prefixed by big-endian uint32 compressed size and uint32 decompressed
 * size (.tibx tree pages).
 */
export function lz4DecompressChain(input: Buffer, expectedTotal: number): Buffer {
	let output = Buffer.alloc(expectedTotal);
	let inputPosition = 0;
	let outputPosition = 0;
	while(inputPosition < input.length) {
		if(inputPosition + 8 > input.length) {
			throw new FormatError('LZ4 block header cut off');
		}
		let compressedSize = input.readUInt32BE(inputPosition);
		let decompressedSize = input.readUInt32BE(inputPosition + 4);
		inputPosition += 8;
		if(inputPosition + compressedSize > input.length) {
			throw new FormatError('LZ4 block runs past the end');
		}
		lz4DecompressBlockInto(input.subarray(inputPosition, inputPosition + compressedSize), output, outputPosition, decompressedSize);
		inputPosition += compressedSize;
		outputPosition += decompressedSize;
	}
	if(outputPosition !== expectedTotal) {
		throw new FormatError('LZ4 data gave ' + outputPosition + ' bytes, expected ' + expectedTotal);
	}
	return output;
}
