import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { fixture } from './helpers';


/**
 * The packaged app (what the zip contains), after "npm run dist". Skipped when it hasn't been built.
 */
const exe = path.resolve(__dirname, '../../release/win-unpacked/TibReader.exe');
const dataDir = path.join(path.dirname(exe), 'TibReader Data');

test.skip(!fs.existsSync(exe), 'run "npm run dist" first');

test('the packaged app runs portable, browses and mounts with its own rclone', async () => {
	test.setTimeout(120000);
	let dir = fixture.tempDir();
	let backup = fixture.writeWindowsBackup(dir, fixture.standardEntries());
	fs.rmSync(dataDir, { recursive: true, force: true });

	let app = await electron.launch({ executablePath: exe, args: [backup] });
	try {
		let win = await app.firstWindow();

		// Settings next to the program, not in %APPDATA%; Chromium's caches stay in %TEMP%
		expect(await app.evaluate(({ app: a }) => a.getPath('userData'))).toBe(dataDir);
		expect(await app.evaluate(({ app: a }) => a.getPath('sessionData'))).not.toContain(dataDir);
		expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true);

		let list = win.getByRole('grid', { name: 'Files and folders' });
		await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();
		await expect(list.getByRole('row', { name: /hello\.txt/ })).toBeVisible();
		await win.screenshot({ path: 'test-results/packaged.png' });

		// The bundled rclone is the one used
		let rclone = path.join(path.dirname(exe), 'resources', 'rclone', 'rclone.exe');
		expect(fs.existsSync(rclone)).toBe(true);

		await win.getByRole('button', { name: 'Mount as drive...' }).click();
		let dialog = win.getByRole('dialog', { name: 'Mount as a drive' });
		let mount = dialog.getByRole('button', { name: 'Mount', exact: true });
		// The dialog first checks for WinFsp and free letters; that can take a while on a slow machine
		await expect(dialog.getByText('Checking...')).toHaveCount(0, { timeout: 30000 });
		if(!(await dialog.getByText('WinFsp is needed').isVisible())) {
			await expect(mount).toBeEnabled({ timeout: 15000 });
			let letter = (await dialog.getByRole('combobox').textContent())!.trim();
			await mount.click();
			await expect(win.getByText('Mounted as ' + letter).first()).toBeVisible({ timeout: 40000 });
			expect(fs.readFileSync(letter + '\\C\\hello.txt', 'utf8')).toBe('hello world\n');

			let recorded = JSON.parse(fs.readFileSync(path.join(dataDir, 'mounts.json'), 'utf8'));
			expect(recorded[0].exe.toLowerCase()).toBe(rclone.toLowerCase());
		}
	}
	finally {
		await app.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// Only settings (and the mount record) are written next to the program
	let written = fs.readdirSync(dataDir).sort();
	expect(written.every((f) => ['settings.json', 'mounts.json'].includes(f)), 'only settings next to the exe, got ' + written.join(', ')).toBe(true);
});
