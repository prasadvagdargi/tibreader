import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineHost } from './engine-host';
import type { Settings } from './settings';
import { setClipboardFiles } from './clipboard';
import { isInside, isInStaging, newStagingDir } from './staging';
import type { ConflictPolicy, CopyResult, Result } from '../shared/api';


/** Dragging needs the files ready before the mouse button is let go, so big selections use Copy to... */
const DRAG_LIMIT = 200 * 1024 * 1024;

const POLICIES = new Set<ConflictPolicy>(['ask', 'overwrite', 'skip', 'rename']);

type SessionLookup = (e: IpcMainInvokeEvent, id: unknown) => { host: EngineHost } | undefined;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPaths = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string' && p.startsWith('/'));
const isSlice = (v: unknown): v is number => Number.isInteger(v);

function fail<T>(code: 'not-allowed' | 'internal' | 'io' | 'engine', message: string): Result<T> {
	return { ok: false, error: { code, message } };
}


/**
 * Everything that writes files or talks to Windows on a window's behalf. A window can only copy into
 * folders the user picked in a folder dialog, so a misbehaving page can't write anywhere else.
 */
export function registerFileIpc(lookup: SessionLookup, settings: Settings) {
	/** Folders picked in dialogs, by webContents id */
	let approved = new Map<number, string[]>();

	let isApproved = (e: IpcMainInvokeEvent, p: string) =>
		(approved.get(e.sender.id) || []).some((folder) => isInside(p, folder));

	let stage = async (host: EngineHost, jobId: string, slice: number, paths: string[], readOnly: boolean): Promise<Result<CopyResult>> =>
		host.request('stage', [jobId, slice, paths, newStagingDir(), readOnly]);

	ipcMain.handle('files:pick-folder', async (e, purpose: unknown) => {
		let win = BrowserWindow.fromWebContents(e.sender);
		let labels: Record<string, [string, string]> = {
			copy: ['Copy to', 'Copy here'],
			restore: ['Restore to', 'Restore here'],
			edit: ['Save a copy to edit in', 'Save here'],
		};
		let [title, buttonLabel] = labels[String(purpose)] || labels.copy;

		let options: Electron.OpenDialogOptions = {
			title,
			buttonLabel,
			defaultPath: settings.lastFolder && fs.existsSync(settings.lastFolder) ? settings.lastFolder : app.getPath('documents'),
			properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
		};
		let r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		if(r.canceled || r.filePaths.length === 0) {
			return null;
		}

		let folder = r.filePaths[0];
		await fs.promises.mkdir(folder, { recursive: true }).catch(() => {});
		approved.set(e.sender.id, [...(approved.get(e.sender.id) || []), folder]);
		settings.lastFolder = folder;
		return folder;
	});

	ipcMain.handle('files:copy', async (e, sid: unknown, jobId: unknown, slice: unknown, paths: unknown, dest: unknown, policy: unknown) => {
		let s = lookup(e, sid);
		if(!s) {
			return fail('engine', 'This backup is no longer open');
		}
		if(!isString(jobId) || !isSlice(slice) || !isPaths(paths) || !isString(dest) || !POLICIES.has(policy as ConflictPolicy)) {
			return fail('internal', 'Bad request');
		}
		if(!isApproved(e, dest)) {
			return fail('not-allowed', 'Choose the destination folder first');
		}
		return s.host.request('copy', [jobId, slice, paths, dest, policy as ConflictPolicy]);
	});

	// Opens a read-only temporary copy with the file's usual app
	ipcMain.handle('files:open', async (e, sid: unknown, jobId: unknown, slice: unknown, p: unknown): Promise<Result<void>> => {
		let s = lookup(e, sid);
		if(!s) {
			return fail('engine', 'This backup is no longer open');
		}
		if(!isString(jobId) || !isSlice(slice) || !isPaths([p])) {
			return fail('internal', 'Bad request');
		}

		let r = await stage(s.host, jobId, slice, [p as string], true);
		if(!r.ok) {
			return r;
		}
		let problem = await shell.openPath(r.value.items[0]);
		return problem ? fail('io', problem) : { ok: true, value: undefined };
	});

	// Ctrl+C: temporary copies, put on the clipboard as files
	ipcMain.handle('files:clipboard', async (e, sid: unknown, jobId: unknown, slice: unknown, paths: unknown): Promise<Result<number>> => {
		let s = lookup(e, sid);
		if(!s) {
			return fail('engine', 'This backup is no longer open');
		}
		if(!isString(jobId) || !isSlice(slice) || !isPaths(paths)) {
			return fail('internal', 'Bad request');
		}

		let r = await stage(s.host, jobId, slice, paths, false);
		if(!r.ok) {
			return r;
		}
		try {
			await setClipboardFiles(r.value.items);
			return { ok: true, value: r.value.items.length };
		}
		catch(err: any) {
			return fail('io', err.message);
		}
	});

	// Dragging rows out to File Explorer or the desktop
	ipcMain.handle('files:drag', async (e, sid: unknown, slice: unknown, paths: unknown): Promise<Result<'started' | 'too-big'>> => {
		let s = lookup(e, sid);
		if(!s) {
			return fail('engine', 'This backup is no longer open');
		}
		if(!isSlice(slice) || !isPaths(paths)) {
			return fail('internal', 'Bad request');
		}

		let size = await s.host.request('measure', [slice, paths]);
		if(!size.ok) {
			return size;
		}
		if(size.value.bytes > DRAG_LIMIT) {
			return { ok: true, value: 'too-big' };
		}

		let r = await stage(s.host, crypto.randomUUID(), slice, paths, false);
		if(!r.ok) {
			return r;
		}

		let files = r.value.items;
		let icon = await app.getFileIcon(files[0], { size: 'normal' });
		e.sender.startDrag({ file: files[0], files, icon });
		return { ok: true, value: 'started' };
	});

	// Opening something TibReader wrote: a copy being edited, or a destination folder
	ipcMain.handle('files:open-path', async (e, p: unknown): Promise<Result<void>> => {
		if(!isString(p) || !(isApproved(e, p) || isInStaging(p))) {
			return fail('not-allowed', 'Not a file TibReader copied');
		}
		let problem = await shell.openPath(p);
		return problem ? fail('io', problem) : { ok: true, value: undefined };
	});

	ipcMain.handle('files:show-in-folder', (e, p: unknown) => {
		if(isString(p) && (isApproved(e, p) || isInStaging(p))) {
			shell.showItemInFolder(path.normalize(p));
		}
	});

	ipcMain.handle('files:free-space', async (e, folder: unknown): Promise<number | null> => {
		if(!isString(folder) || !isApproved(e, folder)) {
			return null;
		}
		try {
			let st = await fs.promises.statfs(folder);
			return st.bavail * st.bsize;
		}
		catch(err) {
			return null;
		}
	});

	return {
		forget(webContentsId: number) {
			approved.delete(webContentsId);
		},
	};
}
