import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FsEntry, SnapshotFS } from './types';
import { splitPath } from './tree';


const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Makes a name from a backup safe to use as a single file name on this OS.
 * Names from a backup are untrusted: they must not contain separators or be '.'/'..'.
 */
export function safeFileName(name: string, platform: NodeJS.Platform = process.platform): string {
	let out = name.replace(/[\u0000-\u001f/]/g, '_');

	if(platform === 'win32') {
		out = out.replace(/[<>:"\\|?*]/g, '_');

		// Windows drops trailing dots and spaces
		out = out.replace(/[. ]+$/, (m) => '_'.repeat(m.length));

		if(WINDOWS_RESERVED.test(out)) {
			out = '_' + out;
		}
	}

	if(out === '' || out === '.' || out === '..') {
		out = '_' + out;
	}

	return out;
}


/** What to do with one file that already exists at the destination */
export type ConflictChoice = 'overwrite' | 'skip' | 'rename' | 'abort';

/**
 * How to handle files that already exist: fail (default), overwrite, skip, rename ("name (2).txt"),
 * or ask a function for each one
 */
export type ConflictPolicy = 'fail' | ConflictChoice | ((entry: FsEntry, destPath: string) => ConflictChoice | Promise<ConflictChoice>);

export interface ExtractProgress {
	files: number;
	directories: number;
	bytes: number;
	/** The backup path being written */
	path: string;
}

export interface ExtractOptions {
	/** Replace files that already exist (same as conflict: 'overwrite') */
	overwrite?: boolean;
	/** What to do when a file already exists (default: fail) */
	conflict?: ConflictPolicy;
	/** Called before each file or folder is written */
	onEntry?: (entry: FsEntry, destPath: string) => void;
	/** Called after each piece of data is written, with running totals. Can be frequent: throttle in the caller. */
	onProgress?: (progress: ExtractProgress) => void;
	/** Called when a name from the backup had to be changed to be valid on this OS */
	onRenamed?: (entry: FsEntry, safeName: string) => void;
	/** Stops the extraction; the file being written is removed */
	signal?: AbortSignal;
	/** Bytes read from the backup at a time (default 4 MiB) */
	chunkSize?: number;
}

export interface ExtractResult {
	files: number;
	directories: number;
	bytes: number;
	/** Files left alone because they already existed (conflict: 'skip') */
	skipped: number;
}


/**
 * Copies a file or folder out of a backup.
 *
 * A folder's contents are written into 'destDir'; a single file is written as 'destDir/<name>'.
 * Modification times are restored. Nothing outside 'destDir' is ever written.
 */
export async function extract(snapshot: SnapshotFS, fromPath: string, destDir: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
	let result: ExtractResult = { files: 0, directories: 0, bytes: 0, skipped: 0 };
	await extractInto(snapshot, fromPath, destDir, opts, result);
	return result;
}

/**
 * Copies several files and folders out of a backup, the way a file manager copies a selection:
 * each one is written as 'destDir/<its name>' (folders included, unlike extract()).
 * Extracting the root ('/') writes its contents into 'destDir'.
 */
export async function extractItems(snapshot: SnapshotFS, paths: string[], destDir: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
	let result: ExtractResult = { files: 0, directories: 0, bytes: 0, skipped: 0 };

	for(let p of paths) {
		let top = await snapshot.stat(p);
		if(!top) {
			throw new Error('No such file or folder in the backup: ' + p);
		}

		if(top.type !== 'directory' || top.path === '/') {
			await extractInto(snapshot, top.path, destDir, opts, result);
			continue;
		}

		// The folder itself is one of the copied items, so it gets its own modified time too
		let safe = safeFileName(top.name);
		if(safe !== top.name && opts.onRenamed) {
			opts.onRenamed(top, safe);
		}

		let dest = path.join(destDir, safe);
		await extractInto(snapshot, top.path, dest, opts, result);
		await fs.promises.utimes(dest, top.atime || top.mtime, top.mtime);
		result.directories++;
	}

	return result;
}

/**
 * Counts what extracting these paths would write. 'directories' doesn't count the root.
 */
export async function measure(snapshot: SnapshotFS, paths: string[] = ['/']): Promise<{ files: number; directories: number; bytes: number }> {
	let files = 0, directories = 0, bytes = 0;

	for(let p of paths) {
		if(!(await snapshot.stat(p))) {
			throw new Error('No such file or folder in the backup: ' + p);
		}

		for await (let e of snapshot.walk(p)) {
			if(e.type === 'file') {
				files++;
				bytes += e.size;
			}
			else if(e.path !== '/') {
				directories++;
			}
		}
	}

	return { files, directories, bytes };
}


async function extractInto(snapshot: SnapshotFS, fromPath: string, destDir: string, opts: ExtractOptions, result: ExtractResult) {
	let top = await snapshot.stat(fromPath);
	if(!top) {
		throw new Error('No such file or folder in the backup: ' + fromPath);
	}

	let chunkSize = opts.chunkSize || 4 * 1024 * 1024;
	let policy: ConflictPolicy = opts.conflict || (opts.overwrite ? 'overwrite' : 'fail');
	let signal = opts.signal;
	let root = path.resolve(destDir);

	signal?.throwIfAborted();
	await fs.promises.mkdir(root, { recursive: true });

	let baseParts = splitPath(top.path);

	// Folder times are set last, since writing their contents changes them
	let dirTimes: Array<{ dest: string; entry: FsEntry }> = [];

	let progress = (p: string) => {
		if(opts.onProgress) {
			opts.onProgress({ files: result.files, directories: result.directories, bytes: result.bytes, path: p });
		}
	};

	for await (let entry of snapshot.walk(fromPath)) {
		signal?.throwIfAborted();

		let rel: string[];
		if(top.type === 'file') {
			rel = [ entry.name ];
		}
		else {
			rel = splitPath(entry.path).slice(baseParts.length);
		}

		let safeParts = rel.map((p) => safeFileName(p));
		if(rel.length > 0 && safeParts[safeParts.length - 1] !== rel[rel.length - 1] && opts.onRenamed) {
			opts.onRenamed(entry, safeParts[safeParts.length - 1]);
		}

		let dest = path.join(root, ...safeParts);

		// Defence in depth: never write outside the destination
		if(dest !== root && !dest.startsWith(root + path.sep)) {
			throw new Error('Refusing to write outside the destination: ' + dest);
		}

		if(entry.type === 'directory') {
			if(opts.onEntry) {
				opts.onEntry(entry, dest);
			}

			await fs.promises.mkdir(dest, { recursive: true });

			// The destination folder itself keeps its own times
			if(rel.length > 0) {
				dirTimes.push({ dest, entry });
				result.directories++;
			}
			progress(entry.path);
			continue;
		}

		let choice: ConflictChoice | 'new' = 'new';
		if(await pathExists(dest)) {
			choice = await decide(policy, entry, dest);
			if(choice === 'abort') {
				throw abortError();
			}
			if(choice === 'skip') {
				result.skipped++;
				progress(entry.path);
				continue;
			}
			if(choice === 'rename') {
				dest = await freeName(dest);
			}
		}

		if(opts.onEntry) {
			opts.onEntry(entry, dest);
		}

		await writeFile(snapshot, entry, dest, choice === 'overwrite', chunkSize, signal, (n) => {
			result.bytes += n;
			progress(entry.path);
		});

		result.files++;
		progress(entry.path);
	}

	for(let i = dirTimes.length - 1; i >= 0; i--) {
		let { dest, entry } = dirTimes[i];
		await fs.promises.utimes(dest, entry.atime || entry.mtime, entry.mtime);
	}
}

async function decide(policy: ConflictPolicy, entry: FsEntry, dest: string): Promise<ConflictChoice> {
	if(policy === 'fail') {
		throw new Error('File already exists (use overwrite to replace it): ' + dest);
	}
	if(typeof policy === 'function') {
		return await policy(entry, dest);
	}
	return policy;
}

/**
 * Writes one file. A replaced file is written next to the original first, so cancelling keeps the
 * original; a new file that isn't finished is removed.
 */
async function writeFile(snapshot: SnapshotFS, entry: FsEntry, dest: string, replace: boolean, chunkSize: number,
	signal: AbortSignal | undefined, onBytes: (n: number) => void) {

	let target = replace ? path.join(path.dirname(dest), '.' + path.basename(dest) + '.' + crypto.randomBytes(4).toString('hex') + '.partial') : dest;

	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(target, 'wx');
	}
	catch(e: any) {
		if(e.code === 'EEXIST') {
			throw new Error('File already exists (use overwrite to replace it): ' + dest);
		}
		throw e;
	}

	let done = false;
	try {
		try {
			for(let off = 0; off < entry.size; off += chunkSize) {
				signal?.throwIfAborted();
				let buf = await snapshot.read(entry.path, off, Math.min(chunkSize, entry.size - off));
				await handle.write(buf, 0, buf.length);
				onBytes(buf.length);
			}
		}
		finally {
			await handle.close();
		}

		await fs.promises.utimes(target, entry.atime || entry.mtime, entry.mtime);

		if(replace) {
			await fs.promises.rm(dest, { force: true });
			await fs.promises.rename(target, dest);
		}
		done = true;
	}
	finally {
		if(!done) {
			await fs.promises.rm(target, { force: true }).catch(() => {});
		}
	}
}

/** "name.txt" -> "name (2).txt", the first one that doesn't exist yet */
async function freeName(dest: string): Promise<string> {
	let dir = path.dirname(dest);
	let ext = path.extname(dest);
	let stem = path.basename(dest, ext);
	if(stem === '') {
		// ".profile" has no extension, just a name starting with a dot
		stem = ext;
		ext = '';
	}

	for(let n = 2; ; n++) {
		let candidate = path.join(dir, stem + ' (' + n + ')' + ext);
		if(!(await pathExists(candidate))) {
			return candidate;
		}
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.promises.lstat(p);
		return true;
	}
	catch(e: any) {
		if(e.code === 'ENOENT') {
			return false;
		}
		throw e;
	}
}

function abortError() {
	let e = new Error('The operation was aborted');
	e.name = 'AbortError';
	return e;
}
