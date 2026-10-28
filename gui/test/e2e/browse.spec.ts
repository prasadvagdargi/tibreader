import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { fixture, launch } from './helpers';


test('shows the start screen', async () => {
	let { app, win } = await launch();
	try {
		await expect(win.getByText('Open an Acronis backup')).toBeVisible();
		await expect(win.getByRole('button', { name: 'Open backup...' })).toBeVisible();
		await expect(win.getByText('Backups you open show up here.')).toBeVisible();
		await expect(win.getByText(/TibReader 0\.\d+\.\d+/)).toBeVisible();
		await win.screenshot({ path: 'test-results/welcome.png' });
	}
	finally {
		await app.close();
	}
});


test('opens a backup and browses its folders', async () => {
	let dir = fixture.tempDir();
	let file = fixture.writeWindowsBackup(dir, fixture.standardEntries());
	let { app, win } = await launch([file]);
	try {
		let list = win.getByRole('grid', { name: 'Files and folders' });

		// The top level shows the backed-up drive
		let drive = list.getByRole('row', { name: /Drive \(C:\)/ });
		await expect(drive).toBeVisible();
		await expect(win.getByText('Windows backup')).toBeVisible();

		// Into the drive, then into Docs
		await drive.dblclick();
		await expect(list.getByRole('row', { name: /hello\.txt/ })).toBeVisible();
		await expect(list.getByRole('row', { name: /hello\.txt/ })).toContainText('12 bytes');
		await list.getByRole('row', { name: /Docs/ }).first().dblclick();
		await expect(list.getByRole('row', { name: /big\.bin/ })).toContainText('700 KB');
		await expect(list.getByRole('row', { name: /Café notes\.txt/ })).toBeVisible();
		await expect(win.getByRole('navigation', { name: 'Location' })).toContainText('Docs');

		// Selecting shows the total in the status bar
		await list.getByRole('row', { name: /big\.bin/ }).click();
		await expect(win.getByText(/1 item selected/)).toBeVisible();
		await win.screenshot({ path: 'test-results/browse.png' });

		// Up goes back to the drive and selects the folder we came from
		await win.keyboard.press('Alt+ArrowUp');
		await expect(list.getByRole('row', { name: /hello\.txt/ })).toBeVisible();
		await expect(list.getByRole('row', { name: /Docs/ }).first()).toHaveAttribute('aria-selected', 'true');

		// Backup info
		await win.getByRole('button', { name: 'Backup info' }).click();
		await expect(win.getByText('5 files, 3 folders')).toBeVisible();
		await win.waitForTimeout(600); // let the panel finish sliding in
		await win.screenshot({ path: 'test-results/info.png' });
	}
	finally {
		await app.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});


test('explains why an encrypted backup cannot be opened', async () => {
	let dir = fixture.tempDir();
	let file = fixture.writeWindowsBackup(dir, fixture.standardEntries(), { encryption: 'aes256' });
	let { app, win } = await launch([file]);
	try {
		await expect(win.getByText('This backup is password-protected')).toBeVisible();
		await expect(win.getByRole('button', { name: 'Open another backup...' })).toBeVisible();
		await win.screenshot({ path: 'test-results/encrypted.png' });
	}
	finally {
		await app.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
