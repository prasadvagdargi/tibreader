import { FsEntry, SnapshotFS } from '../fs/types';
import { joinPath, splitPath } from '../fs/tree';
import { LRUCache } from '../cache';
import { warn } from '../log';
import { FileStream, FIRST_USER_RECORD, IndexEntry, MftRecord, NtfsVolume, ROOT_RECORD } from './volume';
import { DiskImage } from '../disk/image';
import { registerVolumeOpener } from '../disk/fs';


interface FolderListing {
	entries: IndexEntry[];
	byUppercaseName: Map<string, IndexEntry>;
}

/**
 * Files and folders of an NTFS volume. NTFS's own files ($MFT, $Bitmap, ...) are hidden; names match
 * case-insensitively, like on Windows. Alternate data streams aren't listed (see streamsOf/readStream).
 */
export class NtfsFS implements SnapshotFS {

	private _folders = new LRUCache<number, FolderListing>(256, () => 1);
	private _streams = new LRUCache<number, FileStream | null>(256, () => 1);
	private _pathToRecord = new LRUCache<string, { record: number; storedPath: string }>(16384, () => 1);

	constructor(readonly volume: NtfsVolume, private _upcase: Uint16Array, private _fallbackTime: Date) {}

	static async open(image: DiskImage, fallbackTime = new Date(0)): Promise<NtfsFS> {
		let volume = await NtfsVolume.open(image);
		return new NtfsFS(volume, await volume.upcaseTable(), fallbackTime);
	}

	private uppercase(name: string): string {
		let codes = new Array<number>(name.length);
		for(let i = 0; i < name.length; i++) {
			codes[i] = this._upcase[name.charCodeAt(i)];
		}
		return String.fromCharCode(...codes);
	}

	private async folder(record: MftRecord): Promise<FolderListing> {
		let cached = this._folders.get(record.number);
		if(cached) {
			return cached;
		}

		let byUppercaseName = new Map<string, IndexEntry>();
		let entries: IndexEntry[] = [];
		for(let e of await this.volume.listDirectory(record)) {
			let isOwnMetafile = e.record < FIRST_USER_RECORD && e.record !== ROOT_RECORD;
			if(e.record === record.number || isOwnMetafile) {
				continue;
			}
			let key = this.uppercase(e.name);
			if(byUppercaseName.has(key)) {
				continue; // the same file under a POSIX and a Win32 name differing only in case
			}
			byUppercaseName.set(key, e);
			entries.push(e);
		}

		let listing = { entries, byUppercaseName };
		this._folders.set(record.number, listing);
		return listing;
	}

	/**
	 * The record at a path, and the path with each name as stored on the volume
	 */
	private async resolve(path: string): Promise<{ record: MftRecord; storedPath: string } | undefined> {
		let parts = splitPath(path);
		let key = '/' + parts.map((p) => this.uppercase(p)).join('/');

		let cached = this._pathToRecord.get(key);
		if(cached) {
			let record = await this.volume.record(cached.record);
			return record ? { record, storedPath: cached.storedPath } : undefined;
		}

		let current = await this.volume.record(ROOT_RECORD);
		let storedPath = '/';
		for(let part of parts) {
			if(!current || !current.isDirectory) {
				return undefined;
			}
			let entry = (await this.folder(current)).byUppercaseName.get(this.uppercase(part));
			if(!entry) {
				return undefined;
			}
			storedPath = joinPath(storedPath, entry.name);
			current = await this.volume.record(entry.record);
		}

		if(!current || !current.isInUse) {
			return undefined;
		}
		this._pathToRecord.set(key, { record: current.number, storedPath });
		return { record: current, storedPath };
	}

	private async recordOf(path: string): Promise<MftRecord | undefined> {
		return (await this.resolve(path))?.record;
	}

	private stream(record: MftRecord): FileStream | null {
		let cached = this._streams.get(record.number);
		if(cached !== undefined) {
			return cached;
		}
		let stream = this.volume.fileStream(record);
		this._streams.set(record.number, stream);
		return stream;
	}

	private entryFor(record: MftRecord, name: string, path: string): FsEntry {
		let times = NtfsVolume.times(record);
		let isDirectory = record.isDirectory;
		let size = 0;
		if(!isDirectory) {
			try {
				size = this.stream(record)?.size ?? 0;
			}
			catch(e: any) {
				warn(path + ': ' + e.message);
			}
		}
		return {
			name, path,
			type: isDirectory ? 'directory' : 'file',
			size,
			mtime: times ? times.modified : this._fallbackTime,
			atime: times ? times.accessed : undefined,
		};
	}

	async stat(path: string): Promise<FsEntry | undefined> {
		let found = await this.resolve(path);
		if(!found) {
			return undefined;
		}
		if(found.storedPath === '/') {
			return { ...this.entryFor(found.record, '', '/'), type: 'directory' };
		}
		let name = found.storedPath.slice(found.storedPath.lastIndexOf('/') + 1);
		return this.entryFor(found.record, name, found.storedPath);
	}

	async list(path: string): Promise<FsEntry[] | undefined> {
		let found = await this.resolve(path);
		if(!found || !found.record.isDirectory) {
			return undefined;
		}
		let record = found.record;
		let base = found.storedPath;
		let out: FsEntry[] = [];
		for(let e of (await this.folder(record)).entries) {
			let child = await this.volume.record(e.record);
			if(!child || !child.isInUse) {
				warn('Folder ' + base + ' lists ' + e.name + ', whose MFT record ' + e.record + ' is unused; skipped');
				continue;
			}
			out.push(this.entryFor(child, e.name, joinPath(base, e.name)));
		}
		return out;
	}

	async read(path: string, offset: number, length: number): Promise<Buffer> {
		if(!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
			throw new RangeError('Invalid read range');
		}
		let record = await this.recordOf(path);
		if(!record) {
			throw new Error('No such file: ' + path);
		}
		if(record.isDirectory) {
			throw new Error('Is a folder: ' + path);
		}
		let stream = this.stream(record);
		return stream ? stream.read(offset, length) : Buffer.alloc(0);
	}

	async *walk(path: string = '/'): AsyncIterable<FsEntry> {
		let top = await this.stat(path);
		if(!top) {
			throw new Error('No such file or folder: ' + path);
		}
		let stack: FsEntry[] = [ top ];
		let visitedFolders = new Set<number>();
		while(stack.length > 0) {
			let entry = stack.pop()!;
			yield entry;
			if(entry.type !== 'directory') {
				continue;
			}
			let record = await this.recordOf(entry.path);
			if(!record || visitedFolders.has(record.number)) {
				continue; // a folder reached twice (hard-linked folders don't exist, but be safe)
			}
			visitedFolders.add(record.number);
			let kids = await this.list(entry.path) || [];
			for(let i = kids.length - 1; i >= 0; i--) {
				stack.push(kids[i]);
			}
		}
	}

	/** Names of a file's alternate data streams */
	async streamsOf(path: string): Promise<string[]> {
		let record = await this.recordOf(path);
		return record ? NtfsVolume.streamNames(record) : [];
	}

	/** Reads an alternate data stream ("Zone.Identifier", ...) */
	async readStream(path: string, streamName: string, offset: number, length: number): Promise<Buffer> {
		let record = await this.recordOf(path);
		let stream = record ? this.volume.fileStream(record, streamName) : null;
		if(!stream) {
			throw new Error('No stream ' + streamName + ' on ' + path);
		}
		return stream.read(offset, length);
	}

	/** Windows attributes and times of a file or folder */
	async details(path: string) {
		let record = await this.recordOf(path);
		return record ? NtfsVolume.times(record) : null;
	}
}


registerVolumeOpener(async (image: DiskImage) => {
	if(!(await NtfsVolume.isNtfs(image))) {
		return null;
	}
	let fs = await NtfsFS.open(image);
	return { fs, type: 'NTFS', label: await fs.volume.label() };
});
