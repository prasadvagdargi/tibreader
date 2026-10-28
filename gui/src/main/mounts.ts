import { app, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';


/**
 * rclone processes serving a drive letter, saved to disk. If TibReader is ended forcibly (Task Manager,
 * a crash), rclone keeps a dead drive letter around; the next start ends those processes.
 */
interface Recorded {
	pid: number;
	exe: string;
}

function recordFile(): string {
	return path.join(app.getPath('userData'), 'mounts.json');
}

let recorded: Recorded[] = [];

function read(): Recorded[] {
	try {
		let data = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
		return Array.isArray(data) ? data.filter((r) => Number.isInteger(r?.pid) && typeof r?.exe === 'string') : [];
	}
	catch(e) {
		return [];
	}
}

function write() {
	try {
		fs.writeFileSync(recordFile(), JSON.stringify(recorded));
	}
	catch(e) {
		console.error('Could not save mounts:', e);
	}
}

export function recordMount(pid: number, exe: string) {
	recorded = [...recorded.filter((r) => r.pid !== pid), { pid, exe }];
	write();
}

export function forgetMount(pid: number) {
	recorded = recorded.filter((r) => r.pid !== pid);
	write();
}

/** The program file of a running process, or null */
function processPath(pid: number): Promise<string | null> {
	return new Promise((resolve) => {
		let ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		let child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id ' + pid + ' -ErrorAction Stop).Path'],
			{ windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		child.stdout!.on('data', (d) => { out += d.toString(); });
		child.on('error', () => resolve(null));
		child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
	});
}

/** Ends a recorded rclone if it is still running; never touches a different program that reused the id */
export async function endIfOurRclone(pid: number, exe: string): Promise<void> {
	let running = await processPath(pid);
	if(running && path.resolve(running).toLowerCase() === path.resolve(exe).toLowerCase()) {
		try {
			process.kill(pid);
		}
		catch(e) {
			// Already gone
		}
	}
	forgetMount(pid);
}

/** At start: end rclone processes a previous run left behind */
export async function cleanStaleMounts(): Promise<void> {
	recorded = read();
	for(let r of [...recorded]) {
		await endIfOurRclone(r.pid, r.exe);
	}
}


/**
 * Installs WinFsp (the driver rclone needs for drive letters) with winget. Windows shows its own
 * permission prompt, since drivers install for the whole computer. Without winget, opens the website.
 */
export async function installWinFsp(): Promise<'installed' | 'website'> {
	let winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe');
	if(!process.env.LOCALAPPDATA || !fs.existsSync(winget)) {
		await shell.openExternal('https://winfsp.dev/rel/');
		return 'website';
	}

	await new Promise<void>((resolve, reject) => {
		let child = spawn(winget, [
			'install', '--exact', '--id', 'WinFsp.WinFsp', '--source', 'winget',
			'--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
		], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

		let out = '';
		child.stdout!.on('data', (d) => { out += d.toString(); });
		child.stderr!.on('data', (d) => { out += d.toString(); });
		child.on('error', reject);
		child.on('close', (code) => {
			// winget also exits non-zero for "already installed"
			if(code === 0 || /already installed/i.test(out)) {
				resolve();
			}
			else {
				let last = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[-\\|/ █▒]+$/.test(l)).pop();
				reject(new Error('WinFsp could not be installed' + (last ? ': ' + last : ' (winget exit code ' + code + ')')));
			}
		});
	});
	return 'installed';
}
