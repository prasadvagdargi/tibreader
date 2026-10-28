/// <reference types="electron" />
/**
 * The backup engine: an Electron utility process that owns one open backup.
 *
 * The library decompresses and checks MD5s synchronously, and (once mounted) serves the backup's drive,
 * so it runs here instead of in the window or main process. Main sends requests over parentPort.
 */
import {
	openArchive, describeArchive, measure, setWarningHandler, WindowsFS,
	type Archive, type SnapshotFS, type FsEntry
} from 'tibreader';
import type {
	BackupInfo, Contents, EngineMessage, EngineMethods, EngineRequest, Entry, EntryDetails, ErrorInfo, Result
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
};


const LIBRARY_CODES = new Set(['not-a-backup', 'unexpected-name', 'missing-part', 'damaged', 'encrypted', 'disk-image', 'unsupported']);

function toErrorInfo(e: any): ErrorInfo {
	let message = e && e.message ? String(e.message) : String(e);

	if(e && (e.name === 'FormatError' || e.name === 'NotSupportedError') && LIBRARY_CODES.has(e.code)) {
		return { code: e.code, message };
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
