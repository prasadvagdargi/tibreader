import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Synthetic backups from the library's own tests (compiled by "npm run pretest" in the repository root)
 */
const fixtureModule = path.resolve(__dirname, '../../../build/test/helpers/windows-fixture.js');
if(!fs.existsSync(fixtureModule)) {
	throw new Error('Run "npm run pretest" in the repository root first, to build the test backups helper');
}
export const fixture: {
	writeWindowsBackup(dir: string, entries: unknown[], opts?: Record<string, unknown>): string;
	standardEntries(): unknown[];
	tempDir(prefix?: string): string;
} = require(fixtureModule);

export function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'tibreader-e2e-'));
}

/** Starts the built app with its own settings folder, opening the given backup files */
export async function launch(files: string[] = []): Promise<{ app: ElectronApplication; win: Page; userData: string }> {
	let userData = tempDir();
	let app = await electron.launch({
		// The app folder (not the script) so Electron reads package.json: name, version, main
		args: [path.resolve(__dirname, '../..'), ...files],
		env: { ...process.env, TIBREADER_USER_DATA: userData },
	});
	let win = await app.firstWindow();
	await win.waitForLoadState('domcontentloaded');
	return { app, win, userData };
}
