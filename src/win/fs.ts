import { TreeFS, TreeNode, splitPath } from '../fs/tree';
import { LRUCache } from '../cache';
import { NotSupportedError } from '../errors';
import { warn } from '../log';
import { Reader } from '../reader';
import { EntryKind, ListingEntry } from './record';
import { EntryMeta, ReadEntryMeta, WindowsFileContent } from './content';


interface WinNodeData {
	listing: ListingEntry;
	content?: Promise<WindowsFileContent | null>;
}

/**
 * "G:" is shown as "G", because ':' isn't allowed in file names on Windows (or over WebDAV there)
 */
export function displayRootName(name: string) {
	let m = /^([A-Za-z]):$/.exec(name);
	return m ? m[1] : name;
}

/**
 * Files and folders of one Windows backup point. Each backed up drive is a top-level folder ("G", "C", ...).
 */
export class WindowsFS extends TreeFS<WinNodeData> {

	constructor(
		private _reader: Reader, /**< Reader over the whole archive up to this slice */
		listing: ListingEntry[],
		private _cache: LRUCache<number, Buffer>,
		creationTime: Date
	) {
		super(true, creationTime);

		for(let e of listing) {
			let parts: string[];
			try {
				parts = splitPath(e.path);
			}
			catch(err) {
				warn('Skipping listing entry with an unsafe path: ' + JSON.stringify(e.path));
				continue;
			}

			if(parts.length === 0) {
				warn('Skipping listing entry with an empty path');
				continue;
			}

			parts[0] = displayRootName(parts[0]);

			let name = parts[parts.length - 1];
			let parent = this.ensureDir(parts.slice(0, -1), e.mtime);

			// Root (0x83) and folder (0x80) both have the 0x80 bit
			let isDir = (e.kind & EntryKind.Folder) !== 0;

			// Drive roots are stored without a time; show the backup time instead of 1970
			let mtime = e.mtime.getTime() === 0 ? creationTime : e.mtime;

			this.addChild(parent, {
				name,
				type: isDir ? 'directory' : 'file',
				size: isDir ? 0 : e.size,
				mtime
			}, isDir ? undefined : { listing: e });
		}
	}

	/**
	 * Metadata records (attributes, creation time, block index) of an entry
	 */
	async entryMeta(path: string): Promise<EntryMeta | undefined> {
		let node = this.lookup(path);
		if(!node || !node.data) {
			return undefined;
		}

		return ReadEntryMeta(this._reader, node.data.listing.metaOffset);
	}

	/**
	 * Checks every block of a file against its stored MD5. Returns the number of blocks checked.
	 */
	async verifyFile(path: string): Promise<number> {
		let node = this.lookup(path);
		if(!node || !node.data) {
			throw new Error('Not a file: ' + path);
		}

		let content = await this.content(node);
		return content ? await content.verify() : 0;
	}

	protected async readFile(node: TreeNode<WinNodeData>, offset: number, length: number): Promise<Buffer> {
		let content = await this.content(node);
		if(!content) {
			// Empty file
			return Buffer.alloc(length);
		}

		return content.read(offset, length);
	}

	private content(node: TreeNode<WinNodeData>): Promise<WindowsFileContent | null> {
		let data = node.data!;
		if(!data.content) {
			data.content = (async () => {
				let meta = await ReadEntryMeta(this._reader, data.listing.metaOffset);
				if(!meta.index) {
					if(data.listing.size > 0) {
						throw new NotSupportedError('File has data but no block index: ' + node.entry.path);
					}
					return null;
				}

				if(meta.index.totalSize !== data.listing.size) {
					warn('Size mismatch for ' + node.entry.path + ': listing says ' + data.listing.size + ', index says ' + meta.index.totalSize);
				}

				// True Image sometimes records a file without storing any of its data (seen once, kind 0x0007).
				// Unstored data reads as zeros, as elsewhere in the format, but say so rather than hide it.
				if(meta.index.handles.length === 0 && data.listing.size > 0) {
					warn(node.entry.path + ' has no data stored in the backup; it reads as zeros');
				}

				return new WindowsFileContent(this._reader, meta.index, this._cache);
			})();

			// Don't keep a failed load around forever
			data.content.catch(() => { data.content = undefined; });
		}

		return data.content;
	}
}
