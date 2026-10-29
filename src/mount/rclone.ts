import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { NotSupportedError } from '../errors';


/**
 * Finds the rclone executable: $TIB_RCLONE, then PATH, then winget's link folder (Windows).
 */
export function findRclone(): string | null {
	let env = process.env.TIB_RCLONE;
	if(env && fs.existsSync(env)) {
		return env;
	}

	let exe = process.platform === 'win32' ? 'rclone.exe' : 'rclone';
	let dirs = (process.env.PATH || '').split(path.delimiter).filter((d) => d.length > 0);

	if(process.platform === 'win32' && process.env.LOCALAPPDATA) {
		// winget adds this to PATH, but already-open terminals don't see it yet
		dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
	}

	for(let d of dirs) {
		let candidate = path.join(d, exe);
		if(fs.existsSync(candidate)) {
			return candidate;
		}
	}

	// winget may only add rclone's own folder to the user PATH, which running programs don't see
	if(process.platform === 'win32' && process.env.LOCALAPPDATA) {
		let found = findInWingetPackages(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'));
		if(found) {
			return found;
		}
	}

	return null;
}

function findInWingetPackages(packagesDir: string): string | null {
	try {
		for(let pkg of fs.readdirSync(packagesDir)) {
			if(!pkg.startsWith('Rclone.Rclone_')) {
				continue;
			}

			// e.g. Rclone.Rclone_.../rclone-v1.75.1-windows-amd64/rclone.exe; newest version last
			let versions = fs.readdirSync(path.join(packagesDir, pkg)).filter((d) => d.startsWith('rclone-')).sort();
			for(let i = versions.length - 1; i >= 0; i--) {
				let candidate = path.join(packagesDir, pkg, versions[i], 'rclone.exe');
				if(fs.existsSync(candidate)) {
					return candidate;
				}
			}
		}
	}
	catch(e) {
		// No winget packages folder
	}

	return null;
}

/**
 * Finds WinFsp, the driver rclone needs for drive letters on Windows. Returns its install folder, or
 * null if it isn't installed (or this isn't Windows).
 */
export async function findWinFsp(): Promise<string | null> {
	if(process.platform !== 'win32') {
		return null;
	}

	let dirs = [ process.env['ProgramFiles(x86)'], process.env.ProgramFiles ]
		.filter((d): d is string => !!d)
		.map((d) => path.join(d, 'WinFsp'));

	for(let d of dirs) {
		if(await pathExists(path.join(d, 'bin', 'winfsp-x64.dll'))) {
			return d;
		}
	}

	// Installed somewhere else: the installer records the folder in the registry
	let out = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
		[ 'query', 'HKLM\\SOFTWARE\\WOW6432Node\\WinFsp', '/v', 'InstallDir' ]);
	let m = out && /InstallDir\s+REG_SZ\s+(.+)/.exec(out);
	if(m) {
		let d = m[1].trim().replace(/[\\/]+$/, '');
		if(await pathExists(path.join(d, 'bin', 'winfsp-x64.dll'))) {
			return d;
		}
	}

	return null;
}

/**
 * Drive letters (e.g. "R:") that nothing uses on this computer, from Z: down to D:. Windows only.
 */
export async function freeDriveLetters(): Promise<string[]> {
	if(process.platform !== 'win32') {
		return [];
	}

	let used = new Set<string>();

	// Lists every letter in use, including empty card readers and network drives
	let out = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
		[ '-NoProfile', '-NonInteractive', '-Command', '[System.IO.Directory]::GetLogicalDrives() -join ","' ]);

	if(out !== null) {
		for(let d of out.split(',')) {
			let m = /^([A-Za-z]):/.exec(d.trim());
			if(m) {
				used.add(m[1].toUpperCase());
			}
		}
	}
	else {
		// No PowerShell: probe each letter instead (misses empty card readers)
		await Promise.all(LETTERS.map(async (l) => {
			if(await pathExists(l + ':\\')) {
				used.add(l);
			}
		}));
	}

	return LETTERS.filter((l) => !used.has(l)).reverse().map((l) => l + ':');
}

const LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Runs a program and returns its output, or null if it couldn't run or failed */
function run(file: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		let child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
		let out = '';
		child.stdout!.on('data', (d) => { out += d.toString(); });
		child.on('error', () => resolve(null));
		child.on('close', (code) => resolve(code === 0 ? out : null));
	});
}

/**
 * Accepts "R" or "R:" on Windows (returns "R:"); anything else is used as a folder path
 */
export function normalizeDriveTarget(target: string, platform: NodeJS.Platform = process.platform): string {
	if(platform === 'win32' && /^[A-Za-z]:?$/.test(target)) {
		return target[0].toUpperCase() + ':';
	}

	return target;
}


/**
 * Mounts a WebDAV URL (served by WebDavServer) as a real drive or folder using rclone:
 * WinFsp on Windows, FUSE on Linux/macOS. Unlike Windows' own WebDAV client it has no file size limit.
 */
export class RcloneMount {

	private _child: ChildProcess | null = null;
	private _onExit = () => { this._child?.kill(); };
	private _stopping = false;

	/** Called if rclone stops by itself after mounting (the drive is gone), with its last error output */
	onUnexpectedExit?: (stderr: string) => void;

	/**
	 * @param _isWritable mount writable (the WebDAV server must serve a writable overlay)
	 */
	constructor(private _url: string, private _target: string, private _volumeName = 'Backup', private _isWritable = false) {}

	get target() {
		return this._target;
	}

	/** rclone's process id while mounted */
	get pid(): number | undefined {
		return this._child?.pid;
	}

	async mount(timeoutMs = 30000): Promise<void> {
		let rclone = findRclone();
		if(!rclone) {
			throw new NotSupportedError(
				'Mounting as a drive needs rclone' + (process.platform === 'win32' ? ' and WinFsp' : ' and FUSE') + '. ' +
				(process.platform === 'win32' ? 'Install them with "winget install WinFsp.WinFsp" and "winget install Rclone.Rclone"' : 'See https://rclone.org/install/') +
				' (or set TIB_RCLONE to rclone\'s path). Without them, use the WebDAV address directly.'
			);
		}

		if(process.platform === 'win32' && !(await findWinFsp())) {
			throw new NotSupportedError(
				'Mounting as a drive needs WinFsp. Install it with "winget install WinFsp.WinFsp" (or from https://winfsp.dev), ' +
				'then try again. Without it, use the WebDAV address directly.'
			);
		}

		// NOTE: Only async file system calls are used on the target from here on. The drive is served
		// by this same process, so a synchronous call would block the server and hang forever.
		if(process.platform === 'win32' && await pathExists(rootOf(this._target))) {
			throw new Error('Drive ' + this._target + ' is already in use');
		}

		let args = [
			'mount', ':webdav:', this._target,
			'--webdav-url', this._url,
			'--volname', this._volumeName,
			...(this._isWritable
				// Programs write in place; rclone keeps changed files locally until it uploads them whole
				? [ '--vfs-cache-mode', 'writes', '--dir-cache-time', '5s', '--attr-timeout', '1s' ]
				// The backup never changes, so listings can be cached for as long as the mount lives
				: [ '--read-only', '--dir-cache-time', '1000h', '--attr-timeout', '1h' ]),
		];

		let child = spawn(rclone, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
		this._child = child;

		let stderr = '';
		child.stderr!.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });

		// Don't leave a mount behind if this process exits without unmounting
		process.on('exit', this._onExit);

		let exited = false;
		child.on('exit', () => { exited = true; });

		let started = Date.now();
		let ready = async () => process.platform === 'win32' ? pathExists(rootOf(this._target)) : isMountPoint(this._target);
		while(!(await ready())) {
			if(exited || child.exitCode !== null) {
				this.cleanup();
				throw new Error('rclone could not mount ' + this._target + ': ' + (stderr.trim() || 'exited with code ' + child.exitCode));
			}

			if(Date.now() - started > timeoutMs) {
				await this.unmount();
				throw new Error('Timed out waiting for rclone to mount ' + this._target + (stderr ? ': ' + stderr.trim() : ''));
			}

			await new Promise((r) => setTimeout(r, 250));
		}

		child.once('exit', () => {
			if(!this._stopping && this._child === child) {
				this.cleanup();
				if(this.onUnexpectedExit) {
					this.onUnexpectedExit(stderr.trim());
				}
			}
		});
	}

	async unmount(): Promise<void> {
		let child = this._child;
		if(!child) {
			return;
		}

		this._stopping = true;
		if(child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				let timer = setTimeout(() => { child!.kill('SIGKILL'); resolve(); }, 10000);
				child!.once('exit', () => { clearTimeout(timer); resolve(); });
				// rclone unmounts cleanly on SIGTERM (Linux/macOS); on Windows the WinFsp drive goes away with the process
				child!.kill('SIGTERM');
			});
		}

		this.cleanup();
	}

	private cleanup() {
		this._child = null;
		this._stopping = false;
		process.off('exit', this._onExit);
	}
}

// "R:" alone means the current folder on drive R; "R:\" is its root
function rootOf(target: string) {
	return /^[A-Za-z]:$/.test(target) ? target + '\\' : target;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.promises.access(p);
		return true;
	}
	catch(e) {
		return false;
	}
}

/**
 * On Linux/macOS a folder only becomes a mount point once rclone is ready (its device id changes)
 */
async function isMountPoint(dir: string): Promise<boolean> {
	try {
		let a = await fs.promises.stat(dir);
		let b = await fs.promises.stat(path.dirname(path.resolve(dir)));
		return a.dev !== b.dev;
	}
	catch(e) {
		return false;
	}
}
