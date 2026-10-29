import { FsEntry, SnapshotFS } from '../fs/types';
import { splitPath } from '../fs/tree';
import { DiskImage, SubImage } from './image';
import { Partition, PartitionTable, readPartitionTable } from './partitions';
import { warn } from '../log';


/**
 * A file system found inside a volume image (e.g. NTFS)
 */
export interface VolumeFS {
	fs: SnapshotFS;
	/** File system name, e.g. "NTFS" */
	type: string;
	/** Volume label, if any */
	label?: string;
}

/** Tries to read a file system from a volume image; returns null if it isn't one it knows */
export type VolumeOpener = (image: DiskImage) => Promise<VolumeFS | null>;

const openers: VolumeOpener[] = [];

/**
 * Registers a file system reader (NTFS registers itself when imported)
 */
export function registerVolumeOpener(fn: VolumeOpener) {
	openers.push(fn);
}

export async function openVolume(image: DiskImage): Promise<VolumeFS | null> {
	for(let open of openers) {
		try {
			let v = await open(image);
			if(v) {
				return v;
			}
		}
		catch(e: any) {
			warn('Could not read the file system of a volume: ' + (e && e.message));
		}
	}
	return null;
}


/** One volume (partition) of a disk-image backup, as shown to users */
export interface DiskVolumeInfo {
	/** Folder name of its files (if a file system was recognized) */
	folder?: string;
	/** Name of its raw image file, e.g. "Partition 2.img" */
	imageFile: string;
	size: number;
	/** Offset on the disk, when it comes from a partition table */
	start?: number;
	partition?: Partition;
	fileSystem?: string;
	label?: string;
}

type Item =
	| { kind: 'file'; entry: FsEntry; image: DiskImage }
	| { kind: 'fs'; entry: FsEntry; fs: SnapshotFS };


/**
 * The view of a disk-image backup point: one raw .img file per disk and per volume, plus a folder with
 * each volume's files when its file system can be read.
 *
 *   /Disk.img                 (when the image is a whole disk)
 *   /Partition 2.img
 *   /Partition 2 (Windows)/   (files of an NTFS partition labelled "Windows")
 */
export class DiskFS implements SnapshotFS {

	private _items = new Map<string, Item>();
	private _lower = new Map<string, string>();
	readonly volumes: DiskVolumeInfo[] = [];
	/** Top-level .img files that are whole stored images (not parts of another one) */
	readonly sourceFiles: string[] = [];
	readonly partitionTables: PartitionTable[] = [];

	private constructor(private _mtime: Date) {}

	/**
	 * @param sources the backed-up images; 'name' is used for their files ("Disk", "Volume 1", ...)
	 */
	static async Create(sources: Array<{ name: string; image: DiskImage }>, mtime: Date): Promise<DiskFS> {
		let d = new DiskFS(mtime);
		for(let s of sources) {
			await d.addSource(s.name, s.image, sources.length > 1);
		}
		return d;
	}

	private async addSource(name: string, image: DiskImage, several: boolean) {
		let table = await readPartitionTable(image);
		if(!table) {
			await this.addVolume(name, image);
			this.sourceFiles.push(name + '.img');
			return;
		}

		// A whole disk: "Volume" -> "Disk", "Volume 2" -> "Disk 2"
		name = name.replace(/^Volume\b/, 'Disk');
		this.addFile(name + '.img', image);
		this.sourceFiles.push(name + '.img');
		this.partitionTables.push(table);
		for(let p of table.partitions) {
			let pname = (several ? name + ' - ' : '') + 'Partition ' + p.number;
			await this.addVolume(pname, new SubImage(image, p.start, p.size), p);
		}
	}

	private async addVolume(name: string, image: DiskImage, partition?: Partition) {
		let info: DiskVolumeInfo = { imageFile: name + '.img', size: image.size, partition, start: partition?.start };
		this.addFile(info.imageFile, image);

		let v = await openVolume(image);
		if(v) {
			let folder = name + (v.label ? ' (' + v.label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') + ')' : '');
			info.folder = folder;
			info.fileSystem = v.type;
			info.label = v.label;
			this.add(folder, { kind: 'fs', fs: v.fs, entry: { name: folder, path: '/' + folder, type: 'directory', size: 0, mtime: this._mtime } });
		}

		this.volumes.push(info);
	}

	private addFile(name: string, image: DiskImage) {
		this.add(name, { kind: 'file', image, entry: { name, path: '/' + name, type: 'file', size: image.size, mtime: this._mtime } });
	}

	private add(name: string, item: Item) {
		if(this._items.has(name)) {
			throw new Error('Duplicate name in disk view: ' + name);
		}
		this._items.set(name, item);
		this._lower.set(name.toLowerCase(), name);
	}

	/** The raw image behind a top-level .img file */
	imageOf(path: string): DiskImage | undefined {
		let parts = splitPath(path);
		if(parts.length !== 1) {
			return undefined;
		}
		let item = this.item(parts[0]);
		return item && item.kind === 'file' ? item.image : undefined;
	}

	/** The file system of a volume folder ("/Partition 2 (Windows)") */
	fileSystemOf(folder: string): SnapshotFS | undefined {
		let parts = splitPath(folder);
		let item = parts.length === 1 ? this.item(parts[0]) : undefined;
		return item && item.kind === 'fs' ? item.fs : undefined;
	}

	private item(name: string): Item | undefined {
		let n = this._items.has(name) ? name : this._lower.get(name.toLowerCase());
		return n === undefined ? undefined : this._items.get(n);
	}

	private resolve(path: string): { item?: Item; rest: string[]; root: boolean } {
		let parts = splitPath(path);
		if(parts.length === 0) {
			return { root: true, rest: [] };
		}
		return { item: this.item(parts[0]), rest: parts.slice(1), root: false };
	}

	private rootEntry(): FsEntry {
		return { name: '', path: '/', type: 'directory', size: 0, mtime: this._mtime };
	}

	private static rebase(e: FsEntry, folder: string): FsEntry {
		return { ...e, path: '/' + folder + (e.path === '/' ? '' : e.path), name: e.path === '/' ? folder : e.name };
	}

	async stat(path: string): Promise<FsEntry | undefined> {
		let r = this.resolve(path);
		if(r.root) {
			return this.rootEntry();
		}
		if(!r.item) {
			return undefined;
		}
		if(r.item.kind === 'file') {
			return r.rest.length === 0 ? { ...r.item.entry } : undefined;
		}
		let e = await r.item.fs.stat('/' + r.rest.join('/'));
		return e ? DiskFS.rebase(e, r.item.entry.name) : undefined;
	}

	async list(path: string): Promise<FsEntry[] | undefined> {
		let r = this.resolve(path);
		if(r.root) {
			return Array.from(this._items.values()).map((i) => ({ ...i.entry }));
		}
		if(!r.item || r.item.kind === 'file') {
			return undefined;
		}
		let folder = r.item.entry.name;
		let kids = await r.item.fs.list('/' + r.rest.join('/'));
		return kids ? kids.map((k) => DiskFS.rebase(k, folder)) : undefined;
	}

	async read(path: string, offset: number, length: number): Promise<Buffer> {
		let r = this.resolve(path);
		if(r.root || !r.item) {
			throw new Error(r.root ? 'Is a folder: /' : 'No such file: ' + path);
		}
		if(!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			throw new RangeError('Invalid read range');
		}
		if(r.item.kind === 'file') {
			if(r.rest.length > 0) {
				throw new Error('No such file: ' + path);
			}
			return r.item.image.read(offset, length);
		}
		return r.item.fs.read('/' + r.rest.join('/'), offset, length);
	}

	async *walk(path: string = '/'): AsyncIterable<FsEntry> {
		let r = this.resolve(path);
		if(r.root) {
			yield this.rootEntry();
			for(let item of this._items.values()) {
				yield* this.walkItem(item, []);
			}
			return;
		}
		if(!r.item) {
			throw new Error('No such file or folder: ' + path);
		}
		yield* this.walkItem(r.item, r.rest);
	}

	private async *walkItem(item: Item, rest: string[]): AsyncIterable<FsEntry> {
		if(item.kind === 'file') {
			if(rest.length > 0) {
				throw new Error('No such file or folder: /' + item.entry.name + '/' + rest.join('/'));
			}
			yield { ...item.entry };
			return;
		}
		for await (let e of item.fs.walk('/' + rest.join('/'))) {
			yield DiskFS.rebase(e, item.entry.name);
		}
	}
}
