import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openArchive, FormatError, NotSupportedError, WindowsFS, setWarningHandler } from '../src/index';
import { standardEntries, tempDir, writeWindowsBackup, FixtureEntry } from './helpers/windows-fixture';


async function readAll(vfs: WindowsFS, p: string, size: number) {
	return vfs.read(p, 0, size + 10);
}

/**
 * Checks every file of the fixture reads back exactly, plus a few range reads
 */
async function checkContents(vfs: WindowsFS, entries: FixtureEntry[]) {
	for(let e of entries) {
		if(e.kind !== 'file') {
			continue;
		}

		let p = '/' + e.path.replace(/^([A-Z]):/, '$1');
		let st = await vfs.stat(p);
		assert.ok(st, 'missing ' + p);
		assert.equal(st.type, 'file');
		assert.equal(st.size, e.data!.length);
		assert.equal(st.mtime.getTime(), e.mtime!.getTime());

		let data = await readAll(vfs, p, e.data!.length);
		assert.ok(data.equals(e.data!), 'content of ' + p);

		await vfs.verifyFile(p);
	}
}

// On Windows, deleting fails if any file handle was left open
function removeDir(dir: string) {
	fs.rmSync(dir, { recursive: true });
}


describe('Windows backups (synthetic)', () => {

	test('opens a backup and reads every file', async () => {
		let dir = tempDir();
		let entries = standardEntries();
		let file = writeWindowsBackup(dir, entries, { trimZeros: true });

		let a = await openArchive(file);
		try {
			assert.equal(a.name, 'Test');
			assert.equal(a.slices.length, 1);

			let s = a.getSlice();
			assert.equal(s.creationTime.toISOString(), '2024-06-22T00:30:07.756Z');
			assert.equal(s.id.length, 16);
			assert.equal(s.config.encryption, 'none');
			assert.equal(s.config.compression, 'normal');
			assert.equal(s.config.productinfo?.version.major, 25);

			let vfs = await s.openFileSystem() as WindowsFS;
			assert.deepEqual((await vfs.list('/'))!.map((e) => e.name), ['C']);
			assert.deepEqual((await vfs.list('/C'))!.map((e) => e.name).sort(), ['Docs', 'empty.txt', 'hello.txt']);
			assert.equal((await vfs.stat('/C/Docs/Empty folder'))!.type, 'directory');
			assert.deepEqual(await vfs.list('/C/Docs/Empty folder'), []);

			// Drive roots have no stored time; the backup time is shown
			assert.equal((await vfs.stat('/C'))!.mtime.toISOString(), '2024-06-22T00:30:07.756Z');

			await checkContents(vfs, entries);

			// Reads that cross block boundaries, start mid-block, and run past the end
			let big = entries.find((e) => e.path.endsWith('big.bin'))!.data!;
			let blk = 256 * 1024;
			assert.ok((await vfs.read('/C/Docs/big.bin', blk - 10, 20)).equals(big.subarray(blk - 10, blk + 10)));
			assert.ok((await vfs.read('/C/Docs/big.bin', 2 * blk + 5, 100)).equals(big.subarray(2 * blk + 5, 2 * blk + 105)));
			assert.equal((await vfs.read('/C/Docs/big.bin', big.length - 3, 100)).length, 3);
			assert.equal((await vfs.read('/C/Docs/big.bin', big.length + 3, 100)).length, 0);

			// Windows paths are case-insensitive
			assert.ok(await vfs.stat('/c/docs/BIG.BIN'));

			let meta = await vfs.entryMeta('/C/hello.txt');
			assert.equal(meta!.attributes, 0x20);
		}
		finally {
			await a.close();
		}

		removeDir(dir);
	});

	test('reads a backup split over several .tib files, opened from any of them', async () => {
		let dir = tempDir();
		let entries = standardEntries();
		let first = writeWindowsBackup(dir, entries, { volumeSplit: 100 * 1024 });

		let files = fs.readdirSync(dir).filter((f) => f.endsWith('.tib')).sort();
		assert.ok(files.length >= 5, 'expected several volumes, got ' + files.length);

		for(let start of [ first, path.join(dir, files[2]) ]) {
			let a = await openArchive(start);
			try {
				assert.equal(a.volumes.length, files.length);
				assert.equal(a.slices.length, 1);
				await checkContents(await a.getSlice().openFileSystem() as WindowsFS, entries);
			}
			finally {
				await a.close();
			}
		}

		removeDir(dir);
	});

	test('fails clearly when a volume of a split backup is missing', async () => {
		let dir = tempDir();
		let first = writeWindowsBackup(dir, standardEntries(), { volumeSplit: 100 * 1024 });
		fs.unlinkSync(path.join(dir, 'Test_full_b1_s1_v2.tib'));

		await assert.rejects(openArchive(first), FormatError);
		removeDir(dir);
	});

	test('detects a corrupted data block', async () => {
		let dir = tempDir();
		let file = writeWindowsBackup(dir, standardEntries(), { corruptHashOf: 'C:/Docs/big.bin' });

		let a = await openArchive(file);
		try {
			let vfs = await a.getSlice().openFileSystem() as WindowsFS;
			await assert.rejects(vfs.read('/C/Docs/big.bin', 0, 10), /Checksum mismatch/);
			await assert.rejects(vfs.verifyFile('/C/Docs/big.bin'), FormatError);

			// Other files are still fine
			assert.equal((await vfs.read('/C/hello.txt', 0, 5)).toString(), 'hello');
		}
		finally {
			await a.close();
		}

		removeDir(dir);
	});

	test('reads a file with no stored data as zeros, with a warning', async () => {
		let dir = tempDir();
		let entries = standardEntries();
		let file = writeWindowsBackup(dir, entries, { noDataFor: 'C:/hello.txt' });

		let warnings: string[] = [];
		setWarningHandler((m) => warnings.push(m));

		let a = await openArchive(file);
		try {
			let vfs = await a.getSlice().openFileSystem() as WindowsFS;
			assert.equal((await vfs.stat('/C/hello.txt'))!.size, 12);
			assert.ok((await vfs.read('/C/hello.txt', 0, 100)).equals(Buffer.alloc(12)));
			assert.equal(await vfs.verifyFile('/C/hello.txt'), 0);
			assert.ok(warnings.some((w) => /hello\.txt has no data stored/.test(w)), warnings.join('\n'));

			// Everything else still reads normally
			let big = entries.find((e) => e.path.endsWith('big.bin'))!.data!;
			assert.ok((await vfs.read('/C/Docs/big.bin', 0, big.length)).equals(big));
		}
		finally {
			setWarningHandler(undefined);
			await a.close();
		}

		removeDir(dir);
	});

	test('refuses encrypted backups without leaking file handles', async () => {
		let dir = tempDir();
		let file = writeWindowsBackup(dir, standardEntries(), { encryption: 'aes256' });
		await assert.rejects(openArchive(file), NotSupportedError);
		removeDir(dir);
	});

	test('fails cleanly on a damaged disk-image trailer without leaking file handles', async () => {
		let dir = tempDir();
		// File-backup data with a disk-image trailer: the disk-image reader can't make sense of it
		let file = writeWindowsBackup(dir, standardEntries(), { sectorBySector: true });
		await assert.rejects(openArchive(file), FormatError);
		removeDir(dir);
	});

	test('rejects files that are not backups', async () => {
		let dir = tempDir();
		let file = path.join(dir, 'Junk_full_b1_s1_v1.tib');
		fs.writeFileSync(file, crypto.randomBytes(4096));
		await assert.rejects(openArchive(file), FormatError);

		fs.writeFileSync(file, Buffer.alloc(10));
		await assert.rejects(openArchive(file), FormatError);
		removeDir(dir);
	});

	test('ignores other backups in the same folder', async () => {
		let dir = tempDir();
		let file = writeWindowsBackup(dir, standardEntries());
		writeWindowsBackup(dir, [ { path: 'D:', kind: 'root' } ], { name: 'Other' });

		let a = await openArchive(file);
		try {
			assert.equal(a.volumes.length, 1);
		}
		finally {
			await a.close();
		}

		removeDir(dir);
	});
});
