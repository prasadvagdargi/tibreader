import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
	openArchive, describeArchive, verifySnapshot, verifyHeaders, measure, setWarningHandler,
	FormatError, NotSupportedError, findWinFsp, freeDriveLetters
} from '../src/index';
import { standardEntries, tempDir, writeWindowsBackup } from './helpers/windows-fixture';


describe('describeArchive', () => {
	test('summarizes files, backup points and contents', async () => {
		let dir = tempDir();
		let file = writeWindowsBackup(dir, standardEntries());
		let a = await openArchive(file);
		try {
			let info = await describeArchive(a);
			assert.equal(info.name, 'Test');
			assert.equal(info.format, 'Windows');
			assert.equal(info.volumes.length, 1);
			assert.equal(info.volumes[0].file, file);
			assert.equal(info.volumes[0].size, fs.statSync(file).size);
			assert.ok(info.volumes[0].headerChecksumOk);
			assert.equal(info.slices.length, 1);
			assert.equal(info.slices[0].number, 1);
			assert.equal(info.slices[0].incremental, false);
			assert.equal(info.slices[0].created, '2024-06-22T00:30:07.756Z');
			assert.match(info.slices[0].id, /^[0-9a-f]{32}$/);
			assert.deepEqual(info.slices[0].contents, { files: 5, folders: 3, bytes: 12 + 10 + 700 * 1024 + 300 * 1024 });

			let quick = await describeArchive(a, { contents: false });
			assert.equal(quick.slices[0].contents, undefined);

			// Plain data, so it can be sent between processes
			assert.deepEqual(JSON.parse(JSON.stringify(info)), info);
		}
		finally {
			await a.close();
			fs.rmSync(dir, { recursive: true });
		}
	});
});


describe('verifySnapshot', () => {
	test('passes on a good backup, reporting progress', async () => {
		let dir = tempDir();
		let a = await openArchive(writeWindowsBackup(dir, standardEntries()));
		try {
			let snapshot = await a.getSlice().openFileSystem();
			let progress: number[] = [];
			let res = await verifySnapshot(snapshot, { onProgress: (p) => progress.push(p.files) });

			assert.equal(res.files, 5);
			assert.deepEqual(res.problems, []);
			assert.equal(res.unstored, 0);
			assert.deepEqual(progress, [1, 2, 3, 4, 5]);
			assert.deepEqual(verifyHeaders(a), []);
		}
		finally {
			await a.close();
			fs.rmSync(dir, { recursive: true });
		}
	});

	test('reports the damaged file and keeps checking the rest', async () => {
		let dir = tempDir();
		let a = await openArchive(writeWindowsBackup(dir, standardEntries(), { corruptHashOf: 'C:/Docs/big.bin' }));
		try {
			let snapshot = await a.getSlice().openFileSystem();
			let seen: string[] = [];
			let res = await verifySnapshot(snapshot, { onProblem: (p) => seen.push(p.path) });

			assert.equal(res.files, 5);
			assert.deepEqual(res.problems.map((p) => p.path), ['/C/Docs/big.bin']);
			assert.deepEqual(seen, ['/C/Docs/big.bin']);
		}
		finally {
			await a.close();
			fs.rmSync(dir, { recursive: true });
		}
	});

	test('can be cancelled', async () => {
		let dir = tempDir();
		let a = await openArchive(writeWindowsBackup(dir, standardEntries()));
		try {
			let snapshot = await a.getSlice().openFileSystem();
			let ctl = new AbortController();
			await assert.rejects(verifySnapshot(snapshot, { signal: ctl.signal, onProgress: () => ctl.abort() }), { name: 'AbortError' });
			assert.equal((await measure(snapshot)).files, 5);
		}
		finally {
			await a.close();
			fs.rmSync(dir, { recursive: true });
		}
	});

	test('counts files stored without data', async () => {
		let dir = tempDir();
		setWarningHandler(null);
		let a = await openArchive(writeWindowsBackup(dir, standardEntries(), { noDataFor: 'C:/hello.txt' }));
		try {
			let res = await verifySnapshot(await a.getSlice().openFileSystem());
			assert.equal(res.unstored, 1);
			assert.deepEqual(res.problems, []);
		}
		finally {
			setWarningHandler(undefined);
			await a.close();
			fs.rmSync(dir, { recursive: true });
		}
	});
});


describe('error codes', () => {
	async function codeOf(file: string) {
		try {
			let a = await openArchive(file);
			await a.close();
		}
		catch(e: any) {
			return { cls: e.constructor, code: e.code };
		}
		assert.fail('expected ' + file + ' to fail');
	}

	test('say what kind of problem stopped a backup from opening', async () => {
		let dir = tempDir();
		let sub = (name: string) => {
			let d = path.join(dir, name);
			fs.mkdirSync(d);
			return d;
		};

		try {
			let enc = writeWindowsBackup(sub('enc'), standardEntries(), { encryption: 'aes256' });
			assert.deepEqual(await codeOf(enc), { cls: NotSupportedError, code: 'encrypted' });

			let sbs = writeWindowsBackup(sub('sbs'), standardEntries(), { sectorBySector: true });
			assert.deepEqual(await codeOf(sbs), { cls: FormatError, code: 'damaged' });

			let notTib = path.join(dir, 'notes_full_b1_s1_v1.tib');
			fs.writeFileSync(notTib, Buffer.alloc(4096, 1));
			assert.deepEqual(await codeOf(notTib), { cls: FormatError, code: 'not-a-backup' });

			let good = writeWindowsBackup(sub('renamed'), standardEntries());
			let renamed = path.join(path.dirname(good), 'my backup.tib');
			fs.renameSync(good, renamed);
			assert.deepEqual(await codeOf(renamed), { cls: FormatError, code: 'unexpected-name' });

			let split = writeWindowsBackup(sub('split'), standardEntries(), { volumeSplit: 200 * 1024 });
			let parts = fs.readdirSync(path.dirname(split)).filter((f) => f.endsWith('.tib')).sort();
			assert.ok(parts.length >= 3, 'expected a split backup');
			fs.rmSync(path.join(path.dirname(split), parts[1]));
			assert.deepEqual(await codeOf(path.join(path.dirname(split), parts[0])), { cls: FormatError, code: 'missing-part' });
		}
		finally {
			fs.rmSync(dir, { recursive: true });
		}
	});
});


describe('Windows drive helpers', { skip: process.platform !== 'win32' }, () => {
	test('freeDriveLetters lists letters nothing uses', async () => {
		let free = await freeDriveLetters();
		assert.ok(free.length > 0);
		assert.ok(!free.includes('C:'));
		for(let l of free) {
			assert.match(l, /^[D-Z]:$/);
			assert.ok(!fs.existsSync(l + '\\'), l + ' is in use');
		}
	});

	test('findWinFsp returns a folder with the WinFsp DLL, or null', async () => {
		let d = await findWinFsp();
		if(d !== null) {
			assert.ok(fs.existsSync(path.join(d, 'bin', 'winfsp-x64.dll')));
		}
	});
});
