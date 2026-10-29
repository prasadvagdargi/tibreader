import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';


/**
 * Folder for indexes that are slow to rebuild (e.g. walking a 2014-2016 disk image). Never next to the
 * backup, which is only ever read and may be on read-only media.
 *
 * TIB_CACHE_DIR overrides it; TIB_NO_CACHE=1 turns caching off (returns null).
 */
export function cacheDir(): string | null {
	if(process.env.TIB_NO_CACHE === '1') {
		return null;
	}
	if(process.env.TIB_CACHE_DIR) {
		return process.env.TIB_CACHE_DIR;
	}
	if(process.platform === 'win32') {
		return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'tibreader', 'cache');
	}
	if(process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Caches', 'tibreader');
	}
	return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tibreader');
}

/**
 * A key identifying a backup file as it is now: its full path, size and modification time.
 * A changed or replaced file gets a different key, so stale indexes are never used.
 */
export function fileKey(fileName: string, extra = ''): string {
	let st = fs.statSync(fileName);
	return crypto.createHash('sha256')
		.update(path.resolve(fileName) + '\0' + st.size + '\0' + st.mtimeMs + '\0' + extra)
		.digest('hex');
}

/** Path for a cache entry, or null when caching is off */
export function cachePath(kind: string, key: string): string | null {
	let dir = cacheDir();
	return dir ? path.join(dir, kind + '-' + key.slice(0, 40) + '.bin') : null;
}
