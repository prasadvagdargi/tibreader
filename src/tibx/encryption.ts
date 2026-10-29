import crypto from 'node:crypto';
import { FormatError, NotSupportedError } from '../errors';


/*
 * EXPERIMENTAL: .tibx password decryption, written from acronis-tib-reader's decompilation notes
 * (docs/legacy/ARCHIVE3_ENCRYPTION.md). Never tested against a backup encrypted by True Image.
 *
 * - Header slot 7 holds the "keymap" tree; a password user is the record [0x01][user name] whose value
 *   is: format 0x01, algorithm, PBKDF2 iterations as a power of two, 0, 16-byte salt, then the data key
 *   encrypted with AES-256-CBC (zero IV, PKCS#7) under PBKDF2-HMAC-SHA256(password, salt) (32 bytes).
 * - Encrypted segments say "SE\0\0" instead of "SG\0\1"; their stored bytes are the 16-byte IV (CBC:
 *   then the ciphertext; GCM: then a 16-byte tag and the ciphertext), encrypting the compressed data.
 */

export const KEYMAP_SLOT = 7;

const ALGORITHMS: { [id: number]: { name: string; keyLength: number; isGcm: boolean } } = {
	1: { name: 'aes-128-cbc', keyLength: 16, isGcm: false },
	2: { name: 'aes-192-cbc', keyLength: 24, isGcm: false },
	3: { name: 'aes-256-cbc', keyLength: 32, isGcm: false },
	5: { name: 'aes-128-gcm', keyLength: 16, isGcm: true },
	6: { name: 'aes-192-gcm', keyLength: 24, isGcm: true },
	7: { name: 'aes-256-gcm', keyLength: 32, isGcm: true },
};

export interface DataKey {
	algorithmId: number;
	key: Buffer;
}

export function algorithmName(id: number): string {
	return ALGORITHMS[id] ? ALGORITHMS[id].name : 'unknown (' + id + ')';
}

/**
 * Tries a password against one wrapped-key record. Returns null if the password doesn't fit (the
 * format has no password check, so "fits" means the padding and key length come out right; the
 * caller still has to check a segment).
 */
export function unwrapPasswordKey(blob: Buffer, password: string): DataKey | null {
	if(blob.length < 0x14 + 16 || blob[0] !== 0x01) {
		return null;
	}
	let algorithm = ALGORITHMS[blob[1]];
	let iterationsLog2 = blob[2];
	if(!algorithm) {
		throw new NotSupportedError('Unknown .tibx encryption algorithm ' + blob[1], 'encrypted');
	}
	if(iterationsLog2 < 10 || iterationsLog2 > 24) {
		throw new FormatError('Implausible key derivation settings in the encrypted .tibx');
	}

	let salt = blob.subarray(4, 0x14);
	let keyEncryptionKey = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 2 ** iterationsLog2, 32, 'sha256');
	try {
		let decipher = crypto.createDecipheriv('aes-256-cbc', keyEncryptionKey, Buffer.alloc(16));
		let key = Buffer.concat([ decipher.update(blob.subarray(0x14)), decipher.final() ]);
		return key.length === algorithm.keyLength ? { algorithmId: blob[1], key } : null;
	}
	catch(e) {
		return null; // bad padding: wrong password
	}
}

/**
 * Decrypts the stored bytes of an "SE" segment. Throws a FormatError with code 'wrong-password' when
 * authentication or padding fails (wrong password, or damage).
 */
export function decryptSegment(stored: Buffer, dataKey: DataKey): Buffer {
	let algorithm = ALGORITHMS[dataKey.algorithmId];
	let iv = stored.subarray(0, 16);
	try {
		if(algorithm.isGcm) {
			if(stored.length < 32) {
				throw new FormatError('Encrypted segment too short');
			}
			let decipher = crypto.createDecipheriv(algorithm.name as crypto.CipherGCMTypes, dataKey.key, iv);
			decipher.setAuthTag(stored.subarray(16, 32));
			return Buffer.concat([ decipher.update(stored.subarray(32)), decipher.final() ]);
		}
		if((stored.length - 16) % 16 !== 0 || stored.length <= 16) {
			throw new FormatError('Encrypted segment is not a whole number of AES blocks');
		}
		let decipher = crypto.createDecipheriv(algorithm.name, dataKey.key, iv);
		return Buffer.concat([ decipher.update(stored.subarray(16)), decipher.final() ]);
	}
	catch(e: any) {
		if(e instanceof FormatError) {
			throw e;
		}
		throw new FormatError('Could not decrypt a segment: wrong password, or the backup is damaged', 'wrong-password');
	}
}
