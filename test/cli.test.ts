import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { standardEntries, tempDir, writeWindowsBackup } from './helpers/windows-fixture';


const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tib(...args: string[]) {
	let r = spawnSync(process.execPath, [ CLI, ...args ], { encoding: 'buffer' });
	return { code: r.status, stdout: r.stdout, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8') };
}

describe('tib command line', () => {
	let dir = '';
	let backup = '';
	let corrupt = '';

	before(() => {
		dir = tempDir();
		backup = writeWindowsBackup(dir, standardEntries(), { trimZeros: true });

		let cdir = path.join(dir, 'corrupt');
		fs.mkdirSync(cdir);
		corrupt = writeWindowsBackup(cdir, standardEntries(), { corruptHashOf: 'C:/Docs/big.bin' });
	});

	after(() => {
		fs.rmSync(dir, { recursive: true });
	});

	test('info --json describes the backup', () => {
		let r = tib('info', backup, '--json');
		assert.equal(r.code, 0, r.err);
		let info = JSON.parse(r.out);
		assert.equal(info.name, 'Test');
		assert.equal(info.format, 'Windows');
		assert.equal(info.slices.length, 1);
		assert.equal(info.slices[0].contents.files, 5);
		assert.equal(info.slices[0].config.encryption, 'none');
	});

	test('ls lists folders, recursively and with details', () => {
		assert.equal(tib('ls', backup, '/C').out, 'empty.txt\nhello.txt\nDocs/\n');
		let rec = tib('ls', backup, '/C/Docs', '-R').out;
		assert.match(rec, /\/C\/Docs\/big\.bin/);
		assert.match(tib('ls', backup, '/C', '-l').out, /^-  .*  +12  hello\.txt$/m);
	});

	test('cat writes the exact file bytes', () => {
		let r = tib('cat', backup, '/C/Docs/big.bin');
		assert.equal(r.code, 0, r.err);
		let expected = standardEntries().find((e) => e.path === 'C:/Docs/sparse.dat')!.data!;
		assert.ok(tib('cat', backup, '/C/Docs/sparse.dat').stdout.equals(expected));
		assert.equal(r.stdout.length, 700 * 1024);
	});

	test('extract writes files into the destination', () => {
		let dest = path.join(dir, 'out');
		let r = tib('extract', backup, dest, '/C/Docs', '-q');
		assert.equal(r.code, 0, r.err);
		assert.equal(fs.readFileSync(path.join(dest, 'Café notes.txt'), 'utf8'), 'accents ok');

		// A second run refuses to overwrite
		assert.equal(tib('extract', backup, dest, '/C/Docs', '-q').code, 1);
		assert.equal(tib('extract', backup, dest, '/C/Docs', '-q', '--overwrite').code, 0);
	});

	test('verify passes on a good backup and fails on a corrupted one', () => {
		let ok = tib('verify', backup, '-q');
		assert.equal(ok.code, 0, ok.err);
		assert.match(ok.out, /OK/);

		let bad = tib('verify', corrupt, '-q');
		assert.equal(bad.code, 1);
		assert.match(bad.err, /FAILED \/C\/Docs\/big\.bin/);
	});

	test('verify reports files with no stored data without failing', () => {
		let ndir = path.join(dir, 'nodata');
		fs.mkdirSync(ndir);
		let nodata = writeWindowsBackup(ndir, standardEntries(), { noDataFor: 'C:/Docs/Café notes.txt' });

		let r = tib('verify', nodata, '-q');
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /OK: no problems found \(1 file\(s\) have no data stored/);
		assert.match(r.err, /Café notes\.txt has no data stored in the backup; it reads as zeros/);
	});

	test('reports usage errors with exit code 2', () => {
		assert.equal(tib('frobnicate', backup).code, 2);
		assert.equal(tib('ls').code, 2);
		assert.equal(tib('ls', backup, '--slice', 'x').code, 2);
		assert.equal(tib('--bogus-flag').code, 2);
		assert.equal(tib('mount', backup, '--fuse', 'x', '--drive', 'y').code, 2);
		assert.match(tib('--version').out, /^\d+\.\d+\.\d+/);
	});

	test('reports missing paths and files with exit code 1', () => {
		assert.equal(tib('ls', backup, '/nope').code, 1);
		assert.equal(tib('info', path.join(dir, 'missing.tib')).code, 1);
		assert.equal(tib('ls', backup, '--slice', '5').code, 1);
	});
});
