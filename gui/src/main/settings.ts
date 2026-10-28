import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { RecentBackup } from '../shared/api';


/**
 * Portable builds keep their settings next to the program instead of in %APPDATA%:
 * - the single-file portable exe (electron-builder sets PORTABLE_EXECUTABLE_DIR), or
 * - the zip build: a packaged app with no uninstaller next to it (the installer puts one there).
 * A read-only location falls back to %APPDATA%. Must run before the app is ready. Returns true if
 * settings are kept next to the program.
 */
export function configureDataFolder(): boolean {
	// Tests run the app with their own empty settings folder
	if(process.env.TIBREADER_USER_DATA) {
		app.setPath('userData', process.env.TIBREADER_USER_DATA);
		return false;
	}

	let base: string | undefined;
	if(process.env.PORTABLE_EXECUTABLE_DIR) {
		base = process.env.PORTABLE_EXECUTABLE_DIR;
	}
	else if(app.isPackaged && !fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall ' + app.getName() + '.exe'))) {
		base = path.dirname(process.execPath);
	}

	if(!base) {
		return false;
	}

	let dir = path.join(base, 'TibReader Data');
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.accessSync(dir, fs.constants.W_OK);
	}
	catch(e) {
		// Read-only location (e.g. a locked USB stick): fall back to the normal folder
		return false;
	}

	app.setPath('userData', dir);
	// Chromium's caches stay on this computer, so a USB stick only gets the settings
	app.setPath('sessionData', path.join(app.getPath('temp'), 'TibReader', 'session'));
	return true;
}


interface StoredSettings {
	recent: Array<{ file: string; name: string; lastOpened: number }>;
	/** The folder last copied into, offered next time */
	lastFolder?: string;
	theme?: 'system' | 'light' | 'dark';
}

const MAX_RECENT = 12;

/**
 * Settings saved as JSON in the app's data folder
 */
export class Settings {

	private _data: StoredSettings = { recent: [] };
	private _file: string;
	private _saving: Promise<void> = Promise.resolve();

	constructor() {
		this._file = path.join(app.getPath('userData'), 'settings.json');
		try {
			let parsed = JSON.parse(fs.readFileSync(this._file, 'utf8'));
			if(parsed && Array.isArray(parsed.recent)) {
				this._data.recent = parsed.recent.filter((r: any) =>
					r && typeof r.file === 'string' && typeof r.name === 'string' && typeof r.lastOpened === 'number');
			}
			if(parsed && typeof parsed.lastFolder === 'string') {
				this._data.lastFolder = parsed.lastFolder;
			}
			if(parsed && ['system', 'light', 'dark'].includes(parsed.theme)) {
				this._data.theme = parsed.theme;
			}
		}
		catch(e) {
			// First start, or an unreadable file: start fresh
		}
	}

	async recent(): Promise<RecentBackup[]> {
		return Promise.all(this._data.recent.map(async (r) => ({
			...r,
			exists: await fs.promises.access(r.file).then(() => true, () => false),
		})));
	}

	addRecent(file: string, name: string) {
		let key = file.toLowerCase();
		this._data.recent = [
			{ file, name, lastOpened: Date.now() },
			...this._data.recent.filter((r) => r.file.toLowerCase() !== key),
		].slice(0, MAX_RECENT);
		this.save();
	}

	get theme(): 'system' | 'light' | 'dark' {
		return this._data.theme || 'system';
	}

	set theme(theme: 'system' | 'light' | 'dark') {
		this._data.theme = theme;
		this.save();
	}

	get lastFolder(): string | undefined {
		return this._data.lastFolder;
	}

	set lastFolder(folder: string | undefined) {
		this._data.lastFolder = folder;
		this.save();
	}

	forgetRecent(file: string) {
		let key = file.toLowerCase();
		this._data.recent = this._data.recent.filter((r) => r.file.toLowerCase() !== key);
		this.save();
	}

	/** Writes a new file and renames it over the old one, so a crash never leaves half a file */
	private save() {
		let text = JSON.stringify(this._data, null, '\t');
		this._saving = this._saving.then(async () => {
			let tmp = this._file + '.tmp';
			try {
				await fs.promises.mkdir(path.dirname(this._file), { recursive: true });
				await fs.promises.writeFile(tmp, text, 'utf8');
				await fs.promises.rename(tmp, this._file);
			}
			catch(e) {
				console.error('Could not save settings:', e);
			}
		});
	}
}
