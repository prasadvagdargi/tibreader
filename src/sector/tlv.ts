/**
 * Tag/length/value records used by sector-by-sector .tib files (trailer, chunk-map headers):
 *
 *   uint16 tag (little-endian)
 *   length: 1 byte, or if its top bit is set, 2 bytes big-endian with the top bit cleared
 *   value
 *
 * The high byte of the tag is sometimes described as a "sub-tag": tag 0x8000 is "00.80".
 */
export interface TlvRecord {
	tag: number;
	value: Buffer;
}

/**
 * Parses records until the buffer ends. Stops quietly at a record that doesn't fit (callers check
 * for the tags they need).
 */
export function parseTlv(buf: Buffer): TlvRecord[] {
	let out: TlvRecord[] = [];
	let i = 0;
	while(i + 3 <= buf.length) {
		let tag = buf.readUInt16LE(i);
		let len = buf[i + 2];
		let start = i + 3;
		if(len & 0x80) {
			if(i + 4 > buf.length) {
				break;
			}
			len = ((len << 8) | buf[i + 3]) & 0x7fff;
			start = i + 4;
		}
		if(start + len > buf.length) {
			break;
		}
		out.push({ tag, value: buf.subarray(start, start + len) });
		i = start + len;
	}
	return out;
}

/** Little-endian unsigned integer of up to 6 bytes (7-8 bytes if the value fits in 2^53) */
export function uintLE(b: Buffer): number {
	if(b.length === 0) {
		return 0;
	}
	if(b.length <= 6) {
		return b.readUIntLE(0, b.length);
	}
	let lo = b.readUIntLE(0, 6);
	let hi = b.readUIntLE(6, Math.min(2, b.length - 6));
	let v = hi * 2 ** 48 + lo;
	if(!Number.isSafeInteger(v)) {
		throw new RangeError('Value too large: ' + b.toString('hex'));
	}
	return v;
}

export function tlvMap(records: TlvRecord[]): Map<number, Buffer> {
	let m = new Map<number, Buffer>();
	for(let r of records) {
		if(!m.has(r.tag)) {
			m.set(r.tag, r.value);
		}
	}
	return m;
}

/** Writes records in the same format (fixtures and writers) */
export function encodeTlv(records: Array<{ tag: number; value: Buffer }>): Buffer {
	let parts: Buffer[] = [];
	for(let r of records) {
		let h: Buffer;
		if(r.value.length < 0x80) {
			h = Buffer.alloc(3);
			h.writeUInt16LE(r.tag, 0);
			h[2] = r.value.length;
		}
		else {
			if(r.value.length > 0x7fff) {
				throw new RangeError('TLV value too long');
			}
			h = Buffer.alloc(4);
			h.writeUInt16LE(r.tag, 0);
			h[2] = 0x80 | (r.value.length >> 8);
			h[3] = r.value.length & 0xff;
		}
		parts.push(h, r.value);
	}
	return Buffer.concat(parts);
}

/** Smallest little-endian encoding of a non-negative integer (at least 'min' bytes) */
export function encodeUintLE(v: number, min = 1): Buffer {
	let n = min;
	while(n < 8 && v >= 2 ** (8 * n)) {
		n++;
	}
	let b = Buffer.alloc(n);
	let x = v;
	for(let i = 0; i < n; i++) {
		b[i] = x % 256;
		x = Math.floor(x / 256);
	}
	return b;
}
