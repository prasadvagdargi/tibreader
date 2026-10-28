import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';


/**
 * Temporary copies (for Open, Ctrl+C and dragging) live in %TEMP%\TibReader\staging\<random>.
 * They can't be removed when the backup closes: Explorer may still paste them from the clipboard,
 * or an app may still have one open. Old ones are removed on the next start instead.
 */
export function stagingRoot(): string {
	return path.join(app.getPath('temp'), 'TibReader', 'staging');
}

export function newStagingDir(): string {
	return path.join(stagingRoot(), crypto.randomUUID());
}

export function isInStaging(p: string): boolean {
	return isInside(p, stagingRoot());
}

/** True if p is folder or something inside it (case-insensitive, like Windows) */
export function isInside(p: string, folder: string): boolean {
	let a = path.resolve(p).toLowerCase();
	let b = path.resolve(folder).toLowerCase();
	return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Removes temporary copies older than a day */
export async function cleanOldStaging(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
	let root = stagingRoot();
	let dirs: fs.Dirent[];
	try {
		dirs = await fs.promises.readdir(root, { withFileTypes: true });
	}
	catch(e) {
		return;
	}

	for(let d of dirs) {
		let full = path.join(root, d.name);
		try {
			let st = await fs.promises.stat(full);
			if(Date.now() - st.mtimeMs > maxAgeMs) {
				await removeTree(full);
			}
		}
		catch(e) {
			// In use or already gone: try again next time
		}
	}
}

/** Like rm -rf, but also removes the read-only copies made for Open */
async function removeTree(dir: string): Promise<void> {
	let entries = await fs.promises.readdir(dir, { withFileTypes: true, recursive: true });
	for(let e of entries) {
		if(e.isFile()) {
			await fs.promises.chmod(path.join(e.parentPath, e.name), 0o666).catch(() => {});
		}
	}
	await fs.promises.rm(dir, { recursive: true, force: true });
}
