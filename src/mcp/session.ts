import fs from 'node:fs';
import path from 'node:path';
import { openArchive, Archive, Slice, FsEntry, SnapshotFS } from '../index';


/** Open backups kept at most; the least recently used one is closed first */
const MAX_OPEN_BACKUPS = 8;

interface OpenBackup {
	archive: Archive;
	/** The file's size and modified time when opened, to notice a replaced file */
	signature: string;
}

export interface BackupPointView {
	archive: Archive;
	slice: Slice;
	/** 1 is the oldest */
	backupPointNumber: number;
	fileSystem: SnapshotFS;
	/** Every file and folder of the backup point, parents first (read once, then cached) */
	allEntries(): Promise<FsEntry[]>;
}

/**
 * Keeps backups open between tool calls, and each backup point's file list once it was read
 */
export class BackupSession {

	private open = new Map<string, OpenBackup>();
	private fileSystems = new WeakMap<Slice, Promise<SnapshotFS>>();
	private entryLists = new WeakMap<Slice, Promise<FsEntry[]>>();

	/** Opens a backup (or reuses it); 'password' falls back to TIB_PASSWORD */
	async archive(backupFile: string, password?: string): Promise<Archive> {
		let file = path.resolve(backupFile.replace(/\.tib\.metadata$/i, '.tib'));
		password = password ?? process.env.TIB_PASSWORD;
		let key = file + '\0' + (password ?? '');

		let st = await fs.promises.stat(file).catch(() => null);
		if(!st || !st.isFile()) {
			throw new Error('No such backup file: ' + file);
		}
		let signature = st.size + ':' + st.mtimeMs;

		let cached = this.open.get(key);
		if(cached) {
			this.open.delete(key);
			if(cached.signature === signature) {
				this.open.set(key, cached);
				return cached.archive;
			}
			await cached.archive.close();
		}

		let archive = await openArchive(file, password !== undefined ? { password } : {});
		this.open.set(key, { archive, signature });

		while(this.open.size > MAX_OPEN_BACKUPS) {
			let [ oldestKey, oldest ] = this.open.entries().next().value!;
			this.open.delete(oldestKey);
			await oldest.archive.close();
		}

		return archive;
	}

	/** One backup point of a backup: 1 is the oldest, -1 the newest */
	async backupPoint(backupFile: string, backupPoint = -1, password?: string): Promise<BackupPointView> {
		let archive = await this.archive(backupFile, password);
		let slice = archive.getSlice(backupPoint);

		let fileSystem = await this.fileSystemOf(slice);

		return {
			archive,
			slice,
			backupPointNumber: archive.slices.indexOf(slice) + 1,
			fileSystem,
			allEntries: () => {
				let list = this.entryLists.get(slice);
				if(!list) {
					list = collect(fileSystem.walk('/'));
					this.entryLists.set(slice, list);
					list.catch(() => this.entryLists.delete(slice));
				}
				return list;
			},
		};
	}

	/** A backup point's file system, opened once */
	fileSystemOf(slice: Slice): Promise<SnapshotFS> {
		let fsPromise = this.fileSystems.get(slice);
		if(!fsPromise) {
			fsPromise = slice.openFileSystem();
			this.fileSystems.set(slice, fsPromise);
			fsPromise.catch(() => this.fileSystems.delete(slice));
		}
		return fsPromise;
	}

	async close() {
		for(let { archive } of this.open.values()) {
			await archive.close();
		}
		this.open.clear();
	}
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	let out: T[] = [];
	for await (let item of items) {
		out.push(item);
	}
	return out;
}
