/// <reference types="electron" />
/**
 * The backup engine: an Electron utility process that owns one open backup.
 *
 * The library decompresses and checks MD5s synchronously, and (once mounted) serves the backup's drive,
 * so it runs here instead of in the window or main process. Main sends requests over parentPort.
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import {
	openArchive, describeArchive, extractItems, measure, safeFileName, setWarningHandler, WindowsFS,
	type Archive, type SnapshotFS, type FsEntry, type ConflictChoice as LibraryChoice
} from 'tibreader';
import type {
	BackupInfo, ConflictChoice, ConflictPolicy, Contents, CopyResult, EngineMessage, EngineMethods, EngineRequest, Entry,
	EntryDetails, ErrorInfo, Result
} from '../shared/api';


const port = process.parentPort;

let archive: Archive | null = null;
let openedFile = '';

/** One file system per backup point, built once (building one reads the whole file list) */
const snapshots = new Map<number, Promise<SnapshotFS>>();


function send(message: EngineMessage) {
	port.postMessage(message);
}

function toEntry(e: FsEntry): Entry {
	return { name: e.name, path: e.path, type: e.type, size: e.size, mtime: e.mtime.getTime() };
}

function snapshot(slice: number): Promise<SnapshotFS> {
	if(!archive) {
		throw new Error('No backup is open');
	}

	let n = slice < 0 ? archive.slices.length + 1 + slice : slice;
	let s = snapshots.get(n);
	if(!s) {
		s = archive.getSlice(n).openFileSystem();
		// Don't keep a failed attempt around
		s.catch(() => snapshots.delete(n));
		snapshots.set(n, s);
	}
	return s;
}


interface Job {
	abort: AbortController;
	/** Conflicts waiting for the user's answer */
	pending: Map<number, (choice: ConflictChoice) => void>;
	/** "Do this for all" answer */
	always?: ConflictChoice;
	nextConflict: number;
}

const jobs = new Map<string, Job>();

/**
 * Copies items out of the backup, reporting progress (at most ~10 times a second) and asking the
 * window about files that already exist when the policy is 'ask'
 */
async function runCopy(jobId: string, slice: number, paths: string[], dest: string, policy: ConflictPolicy, readOnly: boolean): Promise<CopyResult> {
	if(jobs.has(jobId)) {
		throw new Error('Job ' + jobId + ' is already running');
	}

	let job: Job = { abort: new AbortController(), pending: new Map(), nextConflict: 1 };
	jobs.set(jobId, job);

	try {
		let snap = await snapshot(slice);
		let totals = await measure(snap, paths);
		let wanted = new Set(paths);
		let placed = new Map<string, string>();
		let renamed = 0;
		let last = 0;

		let report = (files: number, bytes: number, path: string, force = false) => {
			let now = Date.now();
			if(!force && now - last < 100) {
				return;
			}
			last = now;
			send({ type: 'event', event: { name: 'job-progress', progress: {
				jobId, files, bytes, totalFiles: totals.files, totalBytes: totals.bytes, path,
			} } });
		};

		let ask = async (entry: FsEntry, destPath: string): Promise<LibraryChoice> => {
			if(job.always) {
				return job.always;
			}
			let conflictId = job.nextConflict++;
			let existing = await fs.promises.stat(destPath).then((st) => ({ size: st.size, mtime: st.mtimeMs }), () => null);
			return new Promise<LibraryChoice>((resolve) => {
				job.pending.set(conflictId, resolve);
				send({ type: 'event', event: { name: 'job-conflict', conflict: { jobId, conflictId, entry: toEntry(entry), dest: destPath, existing } } });
			});
		};

		report(0, 0, paths[0] || '', true);

		let r = await extractItems(snap, paths, dest, {
			conflict: policy === 'ask' ? ask : policy,
			signal: job.abort.signal,
			onProgress: (p) => report(p.files, p.bytes, p.path),
			onRenamed: () => { renamed++; },
			onEntry: (e, d) => {
				if(wanted.has(e.path) && !placed.has(e.path)) {
					placed.set(e.path, d);
				}
			},
		});

		report(r.files, r.bytes, '', true);

		let items = paths.map((p) => placed.get(p) ?? nodePath.join(dest, safeFileName(p.slice(p.lastIndexOf('/') + 1))));

		// Copies opened just for viewing are read-only, so nobody edits them by mistake
		if(readOnly) {
			for(let f of items) {
				let st = await fs.promises.stat(f).catch(() => null);
				if(st && st.isFile()) {
					await fs.promises.chmod(f, 0o444).catch(() => {});
				}
			}
		}

		return { files: r.files, folders: r.directories, bytes: r.bytes, skipped: r.skipped, renamed, items, destination: dest };
	}
	finally {
		jobs.delete(jobId);
		for(let resolve of job.pending.values()) {
			resolve('abort');
		}
	}
}


type Handlers = { [M in keyof EngineMethods]: (...args: Parameters<EngineMethods[M]>) => Promise<ReturnType<EngineMethods[M]>> };

const handlers: Handlers = {
	async open(file: string): Promise<BackupInfo> {
		if(archive) {
			throw new Error('This engine already has a backup open');
		}

		archive = await openArchive(file);
		openedFile = file;

		let d = await describeArchive(archive, { contents: false });
		return {
			file: openedFile,
			name: d.name,
			format: d.format,
			volumes: d.volumes,
			slices: d.slices.map((s) => ({ number: s.number, id: s.id, created: s.created, incremental: s.incremental, config: s.config })),
		};
	},

	async list(slice: number, path: string): Promise<Entry[]> {
		let entries = await (await snapshot(slice)).list(path);
		if(!entries) {
			throw Object.assign(new Error('Not a folder in this backup: ' + path), { code: 'not-found' });
		}
		return entries.map(toEntry);
	},

	async stat(slice: number, path: string): Promise<Entry | null> {
		let e = await (await snapshot(slice)).stat(path);
		return e ? toEntry(e) : null;
	},

	async details(slice: number, path: string): Promise<EntryDetails | null> {
		let s = await snapshot(slice);
		let e = await s.stat(path);
		if(!e) {
			return null;
		}

		let d: EntryDetails = toEntry(e);
		if(s instanceof WindowsFS && e.type === 'file') {
			let meta = await s.entryMeta(e.path);
			if(meta?.created) {
				d.created = meta.created.getTime();
			}
			if(meta?.attributes !== undefined) {
				d.attributes = meta.attributes;
			}
		}
		return d;
	},

	async contents(slice: number): Promise<Contents> {
		let m = await measure(await snapshot(slice));
		return { files: m.files, folders: m.directories, bytes: m.bytes };
	},

	async measure(slice: number, paths: string[]): Promise<Contents> {
		let m = await measure(await snapshot(slice), paths);
		return { files: m.files, folders: m.directories, bytes: m.bytes };
	},

	async copy(jobId: string, slice: number, paths: string[], dest: string, policy: ConflictPolicy): Promise<CopyResult> {
		return runCopy(jobId, slice, paths, dest, policy, false);
	},

	async stage(jobId: string, slice: number, paths: string[], dir: string, readOnly: boolean): Promise<CopyResult> {
		await fs.promises.mkdir(dir, { recursive: true });
		return runCopy(jobId, slice, paths, dir, 'rename', readOnly);
	},

	async cancel(jobId: string): Promise<void> {
		let job = jobs.get(jobId);
		if(job) {
			job.abort.abort();
			for(let resolve of job.pending.values()) {
				resolve('abort');
			}
			job.pending.clear();
		}
	},

	async answer(jobId: string, conflictId: number, choice: ConflictChoice, applyToAll: boolean): Promise<void> {
		let job = jobs.get(jobId);
		let resolve = job?.pending.get(conflictId);
		if(!job || !resolve) {
			return;
		}
		if(applyToAll && choice !== 'abort') {
			job.always = choice;
		}
		job.pending.delete(conflictId);
		resolve(choice);
	},
};


const LIBRARY_CODES = new Set(['not-a-backup', 'unexpected-name', 'missing-part', 'damaged', 'encrypted', 'disk-image', 'unsupported']);

function toErrorInfo(e: any): ErrorInfo {
	let message = e && e.message ? String(e.message) : String(e);

	if(e && e.name === 'AbortError') {
		return { code: 'cancelled', message: 'Stopped' };
	}
	if(e && (e.name === 'FormatError' || e.name === 'NotSupportedError') && LIBRARY_CODES.has(e.code)) {
		return { code: e.code, message };
	}
	if(e && e.code === 'ENOSPC') {
		return { code: 'no-space', message };
	}
	if(e && (e.code === 'not-found' || e.code === 'ENOENT' || /^File not found/.test(message))) {
		return { code: 'not-found', message };
	}
	if(e && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code)) {
		return { code: 'io', message };
	}
	return { code: 'internal', message };
}

async function handle(req: Extract<EngineRequest, { type: 'request' }>) {
	let result: Result<unknown>;
	try {
		let fn = (handlers as any)[req.method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
		if(!fn) {
			throw new Error('Unknown request: ' + req.method);
		}
		result = { ok: true, value: await fn(...req.args) };
	}
	catch(e) {
		result = { ok: false, error: toErrorInfo(e) };
	}
	send({ type: 'response', id: req.id, result });
}


setWarningHandler((message) => send({ type: 'event', event: { name: 'warning', message } }));

async function shutdown() {
	try {
		if(archive) {
			await archive.close();
		}
	}
	finally {
		process.exit(0);
	}
}

port.on('message', (e) => {
	let msg = e.data as EngineRequest;
	if(msg && msg.type === 'request') {
		void handle(msg);
	}
	else if(msg && msg.type === 'shutdown') {
		void shutdown();
	}
});
