import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixture, launch } from './helpers';


/** Mounting needs rclone and WinFsp; this machine may not have them (CI doesn't) */
function canMount(): boolean {
	if(process.platform !== 'win32') {
		return false;
	}
	let winfsp = fs.existsSync(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'WinFsp', 'bin', 'winfsp-x64.dll'));
	let rclone = !!process.env.TIB_RCLONE || (() => {
		try {
			execFileSync('where.exe', ['rclone'], { stdio: 'ignore' });
			return true;
		}
		catch(e) {
			return fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'))
				&& fs.readdirSync(path.join(process.env.LOCALAPPDATA!, 'Microsoft', 'WinGet', 'Packages')).some((d) => d.startsWith('Rclone.Rclone_'));
		}
	})();
	return winfsp && rclone;
}

test.skip(!canMount(), 'needs WinFsp and rclone');

let backupDir: string;
let backup: string;

test.beforeAll(() => {
	backupDir = fixture.tempDir();
	backup = fixture.writeWindowsBackup(backupDir, fixture.standardEntries());
});

test.afterAll(() => {
	fs.rmSync(backupDir, { recursive: true, force: true });
});

/** Mounts through the dialog; returns the letter used */
async function mountWithDialog(win: Page): Promise<string> {
	await win.getByRole('button', { name: 'Mount as drive...' }).click();
	// Found by role, so this also checks screen readers can reach the dialog
	let dialog = win.getByRole('dialog', { name: 'Mount as a drive' });
	let mountButton = dialog.getByRole('button', { name: 'Mount', exact: true });
	await expect(mountButton).toBeEnabled({ timeout: 15000 });
	let letter = (await dialog.getByRole('combobox').textContent())!.trim();
	expect(letter).toMatch(/^[D-Z]:$/);
	await mountButton.click();
	await expect(win.getByText('Mounted as ' + letter).first()).toBeVisible({ timeout: 40000 });
	return letter;
}


test('mounts as a drive letter, uses it for copies, and unmounts', async () => {
	let { app, win } = await launch([backup]);
	let letter = '';
	try {
		letter = await mountWithDialog(win);
		await win.screenshot({ path: 'test-results/mounted.png' });

		// Any program can read the backup through the drive
		expect(fs.readFileSync(letter + '\\C\\hello.txt', 'utf8')).toBe('hello world\n');
		expect(fs.readdirSync(letter + '\\C\\Docs').sort()).toEqual(['Café notes.txt', 'Empty folder', 'big.bin', 'sparse.dat']);

		// Ctrl+C now hands Explorer the drive's paths, with nothing copied first
		let list = win.getByRole('grid', { name: 'Files and folders' });
		await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();
		await list.getByRole('row', { name: /hello\.txt/ }).click();
		await win.keyboard.press('Control+c');
		await expect(win.getByText('Copied 1 item').first()).toBeVisible();
		let clip = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'], { encoding: 'utf8' }).trim();
		expect(clip.toLowerCase()).toBe((letter + '\\C\\hello.txt').toLowerCase());

		// Unmount from the drive's menu
		await win.getByRole('button', { name: new RegExp('Drive ' + letter) }).click();
		await win.getByRole('menuitem', { name: 'Unmount' }).click();
		await expect.poll(() => fs.existsSync(letter + '\\'), { timeout: 15000 }).toBe(false);
		await expect(win.getByRole('button', { name: 'Mount as drive...' })).toBeVisible();
	}
	finally {
		await app.close();
		if(letter) {
			await expect.poll(() => fs.existsSync(letter + '\\'), { timeout: 15000 }).toBe(false);
		}
	}
});


test('ending TibReader in Task Manager also removes its drive', async () => {
	let { app, win } = await launch([backup]);
	let letter = await mountWithDialog(win);
	expect(fs.existsSync(letter + '\\C')).toBe(true);

	// The real main process (app.process() is only a launcher on Windows), ended with no chance to
	// unmount. The backup engine notices within seconds and takes the drive down with it.
	let mainPid = await app.evaluate(() => process.pid);
	try {
		process.kill(mainPid);
		await expect.poll(() => fs.existsSync(letter + '\\'), { timeout: 20000 }).toBe(false);
	}
	finally {
		await app.close().catch(() => {});
	}
});


test('the next start ends an rclone a previous run recorded, and nothing else', async () => {
	let { spawn } = await import('node:child_process');
	let { tempDir } = await import('./helpers');

	// Two stand-ins: one recorded with its real program file, one recorded as a different program
	// (as if Windows had given its process id to something else since)
	let ours = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
	let other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
	let oursExited = new Promise((resolve) => ours.once('exit', resolve));
	let userData = tempDir();
	fs.writeFileSync(path.join(userData, 'mounts.json'), JSON.stringify([
		{ pid: ours.pid, exe: process.execPath },
		{ pid: other.pid, exe: 'C:\\Program Files\\Something Else\\rclone.exe' },
	]));

	let { app } = await launch([], userData);
	try {
		await Promise.race([oursExited, new Promise((_r, reject) => setTimeout(() => reject(new Error('the recorded process was not ended')), 20000))]);
		expect(other.exitCode).toBeNull();
		await expect.poll(() => JSON.parse(fs.readFileSync(path.join(userData, 'mounts.json'), 'utf8')).length, { timeout: 10000 }).toBe(0);
	}
	finally {
		other.kill();
		ours.kill();
		await app.close();
	}
});
