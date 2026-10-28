import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { fixture, launch } from './helpers';


// A 1x1 PNG, to check image previews stream from the backup
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let dir: string;
let backup: string;
let damaged: string;

test.beforeAll(() => {
	dir = fixture.tempDir();
	let entries = [
		...fixture.standardEntries(),
		{ path: 'C:/pic.png', kind: 'file', data: PNG, mtime: new Date('2024-01-01T00:00:00Z') },
	];
	fs.mkdirSync(dir + '/good');
	fs.mkdirSync(dir + '/bad');
	backup = fixture.writeWindowsBackup(dir + '/good', entries);
	damaged = fixture.writeWindowsBackup(dir + '/bad', fixture.standardEntries(), { corruptHashOf: 'C:/Docs/big.bin' });
});

test.afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});


test('search finds files below the shown folder', async () => {
	let { app, win } = await launch([backup]);
	try {
		let list = win.getByRole('grid', { name: 'Files and folders' });
		await expect(list.getByRole('row', { name: /Drive \(C:\)/ })).toBeVisible();

		await win.keyboard.press('Control+f');
		await win.keyboard.type('notes');
		let hit = list.getByRole('row', { name: /Café notes\.txt/ });
		await expect(hit).toBeVisible();
		await expect(hit).toContainText('C:\\Docs');
		await expect(win.getByText('1 result')).toBeVisible();
		await win.screenshot({ path: 'test-results/search.png' });

		// Wildcards match whole names
		await win.getByRole('searchbox').fill('*.bin');
		await expect(list.getByRole('row', { name: /big\.bin/ })).toBeVisible();
		await expect(win.getByText('1 result')).toBeVisible();

		await win.getByRole('searchbox').fill('nothing-like-this');
		await expect(win.getByText('Nothing here matches "nothing-like-this".')).toBeVisible();

		// Escape goes back to the folder
		await win.getByRole('searchbox').press('Escape');
		await expect(list.getByRole('row', { name: /Drive \(C:\)/ })).toBeVisible();
	}
	finally {
		await app.close();
	}
});


test('the details pane previews text and images, with properties', async () => {
	let { app, win } = await launch([backup]);
	try {
		let list = win.getByRole('grid', { name: 'Files and folders' });
		let details = win.getByRole('complementary', { name: 'Details' });
		await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();

		await list.getByRole('row', { name: /hello\.txt/ }).click();
		await expect(details.locator('pre')).toHaveText('hello world\n');
		await expect(details).toContainText('12 bytes');
		await expect(details).toContainText('C:\\hello.txt');

		await list.getByRole('row', { name: /pic\.png/ }).click();
		let img = details.locator('img');
		await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
		await win.screenshot({ path: 'test-results/details.png' });

		// Alt+P hides and shows it
		await win.keyboard.press('Alt+p');
		await expect(details).toBeHidden();
		await win.keyboard.press('Alt+p');
		await expect(details).toBeVisible();
	}
	finally {
		await app.close();
	}
});


test('Verify reports a good backup, and names the damaged file in a bad one', async () => {
	let good = await launch([backup]);
	try {
		await good.win.getByRole('button', { name: 'More' }).click();
		await good.win.getByRole('menuitem', { name: 'Verify backup...' }).click();
		await expect(good.win.getByText('No problems found')).toBeVisible({ timeout: 20000 });
		await good.win.getByRole('button', { name: 'Close' }).click();
	}
	finally {
		await good.app.close();
	}

	let bad = await launch([damaged]);
	try {
		await bad.win.getByRole('button', { name: 'More' }).click();
		await bad.win.getByRole('menuitem', { name: 'Verify backup...' }).click();
		await expect(bad.win.getByText('1 problem found')).toBeVisible({ timeout: 20000 });
		await expect(bad.win.getByRole('dialog')).toContainText('C:\\Docs\\big.bin');
		await bad.win.screenshot({ path: 'test-results/verify-problems.png' });
	}
	finally {
		await bad.app.close();
	}
});


test('Copy original path, and switching to the dark theme', async () => {
	let { app, win } = await launch([backup]);
	try {
		let list = win.getByRole('grid', { name: 'Files and folders' });
		await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();
		await list.getByRole('row', { name: /hello\.txt/ }).click({ button: 'right' });
		await win.getByRole('menuitem', { name: 'Copy original path' }).click();
		await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('C:\\hello.txt');

		await win.getByRole('button', { name: 'More' }).click();
		await win.getByRole('menuitem', { name: 'Theme' }).click();
		await win.getByRole('menuitemradio', { name: 'Dark' }).click();
		await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
		// The window really turns dark (Playwright pins the page's own media query to light, so check colors)
		await expect.poll(() => win.evaluate(() => getComputedStyle(document.querySelector('header')!).backgroundColor)).toBe('rgb(31, 31, 31)');
		await win.keyboard.press('Escape');
		await win.waitForTimeout(500); // buttons fade to their new colors
		await win.screenshot({ path: 'test-results/dark.png' });
	}
	finally {
		await app.close();
	}
});
