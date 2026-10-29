import fs from 'node:fs';
import path from 'node:path';


/**
 * Every kind of file this library can recognize from its first bytes:
 * - tib: a .tib volume (Windows file or disk backup, or Mac backup); see `version`
 * - tib-very-old: True Image 2010-2013 Windows .tib (version 1 with a 32-byte header)
 * - tib-files-v1 / tib-files-v2: older file-backup containers (magic 8F5C36C6 / 44686EB4)
 * - tib-tape: tape archive
 * - tibx: True Image 2020+ archive (`role` tells the small main file from its data slices)
 * - unknown: not a backup file we know
 */
export type FormatKind = 'tib' | 'tib-very-old' | 'tib-files-v1' | 'tib-files-v2' | 'tib-tape' | 'tibx' | 'unknown';

export interface DetectedFormat {
	kind: FormatKind;
	/** tib: 0 Windows, 1 Mac */
	version?: number;
	/** tib: header length in bytes */
	headerLength?: number;
	/** tibx: 'archive' for NAME.tibx (holds the archive header), 'slice' for NAME-0001.tibx data files */
	role?: 'archive' | 'slice';
	/** Human readable name of the format */
	description: string;
}

export const TIB_MAGIC = 0xA2B924CE;
const FILES_V1_MAGIC = 0x8F5C36C6;
const FILES_V2_MAGIC = 0x44686EB4;
const TAPE_MAGIC = 0x179631B4;

// .tibx page envelope: 41 <type> 00 00 <crc32c>; the archive header page has "ARCH" at offset 8
const TIBX_PAGE_TYPES = new Set([ 0x01, 0x02, 0x03, 0x04, 0x05, 0xff ]);

/**
 * Recognizes a format from the first 64 bytes of a file and its last 4 bytes
 */
export function detectFromBytes(head: Buffer, tail?: Buffer, fileName?: string): DetectedFormat {
	if(head.length >= 12 && head[0] === 0x41 && head[2] === 0 && head[3] === 0 && TIBX_PAGE_TYPES.has(head[1])) {
		let isArch = head[1] === 0x01 && head.subarray(8, 12).toString('latin1') === 'ARCH';
		let looksLikeSlice = fileName ? /-\d{4}\.tibx$/i.test(fileName) : false;
		let role: 'archive' | 'slice' = isArch && !looksLikeSlice ? 'archive' : 'slice';
		return {
			kind: 'tibx', role,
			description: role === 'archive' ? '.tibx archive (True Image 2020 or later)' : '.tibx data file (True Image 2020 or later)'
		};
	}

	if(head.length < 8) {
		return { kind: 'unknown', description: 'not a backup file' };
	}

	let magic = head.readUInt32LE(0);

	if(magic === TIB_MAGIC && head.length >= 32) {
		let headerLength = head.readUInt16LE(4);
		let version = head.readUInt16LE(6);
		let sectorSize = head.readUInt32LE(0x1c);

		// The Mac format also uses version 1, but with a 36-byte header
		if(version === 1 && headerLength === 0x20 && sectorSize === 0x1000) {
			return { kind: 'tib-very-old', version, headerLength, description: '.tib from True Image 2010-2013' };
		}

		return {
			kind: 'tib', version, headerLength,
			description: version === 1 ? '.tib (Mac)' : version === 0 ? '.tib (Windows)' : '.tib (unknown version ' + version + ')'
		};
	}

	if(magic === FILES_V1_MAGIC) {
		return { kind: 'tib-files-v1', description: 'old file-backup .tib (container v1, magic 8F5C36C6)' };
	}

	if(magic === FILES_V2_MAGIC) {
		return { kind: 'tib-files-v2', description: 'old file-backup .tib (container v2, magic 44686EB4)' };
	}

	if(magic === TAPE_MAGIC || (tail && tail.length >= 4 && tail.readUInt32LE(tail.length - 4) === TAPE_MAGIC)) {
		return { kind: 'tib-tape', description: 'tape archive .tib' };
	}

	return { kind: 'unknown', description: 'not a backup file' };
}

/**
 * Recognizes the format of a file. Only reads the file.
 */
export async function detectFormat(fileName: string): Promise<DetectedFormat> {
	let fh = await fs.promises.open(fileName, 'r');
	try {
		let size = (await fh.stat()).size;
		let head = Buffer.alloc(Math.min(64, size));
		await fh.read(head, 0, head.length, 0);

		let tail = Buffer.alloc(Math.min(4, size));
		if(size >= 4) {
			await fh.read(tail, 0, 4, size - 4);
		}

		return detectFromBytes(head, tail, path.basename(fileName));
	}
	finally {
		await fh.close();
	}
}
