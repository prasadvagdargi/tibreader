/**
 * Builds small FAT32 volume images (512-byte sectors and clusters) following doc/Format-FAT32.md.
 */

export interface FatFixtureEntry {
	path: string; /**< e.g. "/EFI/Boot/bootx64.efi" */
	kind: 'file' | 'folder';
	data?: Buffer;
	mtime?: Date;
}

export interface FatFixtureOptions {
	/** Volume label entry in the root folder */
	label?: string;
	/** Store this file's clusters with a gap after each one (fragmented) */
	fragment?: string;
	/** Put a deleted entry (0xE5) before the entries of the root folder */
	deletedEntry?: boolean;
	/** Make this file's chain end in a free cluster (a broken chain) */
	breakChainOf?: string;
}

const SECTOR = 512;
const CLUSTER = 512;
const RESERVED_SECTORS = 32;
const FAT_COUNT = 2;
const CLUSTER_COUNT = 4096;
const ROOT_CLUSTER = 2;
const END_OF_CHAIN = 0x0fffffff;

interface Node {
	name: string;
	path: string;
	kind: 'file' | 'folder';
	data: Buffer;
	mtime: Date;
	children: Node[];
	firstCluster: number;
}

function parentPathOf(path: string) {
	let parts = path.split('/').filter(Boolean);
	return '/' + parts.slice(0, -1).join('/');
}

function dosDate(d: Date) {
	return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
}

function dosTime(d: Date) {
	return (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
}

function checksum(raw: Buffer) {
	let sum = 0;
	for(let i = 0; i < 11; i++) {
		sum = (((sum & 1) << 7) + (sum >> 1) + raw[i]) & 0xff;
	}
	return sum;
}

/** 8.3 name bytes, lowercase flags, and the long name entries the name needs (none if it fits 8.3) */
function nameEntries(name: string, usedShortNames: Set<string>): { raw: Buffer; caseFlags: number; longEntries: Buffer[] } {
	let dot = name.lastIndexOf('.');
	let base = dot > 0 ? name.slice(0, dot) : name;
	let ext = dot > 0 ? name.slice(dot + 1) : '';
	let fits = /^[A-Za-z0-9_$~!#%&'()@^`{}-]{1,8}$/.test(base) && /^[A-Za-z0-9_$~!#%&'()@^`{}-]{0,3}$/.test(ext);
	let oneCase = (s: string) => s === s.toUpperCase() || s === s.toLowerCase();
	if(fits && oneCase(base) && oneCase(ext)) {
		let raw = Buffer.from(base.toUpperCase().padEnd(8) + ext.toUpperCase().padEnd(3), 'latin1');
		let caseFlags = (base !== base.toUpperCase() ? 0x08 : 0) | (ext !== ext.toUpperCase() ? 0x10 : 0);
		usedShortNames.add(raw.toString('latin1'));
		return { raw, caseFlags, longEntries: [] };
	}

	let stem = base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'FILE';
	let shortExt = ext.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
	let raw = Buffer.alloc(11);
	for(let n = 1; ; n++) {
		raw = Buffer.from((stem + '~' + n).padEnd(8) + shortExt.padEnd(3), 'latin1');
		if(!usedShortNames.has(raw.toString('latin1'))) {
			break;
		}
	}
	usedShortNames.add(raw.toString('latin1'));

	let units: number[] = Array.from(name, (c) => c.charCodeAt(0));
	if(units.length % 13 !== 0) {
		units.push(0);
	}
	while(units.length % 13 !== 0) {
		units.push(0xffff);
	}
	let count = units.length / 13;
	let sum = checksum(raw);
	let longEntries: Buffer[] = [];
	for(let seq = count; seq >= 1; seq--) {
		let e = Buffer.alloc(32);
		e[0] = seq | (seq === count ? 0x40 : 0);
		e[11] = 0x0f;
		e[13] = sum;
		let part = units.slice((seq - 1) * 13, seq * 13);
		part.slice(0, 5).forEach((u, i) => e.writeUInt16LE(u, 1 + i * 2));
		part.slice(5, 11).forEach((u, i) => e.writeUInt16LE(u, 14 + i * 2));
		part.slice(11, 13).forEach((u, i) => e.writeUInt16LE(u, 28 + i * 2));
		longEntries.push(e);
	}
	return { raw, caseFlags: 0, longEntries };
}

function shortEntry(raw: Buffer, attributes: number, firstCluster: number, size: number, mtime: Date, caseFlags = 0) {
	let e = Buffer.alloc(32);
	raw.copy(e, 0);
	e[11] = attributes;
	e[12] = caseFlags;
	e.writeUInt16LE(dosTime(mtime), 14);
	e.writeUInt16LE(dosDate(mtime), 16);
	e.writeUInt16LE(dosDate(mtime), 18);
	e.writeUInt16LE(firstCluster >>> 16, 20);
	e.writeUInt16LE(dosTime(mtime), 22);
	e.writeUInt16LE(dosDate(mtime), 24);
	e.writeUInt16LE(firstCluster & 0xffff, 26);
	e.writeUInt32LE(size, 28);
	return e;
}

export function buildFat32Image(entries: FatFixtureEntry[], opts: FatFixtureOptions = {}): Buffer {
	let defaultTime = new Date(2024, 4, 6, 10, 20, 30);
	let root: Node = { name: '', path: '/', kind: 'folder', data: Buffer.alloc(0), mtime: defaultTime, children: [], firstCluster: ROOT_CLUSTER };
	let byPath = new Map<string, Node>([ [ '/', root ] ]);
	for(let e of entries) {
		let parts = e.path.split('/').filter(Boolean);
		let parent = byPath.get(parentPathOf(e.path));
		if(!parent) {
			throw new Error('Parent folder must be listed before ' + e.path);
		}
		let node: Node = { name: parts[parts.length - 1], path: e.path, kind: e.kind, data: e.data || Buffer.alloc(0), mtime: e.mtime || defaultTime, children: [], firstCluster: 0 };
		parent.children.push(node);
		byPath.set(e.path, node);
	}

	let fat = new Uint32Array(CLUSTER_COUNT + 2);
	fat[0] = 0x0ffffff8;
	fat[1] = END_OF_CHAIN;
	let next = ROOT_CLUSTER + 1;
	let allocate = (clusters: number, gaps: boolean): number[] => {
		let list: number[] = [];
		for(let i = 0; i < clusters; i++) {
			list.push(next);
			next += gaps ? 2 : 1;
		}
		for(let i = 0; i < list.length; i++) {
			fat[list[i]] = i + 1 < list.length ? list[i + 1] : END_OF_CHAIN;
		}
		return list;
	};
	let data = Buffer.alloc(CLUSTER_COUNT * CLUSTER);
	let writeClusters = (clusters: number[], bytes: Buffer) => {
		clusters.forEach((c, i) => bytes.copy(data, (c - ROOT_CLUSTER) * CLUSTER, i * CLUSTER, (i + 1) * CLUSTER));
	};

	// Files first, then folders bottom-up (a folder's entries need its children's clusters)
	let all = Array.from(byPath.values()).filter((n) => n !== root);
	for(let n of all.filter((n) => n.kind === 'file' && n.data.length > 0)) {
		let clusters = allocate(Math.ceil(n.data.length / CLUSTER), opts.fragment === n.path);
		n.firstCluster = clusters[0];
		writeClusters(clusters, n.data);
		if(opts.breakChainOf === n.path) {
			fat[clusters[0]] = 0; // points to a free cluster
		}
	}

	let folderBytes = (folder: Node, parentCluster: number): Buffer => {
		let used = new Set<string>();
		let parts: Buffer[] = [];
		if(folder === root) {
			if(opts.label) {
				parts.push(shortEntry(Buffer.from(opts.label.toUpperCase().padEnd(11).slice(0, 11), 'latin1'), 0x08, 0, 0, defaultTime));
			}
			if(opts.deletedEntry) {
				let gone = shortEntry(Buffer.from('GONE    TXT', 'latin1'), 0x20, 0, 5, defaultTime);
				gone[0] = 0xe5;
				parts.push(gone);
			}
		}
		else {
			parts.push(shortEntry(Buffer.from('.          ', 'latin1'), 0x10, folder.firstCluster, 0, folder.mtime));
			parts.push(shortEntry(Buffer.from('..         ', 'latin1'), 0x10, parentCluster === ROOT_CLUSTER ? 0 : parentCluster, 0, folder.mtime));
		}
		for(let c of folder.children) {
			let { raw, caseFlags, longEntries } = nameEntries(c.name, used);
			parts.push(...longEntries, shortEntry(raw, c.kind === 'folder' ? 0x10 : 0x20, c.firstCluster, c.kind === 'file' ? c.data.length : 0, c.mtime, caseFlags));
		}
		return Buffer.concat(parts);
	};

	let depth = (n: Node) => n.path.split('/').filter(Boolean).length;
	let folders = all.filter((n) => n.kind === 'folder').sort((a, b) => depth(b) - depth(a));
	// Folder clusters are allocated before their content is known: size them from their children first
	let parentOf = (n: Node) => byPath.get(parentPathOf(n.path))!;
	let folderClusters = new Map<Node, number[]>();
	for(let f of folders) {
		let size = folderBytes(f, 0).length + 32; // room for the end marker
		let clusters = allocate(Math.ceil(size / CLUSTER), false);
		f.firstCluster = clusters[0];
		folderClusters.set(f, clusters);
	}
	for(let f of folders) {
		writeClusters(folderClusters.get(f)!, folderBytes(f, parentOf(f).firstCluster));
	}
	let rootBytes = folderBytes(root, 0);
	let rootClusters = [ ROOT_CLUSTER ].concat(rootBytes.length + 32 > CLUSTER ? allocate(Math.ceil((rootBytes.length + 32) / CLUSTER) - 1, false) : []);
	fat[ROOT_CLUSTER] = rootClusters.length > 1 ? rootClusters[1] : END_OF_CHAIN;
	writeClusters(rootClusters, rootBytes);
	if(next > CLUSTER_COUNT + 2) {
		throw new Error('FAT32 fixture is full');
	}

	let fatSectors = Math.ceil(fat.length * 4 / SECTOR);
	let totalSectors = RESERVED_SECTORS + FAT_COUNT * fatSectors + CLUSTER_COUNT;
	let boot = Buffer.alloc(SECTOR);
	boot.set([ 0xeb, 0x58, 0x90 ], 0);
	boot.write('MSDOS5.0', 3, 'latin1');
	boot.writeUInt16LE(SECTOR, 11);
	boot[13] = CLUSTER / SECTOR;
	boot.writeUInt16LE(RESERVED_SECTORS, 14);
	boot[16] = FAT_COUNT;
	boot[21] = 0xf8;
	boot.writeUInt32LE(totalSectors, 32);
	boot.writeUInt32LE(fatSectors, 36);
	boot.writeUInt32LE(ROOT_CLUSTER, 44);
	boot.write((opts.label || 'NO NAME').toUpperCase().padEnd(11).slice(0, 11), 71, 'latin1');
	boot.write('FAT32   ', 82, 'latin1');
	boot[510] = 0x55;
	boot[511] = 0xaa;

	let fatBytes = Buffer.alloc(fatSectors * SECTOR);
	fat.forEach((v, i) => fatBytes.writeUInt32LE(v, i * 4));
	let reserved = Buffer.alloc(RESERVED_SECTORS * SECTOR);
	boot.copy(reserved, 0);
	return Buffer.concat([ reserved, fatBytes, fatBytes, data ]);
}
