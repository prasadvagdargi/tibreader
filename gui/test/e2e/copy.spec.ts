import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fixture, launch, tempDir } from './helpers';


/** Makes the next folder dialogs answer with this folder (Playwright can't click native dialogs) */
async function answerFolderDialogs(app: ElectronApplication, folder: string) {
	await app.evaluate(({ dialog }, f) => {
		dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
	}, folder);
}

/** Records what the app asks Windows to open instead of opening it */
async function captureOpenPath(app: ElectronApplication) {
	await app.evaluate(({ shell }) => {
		(globalThis as any).__opened = [];
		shell.openPath = async (p: string) => { (globalThis as any).__opened.push(p); return ''; };
	});
}

async function opened(app: ElectronApplication): Promise<string[]> {
	return app.evaluate(() => (globalThis as any).__opened as string[]);
}

async function openDocs(win: Page) {
	let list = win.getByRole('grid', { name: 'Files and folders' });
	await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();
	await list.getByRole('row', { name: /Docs/ }).first().dblclick();
	await expect(list.getByRole('row', { name: /big\.bin/ })).toBeVisible();
	return list;
}

let backupDir: string;
let backup: string;
let entries: Array<{ path: string; data?: Buffer; mtime?: Date }>;

test.beforeAll(() => {
	backupDir = fixture.tempDir();
	entries = fixture.standardEntries() as typeof entries;
	backup = fixture.writeWindowsBackup(backupDir, entries);
});

test.afterAll(() => {
	fs.rmSync(backupDir, { recursive: true, force: true });
});

function dataOf(p: string): Buffer {
	return entries.find((e) => e.path === p)!.data!;
}


test('Copy to copies the selection with its dates', async () => {
	let dest = tempDir();
	let { app, win } = await launch([backup]);
	try {
		let list = await openDocs(win);
		await list.getByRole('row', { name: /big\.bin/ }).click();
		await list.getByRole('row', { name: /Café notes\.txt/ }).click({ modifiers: ['Control'] });
		await expect(win.getByText('2 items selected')).toBeVisible();

		await answerFolderDialogs(app, dest);
		await win.getByRole('button', { name: 'Copy to...' }).click();
		await expect(win.getByText('Copied to ' + path.basename(dest)).first()).toBeVisible();

		expect(fs.readFileSync(path.join(dest, 'big.bin')).equals(dataOf('C:/Docs/big.bin'))).toBe(true);
		expect(fs.readFileSync(path.join(dest, 'Café notes.txt'), 'utf8')).toBe('accents ok');
		expect(fs.statSync(path.join(dest, 'big.bin')).mtime.toISOString()).toBe('2023-03-03T00:00:00.000Z');
		await win.screenshot({ path: 'test-results/copied.png' });
	}
	finally {
		await app.close();
		fs.rmSync(dest, { recursive: true, force: true });
	}
});


test('asks before replacing a file, and can keep both', async () => {
	let dest = tempDir();
	fs.writeFileSync(path.join(dest, 'hello.txt'), 'mine');
	let { app, win } = await launch([backup]);
	try {
		let list = win.getByRole('grid', { name: 'Files and folders' });
		await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();
		await list.getByRole('row', { name: /hello\.txt/ }).click();

		await answerFolderDialogs(app, dest);
		await win.getByRole('button', { name: 'Copy to...' }).click();

		let dialog = win.getByRole('alertdialog');
		await expect(dialog).toContainText('This file is already there');
		await win.screenshot({ path: 'test-results/conflict.png' });
		await dialog.getByRole('button', { name: 'Keep both' }).click();

		await expect(win.getByText('Copied to ' + path.basename(dest)).first()).toBeVisible();
		expect(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('mine');
		expect(fs.readFileSync(path.join(dest, 'hello (2).txt'), 'utf8')).toBe('hello world\n');
	}
	finally {
		await app.close();
		fs.rmSync(dest, { recursive: true, force: true });
	}
});


test('Restore copies a whole folder', async () => {
	let dest = tempDir();
	let { app, win } = await launch([backup]);
	try {
		let list = win.getByRole('grid', { name: 'Files and folders' });
		await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();
		await list.getByRole('row', { name: /Docs/ }).first().click();
		await win.getByRole('button', { name: 'Restore...' }).click();

		let dialog = win.getByRole('dialog');
		await expect(dialog).toContainText('3 files');
		await answerFolderDialogs(app, dest);
		await dialog.getByRole('button', { name: 'Browse...' }).click();
		await expect(dialog).toContainText('Files go to ' + path.join(dest, 'Docs'));
		await expect(dialog).toContainText('free there');
		await win.screenshot({ path: 'test-results/restore.png' });
		await dialog.getByRole('button', { name: 'Restore', exact: true }).click();

		await expect(win.getByText('Restored Docs').first()).toBeVisible();
		expect(fs.readdirSync(path.join(dest, 'Docs')).sort()).toEqual(['Café notes.txt', 'Empty folder', 'big.bin', 'sparse.dat']);
		expect(fs.readFileSync(path.join(dest, 'Docs', 'sparse.dat')).equals(dataOf('C:/Docs/sparse.dat'))).toBe(true);
	}
	finally {
		await app.close();
		fs.rmSync(dest, { recursive: true, force: true });
	}
});


test('Open shows a read-only temporary copy; Edit a copy makes a writable one', async () => {
	let dest = tempDir();
	let { app, win } = await launch([backup]);
	try {
		await captureOpenPath(app);
		let list = win.getByRole('grid', { name: 'Files and folders' });
		await list.getByRole('row', { name: /Drive \(C:\)/ }).dblclick();
		await list.getByRole('row', { name: /hello\.txt/ }).dblclick();

		await expect.poll(async () => (await opened(app)).length).toBe(1);
		let temp = (await opened(app))[0];
		expect(path.basename(temp)).toBe('hello.txt');
		expect(fs.readFileSync(temp, 'utf8')).toBe('hello world\n');
		expect(() => fs.accessSync(temp, fs.constants.W_OK)).toThrow();

		await answerFolderDialogs(app, dest);
		await win.getByRole('button', { name: 'Edit a copy' }).click();
		await expect(win.getByText('You\'re editing a copy').first()).toBeVisible();
		await expect.poll(async () => (await opened(app)).length).toBe(2);
		let copy = (await opened(app))[1];
		expect(copy).toBe(path.join(dest, 'hello.txt'));
		fs.accessSync(copy, fs.constants.W_OK);
	}
	finally {
		await app.close();
		fs.rmSync(dest, { recursive: true, force: true });
	}
});


test('dragging rows hands Windows ready copies of them', async () => {
	let { app, win } = await launch([backup]);
	try {
		// Windows runs the drag itself; record what it would get instead
		await app.evaluate(({ BrowserWindow }) => {
			let wc = BrowserWindow.getAllWindows()[0].webContents;
			wc.startDrag = ((item: { files?: string[]; file: string }) => { (globalThis as any).__dragged = item.files || [item.file]; }) as typeof wc.startDrag;
		});

		let list = await openDocs(win);
		await list.getByRole('row', { name: /big\.bin/ }).click();
		await list.getByRole('row', { name: /sparse\.dat/ }).click({ modifiers: ['Control'] });
		await list.getByRole('row', { name: /sparse\.dat/ }).dispatchEvent('dragstart');

		await expect.poll(() => app.evaluate(() => ((globalThis as any).__dragged as string[] | undefined)?.length ?? 0)).toBe(2);
		let files = await app.evaluate(() => (globalThis as any).__dragged as string[]);
		expect(files.map((f) => path.basename(f)).sort()).toEqual(['big.bin', 'sparse.dat']);
		expect(fs.readFileSync(files.find((f) => f.endsWith('big.bin'))!).equals(dataOf('C:/Docs/big.bin'))).toBe(true);
	}
	finally {
		await app.close();
	}
});


test('Ctrl+C puts the files on the clipboard for File Explorer', async () => {
	test.skip(process.platform !== 'win32', 'Windows clipboard');
	let { app, win } = await launch([backup]);
	try {
		let list = await openDocs(win);
		await list.getByRole('row', { name: /Café notes\.txt/ }).click();
		await list.getByRole('row', { name: /sparse\.dat/ }).click({ modifiers: ['Control'] });
		await win.keyboard.press('Control+c');
		await expect(win.getByText('Copied 2 items').first()).toBeVisible();
		await win.screenshot({ path: 'test-results/clipboard.png' });

		let out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
			'[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'], { encoding: 'utf8' });
		let files = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
		expect(files.map((f) => path.basename(f)).sort()).toEqual(['Café notes.txt', 'sparse.dat']);
		expect(fs.readFileSync(files.find((f) => f.endsWith('sparse.dat'))!).equals(dataOf('C:/Docs/sparse.dat'))).toBe(true);
	}
	finally {
		await app.close();
	}
});
