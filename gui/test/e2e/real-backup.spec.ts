import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, tempDir } from './helpers';


/**
 * The app on a real backup, when TIB_SAMPLE points at one (like the library's real-backup test).
 * The backup is only ever read.
 */
const sample = process.env.TIB_SAMPLE;
test.skip(!sample || !fs.existsSync(sample), 'set TIB_SAMPLE to a real backup');

// The library, built by "npm run build" in the repository root, to compare what the app copies
const library = path.resolve(__dirname, '../../../dist/index.js');

test('a real backup opens, browses, searches and copies exact bytes', async () => {
	test.setTimeout(10 * 60 * 1000);
	let dest = tempDir();
	let { app, win } = await launch([sample!]);
	try {
		let list = win.getByRole('grid', { name: 'Files and folders' });
		let firstRow = list.getByRole('row').nth(1);
		await expect(firstRow).toBeVisible({ timeout: 60000 });
		await win.screenshot({ path: 'test-results/real-top.png' });

		// The Info panel counts everything in the backup point
		await win.getByRole('button', { name: 'Backup info' }).click();
		await expect(win.getByText(/\d[\d,.]* files, [\d,.]+ folders/).first()).toBeVisible({ timeout: 120000 });
		let counts = await win.getByText(/\d[\d,.]* files, [\d,.]+ folders/).first().textContent();
		console.log('Contents: ' + counts);
		await win.keyboard.press('Escape');

		// A small real file to look for, found by the library (read-only)
		let lib = require(library);
		let archive = await lib.openArchive(sample);
		try {
			let snap = await archive.getSlice().openFileSystem();
			let target: { path: string; name: string; size: number; mtime: Date } | undefined;
			for await (let e of snap.walk()) {
				if(e.type === 'file' && e.size > 1024 && e.size < 8 * 1024 * 1024 && !/[*?]/.test(e.name)) {
					target = e;
					break;
				}
			}
			expect(target, 'a small file in the backup').toBeDefined();

			// Search the whole backup for it by name
			await win.getByRole('searchbox').fill(target!.name);
			await expect(win.getByRole('contentinfo')).toContainText(/result/, { timeout: 120000 });
			console.log('Search: ' + (await win.getByRole('contentinfo').textContent()));
			let folder = target!.path.slice(0, target!.path.lastIndexOf('/'));
			let shownFolder = folder.slice(1, 2) + ':\\' + folder.split('/').slice(2).join('\\');
			let row = list.getByRole('row').filter({ hasText: shownFolder }).filter({ hasText: target!.name }).first();
			await expect(row).toBeVisible();
			await win.screenshot({ path: 'test-results/real-search.png' });

			// Copy it out; the bytes and date match what the library reads
			await row.click();
			await app.evaluate(({ dialog }, f) => {
				dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
			}, dest);
			await win.getByRole('button', { name: 'Copy to...' }).click();
			await expect(win.getByText('Copied to ' + path.basename(dest)).first()).toBeVisible({ timeout: 120000 });

			let copied = fs.readdirSync(dest);
			expect(copied.length).toBe(1);
			console.log('Copied ' + target!.path + ' (' + target!.size + ' bytes) -> ' + copied[0]);
			let original = await snap.read(target!.path, 0, target!.size);
			expect(fs.readFileSync(path.join(dest, copied[0])).equals(original)).toBe(true);
			expect(fs.statSync(path.join(dest, copied[0])).mtime.getTime()).toBe(target!.mtime.getTime());
		}
		finally {
			await archive.close();
		}
	}
	finally {
		await app.close();
		fs.rmSync(dest, { recursive: true, force: true });
	}
});
