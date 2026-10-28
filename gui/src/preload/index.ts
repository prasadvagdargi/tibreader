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
};

contextBridge.exposeInMainWorld('tib', bridge);
