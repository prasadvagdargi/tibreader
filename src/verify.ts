import Archive from './archive';
import { SnapshotFS } from './fs/types';
import { measure } from './fs/extract';
import { WindowsFS } from './win/fs';
import { DiskFS } from './disk/fs';


/**
 * Disk images: reads every stored image once from start to end, which decompresses every block and
 * checks it (zlib checksum, size promised by its cluster bitmap). The files inside volumes come from
 * the same blocks, so they aren't read again.
 */
async function verifyDisk(disk: DiskFS, opts: VerifyOptions): Promise<VerifyResult> {
	let images = await Promise.all(disk.sourceFiles.map((f) => disk.stat('/' + f)));
	let totalBytes = images.reduce((s, e) => s + (e ? e.size : 0), 0);
	let result: VerifyResult = { files: 0, bytes: 0, problems: [], unstored: 0 };
	const CHUNK = 4 * 1024 * 1024;

	for(let e of images) {
		if(!e) {
			continue;
		}
		// Keep going after a damaged area, so every damaged part is reported
		for(let off = 0; off < e.size; off += CHUNK) {
			opts.signal?.throwIfAborted();
			try {
				await disk.read(e.path, off, CHUNK);
			}
			catch(ex: any) {
				if(ex && ex.name === 'AbortError') {
					throw ex;
				}
				let problem = { path: e.path, message: 'At offset ' + off + ': ' + (ex && ex.message ? ex.message : String(ex)) };
				result.problems.push(problem);
				opts.onProblem?.(problem);
			}
			if(opts.onProgress) {
				let done = Math.min(e.size, off + CHUNK);
				opts.onProgress({ files: result.files, bytes: result.bytes + done, totalFiles: images.length, totalBytes, path: e.path });
			}
		}
		result.files++;
		result.bytes += e.size;
	}

	return result;
}


export interface VerifyProblem {
	/** Backup path of the file, or the .tib file name for header problems */
	path: string;
	message: string;
}

export interface VerifyProgress {
	files: number;
	bytes: number;
	totalFiles: number;
	totalBytes: number;
	/** The file being checked */
	path: string;
}

export interface VerifyOptions {
	/** Stops checking; the promise rejects with an AbortError */
	signal?: AbortSignal;
	/** Called after each file. Can be frequent: throttle in the caller. */
	onProgress?: (progress: VerifyProgress) => void;
	/** Called for each file that fails, as soon as it fails */
	onProblem?: (problem: VerifyProblem) => void;
	/** Totals from measure(), if already known */
	totals?: { files: number; bytes: number };
}

export interface VerifyResult {
	files: number;
	bytes: number;
	problems: VerifyProblem[];
	/** Files recorded without data in the backup (they read as zeros) */
	unstored: number;
}


/**
 * Problems in the headers of the backup's files. Opening an archive already checked every header,
 * footer, trailer and the metadata of each backup point; only checksum mismatches are left to report.
 */
export function verifyHeaders(archive: Archive): VerifyProblem[] {
	return archive.volumes
		.filter((v) => !v.header.checkSumValid)
		.map((v) => ({ path: v.fileName, message: 'Header checksum mismatch' }));
}

/**
 * Reads every file of a backup point to check its data. Windows backups check each block against
 * its stored MD5; Mac backups check that every block decompresses.
 */
export async function verifySnapshot(snapshot: SnapshotFS, opts: VerifyOptions = {}): Promise<VerifyResult> {
	if(snapshot instanceof DiskFS) {
		return verifyDisk(snapshot, opts);
	}

	let totals = opts.totals || await measure(snapshot);
	let result: VerifyResult = { files: 0, bytes: 0, problems: [], unstored: 0 };

	for await (let e of snapshot.walk()) {
		opts.signal?.throwIfAborted();

		if(e.type !== 'file') {
			continue;
		}

		try {
			if(snapshot instanceof WindowsFS) {
				let blocks = await snapshot.verifyFile(e.path);
				if(blocks === 0 && e.size > 0) {
					result.unstored++;
				}
			}
			else {
				// Decompressing every block checks its structure
				for(let off = 0; off < e.size; off += 4 * 1024 * 1024) {
					opts.signal?.throwIfAborted();
					await snapshot.read(e.path, off, 4 * 1024 * 1024);
				}
			}
		}
		catch(ex: any) {
			if(ex && ex.name === 'AbortError') {
				throw ex;
			}

			let problem = { path: e.path, message: ex && ex.message ? ex.message : String(ex) };
			result.problems.push(problem);
			if(opts.onProblem) {
				opts.onProblem(problem);
			}
		}

		result.files++;
		result.bytes += e.size;

		if(opts.onProgress) {
			opts.onProgress({ files: result.files, bytes: result.bytes, totalFiles: totals.files, totalBytes: totals.bytes, path: e.path });
		}
	}

	return result;
}
