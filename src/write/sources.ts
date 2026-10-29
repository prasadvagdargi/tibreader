import fs from 'node:fs';
import path from 'node:path';
import { SnapshotFS } from '../fs/types';
import { splitPath } from '../fs/tree';
import { warn } from '../log';
import { BackupEntry, WriteBackupOptions, WriteBackupResult, writeFileBackup } from './writer';
import { FileAttribute } from '../win/record';
import { OverlayFS } from './overlay';


/**
 * Where a local path goes in a backup: "C:\Users\me" -> "C:/Users/me"; on macOS/Linux "/home/me" ->
 * "<drive>:/home/me"
 */
export function backupPathOfLocal(localPath: string, drive = 'C'): string {
	let abs = path.resolve(localPath);
	let m = /^([A-Za-z]):[\\/]*(.*)$/.exec(abs);
	if(m) {
		let rest = m[2].split(/[\\/]+/).filter(Boolean);
		return [ m[1].toUpperCase() + ':', ...rest ].join('/');
	}
	return [ drive.toUpperCase() + ':', ...abs.split('/').filter(Boolean) ].join('/');
}

function readerFor(file: string) {
	return async (offset: number, length: number) => {
		let fh = await fs.promises.open(file, 'r');
		try {
			let buf = Buffer.alloc(length);
			let { bytesRead } = await fh.read(buf, 0, length, offset);
			return buf.subarray(0, bytesRead);
		}
		finally {
			await fh.close();
		}
	};
}

function localEntry(file: string, st: fs.Stats, backupPath: string): BackupEntry {
	let attributes = st.isDirectory() ? FileAttribute.Directory : FileAttribute.Archive;
	if(!(st.mode & 0o200)) {
		attributes |= FileAttribute.ReadOnly;
	}
	return {
		backupPath,
		type: st.isDirectory() ? 'directory' : 'file',
		size: st.isDirectory() ? 0 : st.size,
		modified: st.mtime,
		created: st.birthtime.getTime() > 0 ? st.birthtime : st.mtime,
		attributes,
		read: st.isDirectory() ? undefined : readerFor(file),
	};
}

/**
 * Files and folders on this computer, with their parent folders first. Symbolic links and special
 * files are skipped (with a warning).
 */
export async function* localEntries(sources: string[], drive = 'C'): AsyncIterable<BackupEntry> {
	for(let source of sources) {
		let abs = path.resolve(source);
		let st = await fs.promises.lstat(abs);

		// Parent folders, so the backup holds the full path like True Image's do
		let parents: string[] = [];
		for(let p = path.dirname(abs); p !== path.dirname(p); p = path.dirname(p)) {
			parents.unshift(p);
		}
		for(let p of parents) {
			let pst = await fs.promises.stat(p).catch(() => null);
			if(pst && backupPathOfLocal(p, drive).includes('/')) {
				yield localEntry(p, pst, backupPathOfLocal(p, drive));
			}
		}

		let stack: Array<{ file: string; st: fs.Stats }> = [ { file: abs, st } ];
		while(stack.length) {
			let { file, st: s } = stack.pop()!;
			if(s.isSymbolicLink() || !(s.isFile() || s.isDirectory())) {
				warn('Skipping ' + file + ' (not a regular file or folder)');
				continue;
			}
			yield localEntry(file, s, backupPathOfLocal(file, drive));
			if(s.isDirectory()) {
				let names = (await fs.promises.readdir(file)).sort((a, b) => b.localeCompare(a));
				for(let n of names) {
					let child = path.join(file, n);
					stack.push({ file: child, st: await fs.promises.lstat(child) });
				}
			}
		}
	}
}

/**
 * Entries of a backup view (any format, possibly an overlay with changes) below 'from'.
 *
 * Paths whose first folder is a single letter (Windows file backups show drives that way) keep their
 * drive: "/G/Pictures/a.jpg" -> "G:/Pictures/a.jpg". Anything else goes on drive 'drive' relative to
 * 'from': from "/Volume (Windows)", "/Volume (Windows)/Users/x" -> "C:/Users/x".
 */
export async function* snapshotEntries(snapshot: SnapshotFS, from = '/', drive?: string): AsyncIterable<BackupEntry> {
	let fromParts = splitPath(from);
	for await (let e of snapshot.walk(from)) {
		let parts = splitPath(e.path);
		let backupParts: string[];
		if(!drive && parts.length > 0 && /^[A-Za-z]$/.test(parts[0])) {
			backupParts = [ parts[0].toUpperCase() + ':', ...parts.slice(1) ];
		}
		else {
			backupParts = [ (drive || 'C').toUpperCase() + ':', ...parts.slice(fromParts.length) ];
		}
		if(backupParts.length === 1 && e.type === 'file') {
			warn('Skipping ' + e.path + ': a file can\'t be a drive');
			continue;
		}
		yield {
			backupPath: backupParts.join('/'),
			type: e.type,
			size: e.size,
			modified: e.mtime,
			read: e.type === 'file' ? (offset, length) => snapshot.read(e.path, offset, length) : undefined,
		};
	}
}

/**
 * Adds a file or folder from this computer at 'destination' in an overlay (files are linked, not
 * copied; they are read when the new backup is written)
 */
export async function addLocalToOverlay(overlay: OverlayFS, localPath: string, destination: string): Promise<void> {
	let st = await fs.promises.stat(localPath);
	if(st.isFile()) {
		await overlay.link(destination, localPath);
		return;
	}
	if(!st.isDirectory()) {
		throw new Error('Not a file or folder: ' + localPath);
	}
	let existing = await overlay.stat(destination);
	if(!existing) {
		await overlay.mkdir(destination);
	}
	else if(existing.type !== 'directory') {
		throw new Error('Not a folder in the backup: ' + destination);
	}
	for(let name of await fs.promises.readdir(localPath)) {
		let child = path.join(localPath, name);
		let cst = await fs.promises.lstat(child);
		if(cst.isSymbolicLink() || !(cst.isFile() || cst.isDirectory())) {
			warn('Skipping ' + child + ' (not a regular file or folder)');
			continue;
		}
		await addLocalToOverlay(overlay, child, destination.replace(/\/+$/, '') + '/' + name);
	}
}

/**
 * Writes a new file backup from a backup view. With an OverlayFS this is "edit a backup into a new
 * file": the original backup is only read.
 */
export function writeSnapshotBackup(snapshot: SnapshotFS, output: string, opts: WriteBackupOptions & { from?: string; drive?: string } = {}): Promise<WriteBackupResult> {
	return writeFileBackup(output, snapshotEntries(snapshot, opts.from || '/', opts.drive), opts);
}
