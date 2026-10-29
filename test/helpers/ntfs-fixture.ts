/**
 * Builds small NTFS volume images for tests, following the NTFS on-disk format (as documented by
 * Microsoft and the Linux NTFS project). Only what the reader needs is written: boot sector, MFT,
 * folder indexes ($INDEX_ROOT, and INDX blocks for big folders), $UpCase, $Volume's label, files.
 */
import { lznt1Compress, xpressHuffmanCompress } from './compressors';


export interface NtfsFixtureEntry {
	/** e.g. "/Docs/a.txt" */
	path: string;
	kind: 'file' | 'directory';
	data?: Buffer;
	mtime?: Date;
	/** Store with NTFS compression (LZNT1) */
	compressed?: boolean;
	/** Store as a Windows Compact OS file: 0 = Xpress 4K, 2 = 8K, 3 = 16K, 1 = LZX */
	wofAlgorithm?: number;
	/** Split the data into several runs with gaps between them */
	fragmented?: boolean;
	/** Leave this many leading clusters of the file unallocated (a sparse file) */
	sparseLeadingClusters?: number;
	/** Alternate data streams */
	streams?: { [name: string]: Buffer };
	/** Put the $DATA attribute in two extension records described by an $ATTRIBUTE_LIST */
	useAttributeList?: boolean;
	/** Also add a second name (hard link) in this folder */
	hardLinkIn?: string;
}

export interface NtfsFixtureOptions {
	label?: string;
	/** Size of the whole image (rounded up to whole clusters) */
	size?: number;
}

const CLUSTER = 4096;
const RECORD_SIZE = 1024;
const INDEX_BLOCK_SIZE = 4096;
const MFT_LCN = 4;
const FILETIME_EPOCH_MS = 11644473600000;

const u16 = (v: number) => { let b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
const u32 = (v: number) => { let b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const u64 = (v: number | bigint) => { let b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; };
const pad8 = (b: Buffer) => Buffer.concat([ b, Buffer.alloc((8 - (b.length % 8)) % 8) ]);
const filetime = (d: Date) => BigInt(d.getTime() + FILETIME_EPOCH_MS) * 10000n;

interface Run { lcn: number; clusterCount: number }  // lcn -1 = sparse

interface Attr { type: number; name?: string; flags?: number; id?: number; resident?: Buffer; nonResident?: { runs: Run[]; startVcn?: number; lastVcn?: number; dataSize: number; allocatedSize?: number; compressionUnitLog2?: number } }

function encodeRuns(runs: Run[]): Buffer {
	let out: number[] = [];
	let previousLcn = 0;
	let bytesFor = (v: bigint, signed: boolean) => {
		let n = 1;
		while(true) {
			let min = signed ? -(1n << BigInt(8 * n - 1)) : 0n;
			let max = signed ? (1n << BigInt(8 * n - 1)) - 1n : (1n << BigInt(8 * n)) - 1n;
			if(v >= min && v <= max) {
				return n;
			}
			n++;
		}
	};
	for(let r of runs) {
		let length = BigInt(r.clusterCount);
		let lengthBytes = bytesFor(length, false);
		let offsetBytes = 0;
		let delta = 0n;
		if(r.lcn >= 0) {
			delta = BigInt(r.lcn - previousLcn);
			offsetBytes = bytesFor(delta, true);
			previousLcn = r.lcn;
		}
		out.push(lengthBytes | (offsetBytes << 4));
		for(let i = 0; i < lengthBytes; i++) {
			out.push(Number((length >> BigInt(8 * i)) & 0xffn));
		}
		let unsigned = delta < 0n ? (1n << BigInt(8 * offsetBytes)) + delta : delta;
		for(let i = 0; i < offsetBytes; i++) {
			out.push(Number((unsigned >> BigInt(8 * i)) & 0xffn));
		}
	}
	out.push(0);
	return Buffer.from(out);
}

function encodeAttribute(a: Attr): Buffer {
	let name = a.name ? Buffer.from(a.name, 'utf16le') : Buffer.alloc(0);
	if(a.resident) {
		let headerLength = 0x18;
		let nameOffset = headerLength;
		let valueOffset = (nameOffset + name.length + 7) & ~7;
		let h = Buffer.alloc(valueOffset);
		h.writeUInt32LE(a.type, 0);
		h[8] = 0;
		h[9] = name.length / 2;
		h.writeUInt16LE(nameOffset, 10);
		h.writeUInt16LE(a.flags || 0, 12);
		h.writeUInt16LE(a.id || 0, 14);
		h.writeUInt32LE(a.resident.length, 0x10);
		h.writeUInt16LE(valueOffset, 0x14);
		name.copy(h, nameOffset);
		let all = pad8(Buffer.concat([ h, a.resident ]));
		all.writeUInt32LE(all.length, 4);
		return all;
	}

	let nr = a.nonResident!;
	let compressed = !!nr.compressionUnitLog2;
	let headerLength = compressed ? 0x48 : 0x40;
	let nameOffset = headerLength;
	let runsOffset = (nameOffset + name.length + 7) & ~7;
	let runs = encodeRuns(nr.runs);
	let totalClusters = nr.runs.reduce((s, r) => s + r.clusterCount, 0);
	let h = Buffer.alloc(runsOffset);
	h.writeUInt32LE(a.type, 0);
	h[8] = 1;
	h[9] = name.length / 2;
	h.writeUInt16LE(nameOffset, 10);
	h.writeUInt16LE(a.flags || 0, 12);
	h.writeUInt16LE(a.id || 0, 14);
	let startVcn = nr.startVcn || 0;
	h.writeBigUInt64LE(BigInt(startVcn), 0x10);
	h.writeBigInt64LE(BigInt(nr.lastVcn ?? startVcn + totalClusters - 1), 0x18);
	h.writeUInt16LE(runsOffset, 0x20);
	h.writeUInt16LE(nr.compressionUnitLog2 || 0, 0x22);
	let allocated = nr.allocatedSize ?? totalClusters * CLUSTER;
	h.writeBigUInt64LE(BigInt(allocated), 0x28);
	h.writeBigUInt64LE(BigInt(nr.dataSize), 0x30);
	h.writeBigUInt64LE(BigInt(nr.dataSize), 0x38);
	name.copy(h, nameOffset);
	let all = pad8(Buffer.concat([ h, runs ]));
	all.writeUInt32LE(all.length, 4);
	return all;
}

/** Applies the update sequence (the last 2 bytes of every 512-byte sector move to an array) */
function protect(record: Buffer, usaOffset: number) {
	let sectors = record.length / 512;
	record.writeUInt16LE(usaOffset, 4);
	record.writeUInt16LE(sectors + 1, 6);
	let checkValue = 0x0001;
	record.writeUInt16LE(checkValue, usaOffset);
	for(let i = 1; i <= sectors; i++) {
		let end = i * 512 - 2;
		record.writeUInt16LE(record.readUInt16LE(end), usaOffset + i * 2);
		record.writeUInt16LE(checkValue, end);
	}
}

function mftRecord(number: number, attrs: Attr[], opts: { directory?: boolean; baseRecord?: number; links?: number; unused?: boolean } = {}): Buffer {
	let r = Buffer.alloc(RECORD_SIZE);
	r.write('FILE', 0, 'latin1');
	r.writeUInt16LE(1, 0x10); // sequence
	r.writeUInt16LE(opts.links ?? 1, 0x12);
	let first = 0x38;
	r.writeUInt16LE(first, 0x14);
	r.writeUInt16LE((opts.unused ? 0 : 1) | (opts.directory ? 2 : 0), 0x16);
	r.writeUInt32LE(RECORD_SIZE, 0x1c);
	r.writeBigUInt64LE(opts.baseRecord ? BigInt(opts.baseRecord) | (1n << 48n) : 0n, 0x20);
	r.writeUInt32LE(number, 0x2c);

	let pos = first;
	attrs.forEach((a, i) => {
		let enc = encodeAttribute({ ...a, id: a.id ?? i });
		if(pos + enc.length + 8 > RECORD_SIZE - 2) {
			throw new Error('MFT record ' + number + ' is full');
		}
		enc.copy(r, pos);
		pos += enc.length;
	});
	r.writeUInt32LE(0xffffffff, pos);
	pos += 8;
	r.writeUInt32LE(pos, 0x18);
	r.writeUInt16LE(attrs.length, 0x28);
	protect(r, 0x30);
	return r;
}

function standardInformation(mtime: Date, attributes: number): Buffer {
	let b = Buffer.alloc(0x48);
	let t = filetime(mtime);
	b.writeBigUInt64LE(t, 0);
	b.writeBigUInt64LE(t, 8);
	b.writeBigUInt64LE(t, 0x10);
	b.writeBigUInt64LE(t, 0x18);
	b.writeUInt32LE(attributes, 0x20);
	return b;
}

function fileName(parent: number, name: string, size: number, directory: boolean, mtime: Date, namespace = 3): Buffer {
	let n = Buffer.from(name, 'utf16le');
	let b = Buffer.alloc(0x42 + n.length);
	b.writeBigUInt64LE(BigInt(parent) | (1n << 48n), 0);
	let t = filetime(mtime);
	for(let o of [ 8, 0x10, 0x18, 0x20 ]) {
		b.writeBigUInt64LE(t, o);
	}
	b.writeBigUInt64LE(BigInt(size), 0x28);
	b.writeBigUInt64LE(BigInt(size), 0x30);
	b.writeUInt32LE(directory ? 0x10000000 : 0x20, 0x38);
	b[0x40] = name.length;
	b[0x41] = namespace;
	n.copy(b, 0x42);
	return b;
}

interface IndexKey { record: number; key: Buffer; upper: string }

function indexEntry(k: IndexKey | null, subnodeVcn?: number): Buffer {
	let key = k ? k.key : Buffer.alloc(0);
	let length = 0x10 + ((key.length + 7) & ~7) + (subnodeVcn !== undefined ? 8 : 0);
	let b = Buffer.alloc(length);
	if(k) {
		b.writeBigUInt64LE(BigInt(k.record) | (1n << 48n), 0);
	}
	b.writeUInt16LE(length, 8);
	b.writeUInt16LE(key.length, 10);
	b.writeUInt16LE((k ? 0 : 2) | (subnodeVcn !== undefined ? 1 : 0), 12);
	key.copy(b, 0x10);
	if(subnodeVcn !== undefined) {
		b.writeBigUInt64LE(BigInt(subnodeVcn), length - 8);
	}
	return b;
}

function nodeHeader(entries: Buffer, entriesOffset: number, allocated: number, hasSubnodes: boolean): Buffer {
	let h = Buffer.alloc(16);
	h.writeUInt32LE(entriesOffset, 0);
	h.writeUInt32LE(entriesOffset + entries.length, 4);
	h.writeUInt32LE(allocated, 8);
	h[12] = hasSubnodes ? 1 : 0;
	return h;
}


class Allocator {
	next: number;
	constructor(first: number) {
		this.next = first;
	}
	take(clusters: number): number {
		let at = this.next;
		this.next += clusters;
		return at;
	}
}

/**
 * Writes an NTFS image holding 'entries'. Folders are created for parents that aren't listed.
 */
export function buildNtfsImage(entries: NtfsFixtureEntry[], opts: NtfsFixtureOptions = {}): Buffer {
	let mtimeDefault = new Date('2024-01-02T03:04:05Z');
	let upcaseTable = Buffer.alloc(131072);
	for(let i = 0; i < 65536; i++) {
		let u = String.fromCharCode(i).toUpperCase();
		upcaseTable.writeUInt16LE(u.length === 1 ? u.charCodeAt(0) : i, i * 2);
	}
	let upper = (s: string) => Array.from(s).map((c) => String.fromCharCode(upcaseTable.readUInt16LE(c.charCodeAt(0) * 2))).join('');

	// Every folder and file, parents first; records from 16 (24+ for extension records)
	interface Node { entry: NtfsFixtureEntry; record: number; parent: number; name: string; children: Node[] }
	let nodes = new Map<string, Node>();
	let root: Node = { entry: { path: '/', kind: 'directory' }, record: 5, parent: 5, name: '.', children: [] };
	nodes.set('/', root);
	let nextRecord = 24;
	let ensure = (path: string, entry?: NtfsFixtureEntry): Node => {
		let existing = nodes.get(path.toLowerCase());
		if(existing) {
			if(entry) {
				existing.entry = entry;
			}
			return existing;
		}
		let parts = path.split('/').filter(Boolean);
		let parent = ensure('/' + parts.slice(0, -1).join('/'));
		let node: Node = { entry: entry || { path, kind: 'directory' }, record: nextRecord++, parent: parent.record, name: parts[parts.length - 1], children: [] };
		if(node.entry.useAttributeList) {
			nextRecord += 2; // two extension records follow
		}
		parent.children.push(node);
		nodes.set(path.toLowerCase(), node);
		return node;
	};
	for(let e of entries) {
		ensure(e.path, e);
	}

	let recordCount = nextRecord + 2;
	let mftClusters = Math.ceil(recordCount * RECORD_SIZE / CLUSTER);
	let alloc = new Allocator(MFT_LCN + mftClusters + 1);
	let records = new Map<number, Buffer>();
	let dataWrites: Array<{ lcn: number; data: Buffer }> = [];

	let storeContiguous = (data: Buffer): Run[] => {
		let clusters = Math.ceil(data.length / CLUSTER);
		if(clusters === 0) {
			return [];
		}
		let lcn = alloc.take(clusters);
		dataWrites.push({ lcn, data });
		return [ { lcn, clusterCount: clusters } ];
	};

	let storeFragmented = (data: Buffer): Run[] => {
		let clusters = Math.ceil(data.length / CLUSTER);
		let pieces = Math.min(3, clusters);
		let runs: Run[] = [];
		let done = 0;
		for(let p = 0; p < pieces; p++) {
			let count = p === pieces - 1 ? clusters - done : Math.ceil(clusters / pieces);
			let lcn = alloc.take(count);
			alloc.take(2); // gap, used by nothing
			dataWrites.push({ lcn, data: data.subarray(done * CLUSTER, (done + count) * CLUSTER) });
			runs.push({ lcn, clusterCount: count });
			done += count;
		}
		// Put the second piece before the first on disk too (negative run offsets)
		return runs;
	};

	let dataAttribute = (node: Node): Attr[] => {
		let e = node.entry;
		let data = e.data || Buffer.alloc(0);
		let attrs: Attr[] = [];

		if(e.wofAlgorithm !== undefined) {
			let chunkSize = ({ 0: 4096, 1: 32768, 2: 8192, 3: 16384 } as any)[e.wofAlgorithm];
			let chunks: Buffer[] = [];
			for(let off = 0; off < data.length; off += chunkSize) {
				let raw = data.subarray(off, off + chunkSize);
				let c = xpressHuffmanCompress(raw);
				chunks.push(c.length < raw.length ? c : raw);
			}
			let table: Buffer[] = [];
			let at = 0;
			for(let i = 0; i < chunks.length - 1; i++) {
				at += chunks[i].length;
				table.push(u32(at));
			}
			let wofData = Buffer.concat([ ...table, ...chunks ]);
			let reparse = Buffer.concat([ u32(0x80000017), u16(16), u16(0), u32(1), u32(2), u32(1), u32(e.wofAlgorithm) ]);
			let clusters = Math.ceil(data.length / CLUSTER);
			attrs.push({ type: 0x80, flags: 0x8000, nonResident: { runs: clusters ? [ { lcn: -1, clusterCount: clusters } ] : [], dataSize: data.length, allocatedSize: 0 } });
			attrs.push({ type: 0xc0, resident: reparse });
			attrs.push({ type: 0x80, name: 'WofCompressedData', nonResident: { runs: storeContiguous(wofData), dataSize: wofData.length } });
			return attrs;
		}

		if(e.compressed) {
			let unit = 16 * CLUSTER;
			let runs: Run[] = [];
			for(let off = 0; off < Math.max(data.length, 1); off += unit) {
				let raw = Buffer.alloc(unit);
				data.copy(raw, 0, off, Math.min(off + unit, data.length));
				if(raw.every((b) => b === 0)) {
					runs.push({ lcn: -1, clusterCount: 16 });
					continue;
				}
				let c = lznt1Compress(raw);
				let clusters = Math.ceil(c.length / CLUSTER);
				if(clusters < 16) {
					runs.push(...storeContiguous(c), { lcn: -1, clusterCount: 16 - clusters });
				}
				else {
					runs.push(...storeContiguous(raw));
				}
			}
			attrs.push({ type: 0x80, flags: 0x0001, nonResident: { runs, dataSize: data.length, compressionUnitLog2: 4, allocatedSize: runs.reduce((s, r) => s + r.clusterCount, 0) * CLUSTER } });
			return attrs;
		}

		if(data.length <= 400 && !e.fragmented && !e.useAttributeList && !e.sparseLeadingClusters) {
			attrs.push({ type: 0x80, resident: data });
			return attrs;
		}

		let runs: Run[] = [];
		let body = data;
		if(e.sparseLeadingClusters) {
			runs.push({ lcn: -1, clusterCount: e.sparseLeadingClusters });
			body = data.subarray(e.sparseLeadingClusters * CLUSTER);
		}
		runs.push(...(e.fragmented || e.useAttributeList ? storeFragmented(body) : storeContiguous(body)));
		attrs.push({ type: 0x80, nonResident: { runs, dataSize: data.length } });
		return attrs;
	};

	// Folder indexes
	let indexAttributes = (node: Node): Attr[] => {
		let keys: IndexKey[] = node.children.flatMap((c) => {
			let size = c.entry.data ? c.entry.data.length : 0;
			let dir = c.entry.kind === 'directory';
			let list = [ { record: c.record, key: fileName(node.record, c.name, size, dir, c.entry.mtime || mtimeDefault), upper: upper(c.name) } ];
			return list;
		});
		for(let other of nodes.values()) {
			if(other.entry.hardLinkIn && nodes.get(other.entry.hardLinkIn.toLowerCase()) === node) {
				let linkName = 'link to ' + other.name;
				keys.push({ record: other.record, key: fileName(node.record, linkName, other.entry.data?.length || 0, false, mtimeDefault), upper: upper(linkName) });
			}
		}
		if(node === root) {
			for(let [ rec, name ] of [ [ 0, '$MFT' ], [ 3, '$Volume' ], [ 10, '$UpCase' ], [ 5, '.' ] ] as Array<[number, string]>) {
				keys.push({ record: rec, key: fileName(5, name, 0, rec === 5, mtimeDefault), upper: upper(name) });
			}
		}
		keys.sort((a, b) => (a.upper < b.upper ? -1 : a.upper > b.upper ? 1 : 0));

		let rootEntries = (entryBuffers: Buffer[]) => Buffer.concat(entryBuffers);
		let all = keys.map((k) => indexEntry(k));
		let small = Buffer.concat(all).length + 0x10 < 600;

		if(small) {
			let entriesBuf = rootEntries([ ...all, indexEntry(null) ]);
			let value = Buffer.concat([ u32(0x30), u32(1), u32(INDEX_BLOCK_SIZE), Buffer.from([ 1, 0, 0, 0 ]), nodeHeader(entriesBuf, 0x10, 0x10 + entriesBuf.length, false), entriesBuf ]);
			return [ { type: 0x90, name: '$I30', resident: value } ];
		}

		// Leaves of at most ~3 KB, separated by keys kept in the root
		let leaves: IndexKey[][] = [ [] ];
		let separators: IndexKey[] = [];
		let used = 0;
		for(let k of keys) {
			let size = indexEntry(k).length;
			if(used + size > 3900 && leaves[leaves.length - 1].length > 0) {
				separators.push(k);
				leaves.push([]);
				used = 0;
				continue;
			}
			leaves[leaves.length - 1].push(k);
			used += size;
		}

		let blockVcn = (i: number) => i; // one cluster per index block
		let blocks = leaves.map((leaf, i) => {
			let block = Buffer.alloc(INDEX_BLOCK_SIZE);
			block.write('INDX', 0, 'latin1');
			block.writeBigUInt64LE(BigInt(blockVcn(i)), 0x10);
			let entriesOffset = 0x28 + 2 * (INDEX_BLOCK_SIZE / 512 + 1);
			entriesOffset = ((entriesOffset + 7) & ~7) - 0x18;
			let entriesBuf = Buffer.concat([ ...leaf.map((k) => indexEntry(k)), indexEntry(null) ]);
			nodeHeader(entriesBuf, entriesOffset, INDEX_BLOCK_SIZE - 0x18, false).copy(block, 0x18);
			entriesBuf.copy(block, 0x18 + entriesOffset);
			protect(block, 0x28);
			return block;
		});

		let rootBuf = Buffer.concat([ ...separators.map((k, i) => indexEntry(k, blockVcn(i))), indexEntry(null, blockVcn(leaves.length - 1)) ]);
		let value = Buffer.concat([ u32(0x30), u32(1), u32(INDEX_BLOCK_SIZE), Buffer.from([ 1, 0, 0, 0 ]), nodeHeader(rootBuf, 0x10, 0x10 + rootBuf.length, true), rootBuf ]);
		let allocation = Buffer.concat(blocks);
		return [
			{ type: 0x90, name: '$I30', resident: value },
			{ type: 0xa0, name: '$I30', nonResident: { runs: storeContiguous(allocation), dataSize: allocation.length } },
			{ type: 0xb0, name: '$I30', resident: Buffer.alloc(8, 0xff) },
		];
	};

	for(let node of nodes.values()) {
		let e = node.entry;
		let mtime = e.mtime || mtimeDefault;
		let isDir = e.kind === 'directory';
		let size = e.data ? e.data.length : 0;
		let si: Attr = { type: 0x10, resident: standardInformation(mtime, isDir ? 0x10 : 0x20) };
		let fn: Attr = { type: 0x30, resident: fileName(node.parent, node.name, size, isDir, mtime) };

		if(isDir) {
			records.set(node.record, mftRecord(node.record, [ si, fn, ...indexAttributes(node) ], { directory: true }));
			continue;
		}

		let data = dataAttribute(node);
		let streams: Attr[] = Object.entries(e.streams || {}).map(([ name, value ]) => ({ type: 0x80, name, resident: value }));
		let links = e.hardLinkIn ? 2 : 1;
		let names = [ fn ];
		if(e.hardLinkIn) {
			let linkParent = nodes.get(e.hardLinkIn.toLowerCase())!;
			names.push({ type: 0x30, resident: fileName(linkParent.record, 'link to ' + node.name, size, false, mtime, 1) });
		}

		if(e.useAttributeList) {
			// $DATA split into two extents, each in its own extension record
			let runs = data[0].nonResident!.runs;
			let firstRuns = runs.slice(0, 1);
			let firstClusters = firstRuns.reduce((s, r) => s + r.clusterCount, 0);
			let totalClusters = runs.reduce((s, r) => s + r.clusterCount, 0);
			let ext1 = node.record + 1;
			let ext2 = node.record + 2;
			let extent1: Attr = { type: 0x80, id: 7, nonResident: { runs: firstRuns, dataSize: size, startVcn: 0, lastVcn: firstClusters - 1, allocatedSize: totalClusters * CLUSTER } };
			let extent2: Attr = { type: 0x80, id: 8, nonResident: { runs: runs.slice(1), dataSize: 0, startVcn: firstClusters, lastVcn: totalClusters - 1, allocatedSize: 0 } };
			// Runs in the second extent start their LCN deltas from 0 again
			records.set(ext1, mftRecord(ext1, [ extent1 ], { baseRecord: node.record }));
			records.set(ext2, mftRecord(ext2, [ extent2 ], { baseRecord: node.record }));

			let listEntry = (type: number, startVcn: number, record: number, id: number) => {
				let b = Buffer.alloc(0x20);
				b.writeUInt32LE(type, 0);
				b.writeUInt16LE(0x20, 4);
				b[7] = 0x1a;
				b.writeBigUInt64LE(BigInt(startVcn), 8);
				b.writeBigUInt64LE(BigInt(record) | (1n << 48n), 0x10);
				b.writeUInt16LE(id, 0x18);
				return b;
			};
			let list = Buffer.concat([
				listEntry(0x10, 0, node.record, 0), listEntry(0x30, 0, node.record, 2),
				listEntry(0x80, 0, ext1, 7), listEntry(0x80, firstClusters, ext2, 8)
			]);
			records.set(node.record, mftRecord(node.record, [ si, { type: 0x20, resident: list, id: 1 }, { ...fn, id: 2 } ], { links }));
			continue;
		}

		records.set(node.record, mftRecord(node.record, [ si, ...names, ...data, ...streams ], { links }));
	}

	// NTFS's own files
	let mftBytes = recordCount * RECORD_SIZE;
	let upcaseRuns = storeContiguous(upcaseTable);
	records.set(0, mftRecord(0, [
		{ type: 0x10, resident: standardInformation(mtimeDefault, 6) },
		{ type: 0x30, resident: fileName(5, '$MFT', mftBytes, false, mtimeDefault) },
		{ type: 0x80, nonResident: { runs: [ { lcn: MFT_LCN, clusterCount: mftClusters } ], dataSize: mftBytes } },
	]));
	records.set(3, mftRecord(3, [
		{ type: 0x10, resident: standardInformation(mtimeDefault, 6) },
		{ type: 0x30, resident: fileName(5, '$Volume', 0, false, mtimeDefault) },
		{ type: 0x60, resident: Buffer.from(opts.label ?? 'Test volume', 'utf16le') },
	]));
	records.set(10, mftRecord(10, [
		{ type: 0x10, resident: standardInformation(mtimeDefault, 6) },
		{ type: 0x30, resident: fileName(5, '$UpCase', 131072, false, mtimeDefault) },
		{ type: 0x80, nonResident: { runs: upcaseRuns, dataSize: 131072 } },
	]));

	let totalClusters = Math.max(alloc.next + 1, Math.ceil((opts.size || 0) / CLUSTER));
	let image = Buffer.alloc(totalClusters * CLUSTER);

	// Boot sector
	image.write('NTFS    ', 3, 'latin1');
	image.writeUInt16LE(512, 0x0b);
	image[0x0d] = CLUSTER / 512;
	image[0x15] = 0xf8;
	image.writeBigUInt64LE(BigInt(totalClusters * CLUSTER / 512 - 1), 0x28);
	image.writeBigUInt64LE(BigInt(MFT_LCN), 0x30);
	image.writeBigUInt64LE(BigInt(MFT_LCN + mftClusters), 0x38);
	image[0x40] = 0xf6; // 2^10 = 1024-byte records
	image[0x44] = 1;    // one cluster per index block
	image[510] = 0x55;
	image[511] = 0xaa;

	for(let [ n, rec ] of records) {
		rec.copy(image, MFT_LCN * CLUSTER + n * RECORD_SIZE);
	}
	for(let w of dataWrites) {
		w.data.copy(image, w.lcn * CLUSTER);
	}
	return image;
}
