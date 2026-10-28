/**
 * What kind of problem an error is, so programs (like the desktop app) can explain it without
 * parsing the message:
 * - not-a-backup: the file isn't a .tib file at all
 * - unexpected-name: a Windows backup file was renamed, so its other parts can't be found
 * - missing-part: a file of a split backup or chain is missing (or an extra one is present)
 * - damaged: the data doesn't match the format (corrupt, truncated or an unknown variant)
 * - encrypted: the backup is encrypted
 * - disk-image: a sector-by-sector (whole disk/partition) backup
 * - unsupported: anything else this library can't read yet
 */
export type ErrorCode = 'not-a-backup' | 'unexpected-name' | 'missing-part' | 'damaged' | 'encrypted' | 'disk-image' | 'unsupported';

/**
 * The file doesn't match what we know about the .tib format (corrupt, truncated or an unknown variant)
 */
export class FormatError extends Error {
	override name = 'FormatError';
	readonly code: ErrorCode;

	constructor(message: string, code: ErrorCode = 'damaged') {
		super(message);
		this.code = code;
	}
}

/**
 * The file looks valid, but uses a part of the format this library can't read yet
 */
export class NotSupportedError extends Error {
	override name = 'NotSupportedError';
	readonly code: ErrorCode;

	constructor(message: string, code: ErrorCode = 'unsupported') {
		super(message);
		this.code = code;
	}
}

/**
 * Throws a FormatError if a parsed value isn't what the format requires
 */
export function check(condition: unknown, message: string): asserts condition {
	if(!condition) {
		throw new FormatError(message);
	}
}
