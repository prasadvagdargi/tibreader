import fs from 'node:fs';
import path from 'node:path';
import { FsEntry, SnapshotFS } from '../fs/types';
import { joinPath, splitPath } from '../fs/tree';


/**
 * A file system that can be written to (an overlay over a read-only backup)
 */
export interface WritableFS extends SnapshotFS {
	/** Writes 'data' at 'offset' of a file, creating it (and copying its old content first) as needed */
	writeFile(filePath: string, data: Buffer, offset?: number): Promise<void>;
	/** Replaces a file's whole content with what the stream provides */
	createWriteStream(filePath: string): Promise<fs.WriteStream>;
	truncate(filePath: string, size: number): Promise<void>;
	mkdir(dirPath: string): Promise<void>;
	/** Removes a file or a folder with everything in it */
	remove(entryPath: string): Promise<void>;
	rename(fromPath: string, toPath: string): Promise<void>;
	/** Copies a file or a folder with everything in it */
	copyTree(fromPath: string, toPath: string): Promise<void>;
}

export function isWritable(fs: SnapshotFS): fs is WritableFS {
	return typeof (fs as WritableFS).writeFile === 'function' && typeof (fs as WritableFS).remove === 'function';
}

interface Manifest {
	version: 1;
	/** Paths hidden from the backup (they and everything below them) */
	deleted: string[];
	/** Paths whose content comes from a file on this computer, not from 'upper' */
	linked: { [backupPath: string]: string };
}

const MANIFEST = 'overlay.json';
const UPPER = 'upper';
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Encodes a name so any backup name can be stored on any OS and decoded back exactly
 */
export function encodeName(name: string): string {
	let encoded = Array.from(Buffer.from(name, 'utf8')).map((b) => {
		let c = String.fromCharCode(b);
		return /[A-Za-z0-9 ._()\-]/.test(c) && b < 0x80 ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
	}).join('');
	// Names Windows can't have: reserved device names, trailing dots or spaces
	if(RESERVED_WINDOWS_NAME.test(encoded)) {
		encoded = '%' + encoded.charCodeAt(0).toString(16).toUpperCase() + encoded.slice(1);
	}
	if(/[. ]$/.test(encoded)) {
		encoded = encoded.slice(0, -1) + '%' + encoded.charCodeAt(encoded.length - 1).toString(16).toUpperCase();
	}
	return encoded;
}

/** Inverse of encodeName */
export function decodeName(encoded: string): string {
	let bytes: number[] = [];
	for(let i = 0; i < encoded.length; i++) {
		let hex = encoded.slice(i + 1, i + 3);
		if(encoded[i] === '%' && /^[0-9A-F]{2}$/.test(hex)) {
			bytes.push(parseInt(hex, 16));
			i += 2;
		}
		else {
			bytes.push(...Buffer.from(encoded[i], 'utf8'));
		}
	}
	return Buffer.from(bytes).toString('utf8');
}


/**
 * A writable view over a read-only backup point. Nothing is ever written to the backup: new and changed
 * files go to '<dir>/upper' (names encoded with encodeName), deletions and links to files on this
 * computer are recorded in '<dir>/overlay.json'. Use it to mount a backup writable, or to describe the
 * changes for a new backup (see editBackup).
 *
 * Changing a file that is in the backup copies it into 'upper' first (whole file).
 */
export class OverlayFS implements WritableFS {

	private _manifest: Manifest = { version: 1, deleted: [], linked: {} };
	private _deleted = new Set<string>();

	private constructor(private _lower: SnapshotFS, readonly dir: string) {}

	/**
	 * Opens (or starts) an overlay in 'dir' over 'lower'
	 */
	static async open(lower: SnapshotFS, dir: string): Promise<OverlayFS> {
		let o = new OverlayFS(lower, dir);
		await fs.promises.mkdir(path.join(dir, UPPER), { recursive: true });
		let manifestFile = path.join(dir, MANIFEST);
		if(fs.existsSync(manifestFile)) {
			let m = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8')) as Manifest;
			if(m.version !== 1 || !Array.isArray(m.deleted) || typeof m.linked !== 'object') {
				throw new Error('Not an overlay manifest this version understands: ' + manifestFile);
			}
			o._manifest = m;
			o._deleted = new Set(m.deleted.map((p) => p.toLowerCase()));
		}
		return o;
	}

	/** Whether anything was changed */
	get hasChanges(): boolean {
		return this._manifest.deleted.length > 0 || Object.keys(this._manifest.linked).length > 0 ||
			fs.readdirSync(path.join(this.dir, UPPER)).length > 0;
	}

	private async saveManifest() {
		this._manifest.deleted = Array.from(new Set(this._manifest.deleted));
		let file = path.join(this.dir, MANIFEST);
		await fs.promises.writeFile(file + '.tmp', JSON.stringify(this._manifest, null, '\t'));
		await fs.promises.rename(file + '.tmp', file);
	}

	private static normalize(p: string): string {
		let parts = splitPath(p);
		return '/' + parts.join('/');
	}

	private upperPath(p: string): string {
		return path.join(this.dir, UPPER, ...splitPath(p).map(encodeName));
	}

	private linkOf(p: string): string | undefined {
		let key = Object.keys(this._manifest.linked).find((k) => k.toLowerCase() === p.toLowerCase());
		return key ? this._manifest.linked[key] : undefined;
	}

	/** Hidden from the backup: the path or one of its parents was deleted */
	private hiddenInLower(p: string): boolean {
		let parts = splitPath(p);
		for(let i = 1; i <= parts.length; i++) {
			if(this._deleted.has(('/' + parts.slice(0, i).join('/')).toLowerCase())) {
				return true;
			}
		}
		return false;
	}

	private async upperStat(p: string): Promise<fs.Stats | null> {
		let link = this.linkOf(p);
		try {
			return await fs.promises.stat(link || this.upperPath(p));
		}
		catch(e) {
			return null;
		}
	}

	private async lowerStat(p: string): Promise<FsEntry | undefined> {
		return this.hiddenInLower(p) ? undefined : this._lower.stat(p);
	}

	async stat(p: string): Promise<FsEntry | undefined> {
		p = OverlayFS.normalize(p);
		let upper = await this.upperStat(p);
		if(upper) {
			let lower = await this.lowerStat(p);
			// A folder that is also in the backup keeps the backup's details
			if(upper.isDirectory() && lower && lower.type === 'directory') {
				return lower;
			}
			let name = lower ? lower.name : (splitPath(p).pop() || '');
			return {
				name, path: lower ? lower.path : p,
				type: upper.isDirectory() ? 'directory' : 'file',
				size: upper.isDirectory() ? 0 : upper.size,
				mtime: upper.mtime,
			};
		}
		if(p === '/') {
			return this._lower.stat('/');
		}
		return this.lowerStat(p);
	}

	async list(p: string): Promise<FsEntry[] | undefined> {
		p = OverlayFS.normalize(p);
		let self = await this.stat(p);
		if(!self || self.type !== 'directory') {
			return undefined;
		}

		let byName = new Map<string, FsEntry>();
		if(!this.hiddenInLower(p) || p === '/') {
			for(let e of (await this._lower.list(p)) || []) {
				if(!this.hiddenInLower(e.path)) {
					byName.set(e.name.toLowerCase(), e);
				}
			}
		}

		let upperDir = this.upperPath(p);
		let upperNames = fs.existsSync(upperDir) ? await fs.promises.readdir(upperDir) : [];
		let linkedNames = Object.keys(this._manifest.linked)
			.filter((k) => OverlayFS.normalize(path.posix.dirname(k)).toLowerCase() === p.toLowerCase())
			.map((k) => path.posix.basename(k));

		for(let name of [ ...upperNames.map(decodeName), ...linkedNames ]) {
			let e = await this.stat(joinPath(p, name));
			if(e) {
				byName.set(name.toLowerCase(), e);
			}
		}
		return Array.from(byName.values());
	}

	async read(p: string, offset: number, length: number): Promise<Buffer> {
		p = OverlayFS.normalize(p);
		let upper = await this.upperStat(p);
		if(upper) {
			if(upper.isDirectory()) {
				throw new Error('Is a folder: ' + p);
			}
			let fh = await fs.promises.open(this.linkOf(p) || this.upperPath(p), 'r');
			try {
				let size = Math.max(0, Math.min(length, upper.size - offset));
				let buf = Buffer.alloc(size);
				let { bytesRead } = await fh.read(buf, 0, size, offset);
				return buf.subarray(0, bytesRead);
			}
			finally {
				await fh.close();
			}
		}
		if(this.hiddenInLower(p)) {
			throw new Error('No such file: ' + p);
		}
		return this._lower.read(p, offset, length);
	}

	async *walk(p: string = '/'): AsyncIterable<FsEntry> {
		let top = await this.stat(p);
		if(!top) {
			throw new Error('No such file or folder: ' + p);
		}
		let stack: FsEntry[] = [ top ];
		while(stack.length) {
			let e = stack.pop()!;
			yield e;
			if(e.type === 'directory') {
				let kids = (await this.list(e.path)) || [];
				for(let i = kids.length - 1; i >= 0; i--) {
					stack.push(kids[i]);
				}
			}
		}
	}

	/** Makes sure a folder exists in 'upper' (and that its parents are folders in the merged view) */
	private async ensureUpperDir(p: string) {
		let parts = splitPath(p);
		for(let i = 1; i <= parts.length; i++) {
			let sub = '/' + parts.slice(0, i).join('/');
			let e = await this.stat(sub);
			if(e && e.type !== 'directory') {
				throw new Error('Not a folder: ' + sub);
			}
			if(!e && i < parts.length) {
				throw new Error('No such folder: ' + sub);
			}
		}
		await fs.promises.mkdir(this.upperPath(p), { recursive: true });
	}

	/** Copies a backup file into 'upper' so it can be changed */
	private async copyUp(p: string) {
		if(await this.upperStat(p)) {
			let link = this.linkOf(p);
			if(link) {
				// A linked file is about to change: take a private copy
				await this.ensureUpperDir(path.posix.dirname(p));
				await fs.promises.copyFile(link, this.upperPath(p));
				this.removeLink(p);
				await this.saveManifest();
			}
			return;
		}
		let lower = await this.lowerStat(p);
		await this.ensureUpperDir(path.posix.dirname(p));
		let fh = await fs.promises.open(this.upperPath(p), 'w');
		try {
			if(lower && lower.type === 'file') {
				for(let off = 0; off < lower.size; off += 4 * 1024 * 1024) {
					let b = await this._lower.read(p, off, 4 * 1024 * 1024);
					await fh.write(b, 0, b.length, off);
				}
			}
		}
		finally {
			await fh.close();
		}
	}

	private removeLink(p: string) {
		for(let k of Object.keys(this._manifest.linked)) {
			if(k.toLowerCase() === p.toLowerCase()) {
				delete this._manifest.linked[k];
			}
		}
	}

	private async checkCanWriteFile(p: string) {
		if(p === '/') {
			throw new Error('Can\'t write to the top folder');
		}
		let e = await this.stat(p);
		if(e && e.type === 'directory') {
			throw new Error('Is a folder: ' + p);
		}
	}

	async writeFile(p: string, data: Buffer, offset = 0): Promise<void> {
		p = OverlayFS.normalize(p);
		await this.checkCanWriteFile(p);
		await this.copyUp(p);
		let fh = await fs.promises.open(this.upperPath(p), 'r+');
		try {
			await fh.write(data, 0, data.length, offset);
		}
		finally {
			await fh.close();
		}
	}

	async createWriteStream(p: string): Promise<fs.WriteStream> {
		p = OverlayFS.normalize(p);
		await this.checkCanWriteFile(p);
		await this.ensureUpperDir(path.posix.dirname(p));
		if(this.linkOf(p)) {
			this.removeLink(p);
			await this.saveManifest();
		}
		return fs.createWriteStream(this.upperPath(p));
	}

	async truncate(p: string, size: number): Promise<void> {
		p = OverlayFS.normalize(p);
		await this.checkCanWriteFile(p);
		await this.copyUp(p);
		await fs.promises.truncate(this.upperPath(p), size);
	}

	async mkdir(p: string): Promise<void> {
		p = OverlayFS.normalize(p);
		let e = await this.stat(p);
		if(e) {
			throw new Error('Already exists: ' + p);
		}
		await this.ensureUpperDir(p);
	}

	async remove(p: string): Promise<void> {
		p = OverlayFS.normalize(p);
		if(p === '/') {
			throw new Error('Can\'t remove the top folder');
		}
		if(!(await this.stat(p))) {
			throw new Error('No such file or folder: ' + p);
		}
		await fs.promises.rm(this.upperPath(p), { recursive: true, force: true });
		for(let k of Object.keys(this._manifest.linked)) {
			if(k.toLowerCase() === p.toLowerCase() || k.toLowerCase().startsWith(p.toLowerCase() + '/')) {
				delete this._manifest.linked[k];
			}
		}
		if(!this.hiddenInLower(p) && await this._lower.stat(p)) {
			this._manifest.deleted.push(p);
			this._deleted.add(p.toLowerCase());
		}
		await this.saveManifest();
	}

	async rename(from: string, to: string): Promise<void> {
		from = OverlayFS.normalize(from);
		to = OverlayFS.normalize(to);
		let source = await this.stat(from);
		if(!source) {
			throw new Error('No such file or folder: ' + from);
		}
		if(await this.stat(to)) {
			await this.remove(to);
		}
		await this.copyTree(from, to);
		await this.remove(from);
	}

	/** Copies a file or folder within the overlay (backup content is copied into 'upper') */
	async copyTree(from: string, to: string): Promise<void> {
		for await (let e of this.walk(from)) {
			let target = to + e.path.slice(OverlayFS.normalize(from).length);
			if(e.type === 'directory') {
				if(!(await this.stat(target))) {
					await this.ensureUpperDir(target);
				}
				continue;
			}
			await this.ensureUpperDir(path.posix.dirname(target));
			let fh = await fs.promises.open(this.upperPath(target), 'w');
			try {
				for(let off = 0; off < e.size; off += 4 * 1024 * 1024) {
					let b = await this.read(e.path, off, 4 * 1024 * 1024);
					await fh.write(b, 0, b.length, off);
				}
			}
			finally {
				await fh.close();
			}
		}
	}

	/**
	 * Adds a file from this computer at 'p' without copying it now (it's read when used)
	 */
	async link(p: string, localFile: string): Promise<void> {
		p = OverlayFS.normalize(p);
		let st = await fs.promises.stat(localFile);
		if(!st.isFile()) {
			throw new Error('Not a file: ' + localFile);
		}
		await this.checkCanWriteFile(p);
		await this.ensureUpperDir(path.posix.dirname(p));
		await fs.promises.rm(this.upperPath(p), { force: true });
		this.removeLink(p);
		this._manifest.linked[p] = path.resolve(localFile);
		await this.saveManifest();
	}
}
