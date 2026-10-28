import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, type IpcMainInvokeEvent } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EngineHost } from './engine-host';
import { configureDataFolder, Settings } from './settings';
import type { AppEvent, AppInfo, EngineMethod, Result, Session } from '../shared/api';


const portable = configureDataFolder();

if(!app.requestSingleInstanceLock()) {
	// Another TibReader is running; it gets our files through 'second-instance'
	app.quit();
}
else {
	start();
}


interface SessionEntry {
	host: EngineHost;
	/** webContents id of the window that opened it */
	owner: number;
}

const sessions = new Map<string, SessionEntry>();
/** The backup each new window should open, by webContents id */
const initialFiles = new Map<number, string>();
let settings: Settings;

const ENGINE_METHODS = new Set<EngineMethod>(['open', 'list', 'stat', 'details', 'contents']);


function start() {
	app.on('second-instance', (_e, argv, workingDirectory) => {
		let files = backupFilesIn(argv.slice(1), workingDirectory);
		if(files.length === 0) {
			focusAnyWindow();
		}
		for(let f of files) {
			createWindow(f);
		}
	});

	app.on('web-contents-created', (_e, contents) => {
		// Nothing in the app opens other windows or navigates away; links go through shell explicitly
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
		contents.on('will-navigate', (e, url) => {
			if(!isAppUrl(url)) {
				e.preventDefault();
			}
		});
		contents.on('will-attach-webview', (e) => e.preventDefault());
	});

	app.on('window-all-closed', () => app.quit());

	let quitting = false;
	app.on('will-quit', (e) => {
		if(sessions.size > 0 && !quitting) {
			quitting = true;
			e.preventDefault();
			void closeAllSessions().finally(() => app.quit());
		}
	});

	void app.whenReady().then(() => {
		settings = new Settings();
		Menu.setApplicationMenu(null);
		registerIpc();

		let files = backupFilesIn(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());
		if(files.length === 0) {
			createWindow();
		}
		for(let f of files) {
			createWindow(f);
		}
	});
}


function backupFilesIn(args: string[], cwd: string): string[] {
	return args
		.filter((a) => !a.startsWith('-') && /\.tib(\.metadata)?$/i.test(a))
		.map((a) => path.resolve(cwd, a))
		.filter((f) => fs.existsSync(f));
}

function focusAnyWindow() {
	let w = BrowserWindow.getAllWindows()[0];
	if(w) {
		if(w.isMinimized()) {
			w.restore();
		}
		w.focus();
	}
}

function rendererUrl(): string | undefined {
	return !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
}

function isAppUrl(url: string): boolean {
	let dev = rendererUrl();
	if(dev) {
		return url.startsWith(dev);
	}
	return url.startsWith('file://');
}


function createWindow(file?: string): BrowserWindow {
	let dark = nativeTheme.shouldUseDarkColors;
	let background = dark ? '#1f1f1f' : '#f5f5f5';

	let win = new BrowserWindow({
		width: 1180,
		height: 760,
		minWidth: 760,
		minHeight: 480,
		show: false,
		title: 'TibReader',
		backgroundColor: background,
		titleBarStyle: 'hidden',
		titleBarOverlay: { color: background, symbolColor: dark ? '#ffffff' : '#242424', height: 40 },
		webPreferences: {
			preload: path.join(__dirname, '../preload/index.js'),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
			spellcheck: false,
		},
	});

	let id = win.webContents.id;
	if(file) {
		initialFiles.set(id, file);
	}

	win.once('ready-to-show', () => win.show());

	win.on('closed', () => {
		initialFiles.delete(id);
		for(let [sid, s] of sessions) {
			if(s.owner === id) {
				void closeSession(sid);
			}
		}
	});

	if(!app.isPackaged) {
		// Developer tools in development builds only
		win.webContents.on('before-input-event', (_e, input) => {
			if(input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
				win.webContents.toggleDevTools();
			}
		});
	}

	let dev = rendererUrl();
	if(dev) {
		void win.loadURL(dev);
	}
	else {
		void win.loadFile(path.join(__dirname, '../renderer/index.html'));
	}

	return win;
}


function sendEvent(ownerId: number, event: AppEvent) {
	let win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === ownerId);
	if(win && !win.webContents.isDestroyed()) {
		win.webContents.send('app:event', event);
	}
}

function engineEnv(): NodeJS.ProcessEnv {
	let env = { ...process.env };

	// Prefer the rclone that ships with the app (see electron-builder.yml); fall back to an installed one
	let bundled = app.isPackaged
		? path.join(process.resourcesPath, 'rclone', 'rclone.exe')
		: path.join(app.getAppPath(), 'vendor', 'rclone', 'rclone.exe');
	if(fs.existsSync(bundled)) {
		env.TIB_RCLONE = bundled;
	}
	return env;
}

async function openSession(owner: number, file: string): Promise<Result<Session>> {
	let host = new EngineHost(engineEnv());
	let id = crypto.randomUUID();

	host.onEvent = (ev) => {
		if(ev.name === 'warning') {
			sendEvent(owner, { name: 'warning', sessionId: id, message: ev.message });
		}
	};

	let result = await host.request('open', [file]);
	if(!result.ok) {
		await host.shutdown();
		return result;
	}

	host.onCrash = (code) => {
		sessions.delete(id);
		sendEvent(owner, { name: 'session-lost', sessionId: id, message: 'The backup process stopped unexpectedly (exit code ' + code + ').' });
	};

	sessions.set(id, { host, owner });
	settings.addRecent(result.value.file, result.value.name);
	return { ok: true, value: { id, info: result.value } };
}

async function closeSession(id: string) {
	let s = sessions.get(id);
	if(s) {
		sessions.delete(id);
		await s.host.shutdown();
	}
}

async function closeAllSessions() {
	await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
}

/** The session, if the window asking owns it */
function ownedSession(e: IpcMainInvokeEvent, id: unknown): SessionEntry | undefined {
	let s = typeof id === 'string' ? sessions.get(id) : undefined;
	return s && s.owner === e.sender.id ? s : undefined;
}


function registerIpc() {
	ipcMain.handle('app:info', (): AppInfo => ({ version: app.getVersion(), portable }));

	ipcMain.handle('dialog:pick-backup', async (e) => {
		let win = BrowserWindow.fromWebContents(e.sender);
		let options: Electron.OpenDialogOptions = {
			title: 'Open a backup',
			properties: ['openFile'],
			filters: [
				{ name: 'Acronis True Image backups', extensions: ['tib', 'metadata'] },
				{ name: 'All files', extensions: ['*'] },
			],
		};
		let r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
	});

	ipcMain.handle('window:take-initial-file', (e) => {
		let f = initialFiles.get(e.sender.id) ?? null;
		initialFiles.delete(e.sender.id);
		return f;
	});

	ipcMain.handle('window:open', (_e, file: unknown) => {
		if(typeof file === 'string' && file.length > 0) {
			createWindow(file);
		}
	});

	ipcMain.on('window:title-bar-colors', (e, background: unknown, symbols: unknown) => {
		let color = /^#[0-9a-f]{6}$/i;
		let win = BrowserWindow.fromWebContents(e.sender);
		if(win && typeof background === 'string' && typeof symbols === 'string' && color.test(background) && color.test(symbols)) {
			win.setTitleBarOverlay({ color: background, symbolColor: symbols, height: 40 });
			win.setBackgroundColor(background);
		}
	});

	ipcMain.handle('session:open', (e, file: unknown) => {
		if(typeof file !== 'string' || file.length === 0) {
			return { ok: false, error: { code: 'internal', message: 'No file given' } };
		}
		return openSession(e.sender.id, file);
	});

	ipcMain.handle('session:close', async (e, id: unknown) => {
		if(ownedSession(e, id)) {
			await closeSession(id as string);
		}
	});

	ipcMain.handle('session:call', (e, id: unknown, method: unknown, args: unknown) => {
		let s = ownedSession(e, id);
		if(!s) {
			return { ok: false, error: { code: 'engine', message: 'This backup is no longer open' } };
		}
		if(typeof method !== 'string' || !ENGINE_METHODS.has(method as EngineMethod) || method === 'open' || !Array.isArray(args)) {
			return { ok: false, error: { code: 'internal', message: 'Bad request' } };
		}
		return s.host.request(method as EngineMethod, args as any);
	});

	ipcMain.handle('recent:list', () => settings.recent());
	ipcMain.handle('recent:forget', (_e, file: unknown) => {
		if(typeof file === 'string') {
			settings.forgetRecent(file);
		}
	});
}
