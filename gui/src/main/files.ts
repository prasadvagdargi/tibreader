import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineHost } from './engine-host';
import type { Settings } from './settings';
import { setClipboardFiles } from './clipboard';
import { isInside, isInStaging, newStagingDir } from './staging';
import type { ConflictPolicy, CopyResult, MountInfo, Result } from '../shared/api';


/** Dragging needs the files ready before the mouse button is let go, so big selections use Copy to... */
const DRAG_LIMIT = 200 * 1024 * 1024;

const POLICIES = new Set<ConflictPolicy>(['ask', 'overwrite', 'skip', 'rename']);

type SessionLookup = (e: IpcMainInvokeEvent, id: unknown) => { host: EngineHost; mounted?: MountInfo } | undefined;
/** Drive letters (like "R:") of the backups a window has mounted */
type LettersOf = (webContentsId: number) => string[];

/**
 * Where items are on the mounted drive, when this backup point is mounted. Null if it isn't, or if a
 * name wouldn't work on Windows (then a temporary copy, with a fixed-up name, is used instead).
 */
function onDrive(mounted: MountInfo | undefined, slice: number, paths: string[]): string[] | null {
	if(!mounted || mounted.slice !== slice) {
		return null;
	}
	let out: string[] = [];
	for(let p of paths) {
		let parts = p.split('/').filter((x) => x.length > 0);
		if(parts.some((x) => /[<>:"\\|?*\u0000-\u001f]/.test(x) || /[. ]$/.test(x))) {
			return null;
		}
		out.push(mounted.letter + '\\' + parts.join('\\'));
	}
	return out;
}

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
export function registerFileIpc(lookup: SessionLookup, settings: Settings, lettersOf: LettersOf) {
	/** Folders picked in dialogs, by webContents id */
	let approved = new Map<number, string[]>();

	let isApproved = (e: IpcMainInvokeEvent, p: string) =>
		(approved.get(e.sender.id) || []).some((folder) => isInside(p, folder));

	/** Somewhere TibReader put files for this window: a picked folder, a temporary copy, or its mounted drive */
	let isOurs = (e: IpcMainInvokeEvent, p: string) =>
		isApproved(e, p) || isInStaging(p) || lettersOf(e.sender.id).some((l) => isInside(p, l + '\\'));

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

		// Mounted: open it straight from the (read-only) drive
		let file = onDrive(s.mounted, slice, [p as string])?.[0];
		if(!file) {
			let r = await stage(s.host, jobId, slice, [p as string], true);
			if(!r.ok) {
				return r;
			}
			file = r.value.items[0];
		}
		let problem = await shell.openPath(file);
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

		// Mounted: Explorer pastes straight from the drive, with nothing copied first
		let files = onDrive(s.mounted, slice, paths);
		if(!files) {
			let r = await stage(s.host, jobId, slice, paths, false);
			if(!r.ok) {
				return r;
			}
			files = r.value.items;
		}
		try {
			await setClipboardFiles(files);
			return { ok: true, value: files.length };
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

		// Mounted: any size can be dragged, since the files are already there
		let files = onDrive(s.mounted, slice, paths);
		if(!files) {
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
			files = r.value.items;
		}

		let icon = await app.getFileIcon(files[0], { size: 'normal' });
		e.sender.startDrag({ file: files[0], files, icon });
		return { ok: true, value: 'started' };
	});

	// Opening something TibReader wrote: a copy being edited, or a destination folder
	ipcMain.handle('files:open-path', async (e, p: unknown): Promise<Result<void>> => {
		if(!isString(p) || !isOurs(e, p)) {
			return fail('not-allowed', 'Not a file TibReader copied');
		}
		let problem = await shell.openPath(p);
		return problem ? fail('io', problem) : { ok: true, value: undefined };
	});

	ipcMain.handle('files:show-in-folder', (e, p: unknown) => {
		if(isString(p) && isOurs(e, p)) {
			shell.showItemInFolder(path.normalize(p));
		}
	});

	// "Show in mounted drive": File Explorer, on the drive letter, with the item selected
	ipcMain.handle('files:show-on-drive', (e, sid: unknown, slice: unknown, p: unknown): Result<void> => {
		let s = lookup(e, sid);
		let file = s && isSlice(slice) && isPaths([p]) ? onDrive(s.mounted, slice, [p as string])?.[0] : undefined;
		if(!file) {
			return fail('not-allowed', 'This backup point isn\'t mounted');
		}
		shell.showItemInFolder(file);
		return { ok: true, value: undefined };
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
