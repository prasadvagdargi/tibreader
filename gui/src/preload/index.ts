/**
 * The only bridge between the window and the rest of the app. The window runs sandboxed with no
 * Node.js access; it can only use these functions.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { AppEvent, TibBridge } from '../shared/api';


const bridge: TibBridge = {
	appInfo: () => ipcRenderer.invoke('app:info'),
	pickBackup: () => ipcRenderer.invoke('dialog:pick-backup'),
	takeInitialFile: () => ipcRenderer.invoke('window:take-initial-file'),
	openBackup: (file) => ipcRenderer.invoke('session:open', file),
	closeBackup: (sessionId) => ipcRenderer.invoke('session:close', sessionId),
	openInNewWindow: (file) => ipcRenderer.invoke('window:open', file),
	call: (sessionId, method, ...args) => ipcRenderer.invoke('session:call', sessionId, method, args),
	recent: () => ipcRenderer.invoke('recent:list'),
	forgetRecent: (file) => ipcRenderer.invoke('recent:forget', file),
	pathForFile: (file) => webUtils.getPathForFile(file as File),
	setTitleBarColors: (background, symbols) => ipcRenderer.send('window:title-bar-colors', background, symbols),
	onEvent: (listener) => {
		let handler = (_e: IpcRendererEvent, event: AppEvent) => listener(event);
		ipcRenderer.on('app:event', handler);
		return () => {
			ipcRenderer.off('app:event', handler);
		};
	},

	pickFolder: (purpose) => ipcRenderer.invoke('files:pick-folder', purpose),
	copyTo: (sessionId, jobId, slice, paths, dest, policy) => ipcRenderer.invoke('files:copy', sessionId, jobId, slice, paths, dest, policy),
	openFile: (sessionId, jobId, slice, path) => ipcRenderer.invoke('files:open', sessionId, jobId, slice, path),
	copyToClipboard: (sessionId, jobId, slice, paths) => ipcRenderer.invoke('files:clipboard', sessionId, jobId, slice, paths),
	dragOut: (sessionId, slice, paths) => ipcRenderer.invoke('files:drag', sessionId, slice, paths),
	openPath: (path) => ipcRenderer.invoke('files:open-path', path),
	showInFolder: (path) => ipcRenderer.invoke('files:show-in-folder', path),
	freeSpace: (folder) => ipcRenderer.invoke('files:free-space', folder),

	installWinFsp: () => ipcRenderer.invoke('mount:install-winfsp'),
	openDrive: (sessionId) => ipcRenderer.invoke('mount:open-drive', sessionId),
	showOnDrive: (sessionId, slice, path) => ipcRenderer.invoke('files:show-on-drive', sessionId, slice, path),
};

contextBridge.exposeInMainWorld('tib', bridge);
