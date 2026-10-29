/**
 * CRC-32C (Castagnoli), used for .tibx pages. Node's zlib only offers the other CRC-32 polynomial.
 * Slicing-by-8 tables: about 1 GB/s in V8, fast enough to check every page that is read.
 */
const TABLES: Uint32Array[] = (() => {
	let tables: Uint32Array[] = [];
	let base = new Uint32Array(256);
	for(let i = 0; i < 256; i++) {
		let crc = i;
		for(let k = 0; k < 8; k++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
		}
		base[i] = crc >>> 0;
	}
	tables.push(base);
	for(let t = 1; t < 8; t++) {
		let table = new Uint32Array(256);
		for(let i = 0; i < 256; i++) {
			let previous = tables[t - 1][i];
			table[i] = (previous >>> 8) ^ base[previous & 0xff];
		}
		tables.push(table);
	}
	return tables;
})();

export function crc32c(data: Uint8Array, previousCrc = 0): number {
	let [ t0, t1, t2, t3, t4, t5, t6, t7 ] = TABLES;
	let crc = ~previousCrc >>> 0;
	let i = 0;
	let end8 = data.length - (data.length % 8);
	for(; i < end8; i += 8) {
		let low = (crc ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))) >>> 0;
		crc = t7[low & 0xff] ^ t6[(low >>> 8) & 0xff] ^ t5[(low >>> 16) & 0xff] ^ t4[low >>> 24] ^
			t3[data[i + 4]] ^ t2[data[i + 5]] ^ t1[data[i + 6]] ^ t0[data[i + 7]];
	}
	for(; i < data.length; i++) {
		crc = t0[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return ~crc >>> 0;
}
