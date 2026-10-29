import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
	openArchive, verifySnapshot, writeFileBackup, localEntries, writeSnapshotBackup, backupPathOfLocal,
	OverlayFS, addLocalToOverlay, exportImage, WebDavServer, setWarningHandler, SnapshotFS
} from '../src/index';
import { encodeName, decodeName } from '../src/write/overlay';
import { readPartitionTable } from '../src/disk/partitions';
import { BufferImage } from '../src/disk/image';
import { standardEntries, tempDir, writeWindowsBackup } from './helpers/windows-fixture';
import { writeSectorBackup } from './helpers/sector-fixture';
import { buildNtfsImage } from './helpers/ntfs-fixture';


const CLI = path.join(__dirname, '..', 'src', 'cli.js');
function tib(...args: string[]) {
	let r = spawnSync(process.execPath, [ CLI, ...args ], { encoding: 'utf8' });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The backup path of a local file, as a path in the backup view ("C:/x/y" -> "/C/x/y") */
function viewPathOf(local: string) {
	let p = backupPathOfLocal(local);
	return '/' + p.replace(/^([A-Za-z]):/, '$1');
}

async function readWhole(fsys: SnapshotFS, p: string) {
	let e = await fsys.stat(p);
	assert.ok(e, p + ' exists');
	return fsys.read(p, 0, e!.size);
}

function hashFile(f: string) {
	return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

let root = '';
before(() => {
	root = tempDir('tib-write-');
	setWarningHandler(() => {});
});
after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	setWarningHandler(null);
});

function makeSourceFolder(name: string) {
	let src = path.join(root, name);
	fs.mkdirSync(path.join(src, 'Sub', 'Deeper'), { recursive: true });
	fs.writeFileSync(path.join(src, 'hello.txt'), 'hello from a new backup\n');
	fs.writeFileSync(path.join(src, 'Café ü.txt'), 'accents');
	fs.writeFileSync(path.join(src, 'empty.txt'), '');
	fs.writeFileSync(path.join(src, 'Sub', 'random.bin'), crypto.randomBytes(700 * 1024));
	let zeros = Buffer.alloc(900 * 1024);
	zeros.write('START', 0);
	zeros.write('MIDDLE', 600 * 1024);
	fs.writeFileSync(path.join(src, 'Sub', 'Deeper', 'mostly-zeros.dat'), zeros);
	let old = new Date('2020-02-03T04:05:06.789Z');
	fs.utimesSync(path.join(src, 'hello.txt'), old, old);
	return src;
}


describe('creating backups', () => {
	test('a folder becomes a backup that reads back exactly', async () => {
		let src = makeSourceFolder('create-src');
		let out = path.join(root, 'out', 'New.tib');
		fs.mkdirSync(path.dirname(out));
		let result = await writeFileBackup(out, localEntries([ src ]));
		assert.equal(path.basename(result.file), 'New_full_b1_s1_v1.tib');
		assert.equal(result.files, 5);

		let a = await openArchive(result.file);
		try {
			let fsys = await a.getSlice().openFileSystem();
			for(let rel of [ 'hello.txt', 'Café ü.txt', 'empty.txt', 'Sub/random.bin', 'Sub/Deeper/mostly-zeros.dat' ]) {
				let local = path.join(src, ...rel.split('/'));
				assert.ok((await readWhole(fsys, viewPathOf(local))).equals(fs.readFileSync(local)), rel);
			}
			let hello = await fsys.stat(viewPathOf(path.join(src, 'hello.txt')));
			assert.equal(hello!.mtime.toISOString(), '2020-02-03T04:05:06.789Z');
			assert.equal((await fsys.stat(viewPathOf(path.join(src, 'Sub'))))!.type, 'directory');

			let v = await verifySnapshot(fsys);
			assert.equal(v.problems.length, 0);
			assert.equal(v.files, 5);
		}
		finally {
			await a.close();
		}

		// No overwriting unless asked; no partial file left after a cancel
		await assert.rejects(writeFileBackup(out, localEntries([ src ])), /exists/);
		let cancelled = new AbortController();
		cancelled.abort();
		await assert.rejects(writeFileBackup(path.join(root, 'out', 'Cancelled.tib'), localEntries([ src ]), { signal: cancelled.signal }));
		assert.deepEqual(fs.readdirSync(path.join(root, 'out')), [ 'New_full_b1_s1_v1.tib' ]);
	});

	test('several sources share their parent folders', async () => {
		let a1 = makeSourceFolder('multi/a');
		let b1 = makeSourceFolder('multi/b');
		let result = await writeFileBackup(path.join(root, 'Multi.tib'), localEntries([ a1, b1 ]), { compressionLevel: 1 });
		assert.equal(result.files, 10);
		let a = await openArchive(result.file);
		try {
			let fsys = await a.getSlice().openFileSystem();
			assert.ok((await readWhole(fsys, viewPathOf(path.join(b1, 'hello.txt')))).toString().startsWith('hello'));
		}
		finally {
			await a.close();
		}
	});
});


describe('overlays (writable views)', () => {
	test('names of any kind are stored safely and come back exactly', () => {
		for(let n of [ 'plain.txt', 'a:b*c?.txt', 'CON', 'nul.txt', 'trailing.', 'space ', 'ü€😀', '%41', '<>|"' ]) {
			let e = encodeName(n);
			assert.ok(/^[A-Za-z0-9 ._()%\-]+$/.test(e), e);
			assert.ok(!/[. ]$/.test(e) && !/^(con|nul)(\.|$)/i.test(e), e);
			assert.equal(decodeName(e), n);
		}
	});

	test('write, copy-up, truncate, mkdir, rename, delete and recreate; the backup never changes', async () => {
		let dir = path.join(root, 'overlay-src');
		fs.mkdirSync(dir);
		let backup = writeWindowsBackup(dir, standardEntries());
		let before = hashFile(backup);

		let a = await openArchive(backup);
		try {
			let lower = await a.getSlice().openFileSystem();
			let o = await OverlayFS.open(lower, path.join(root, 'ov1'));
			assert.equal(o.hasChanges, false);

			// Partial write to a backup file copies it up first
			await o.writeFile('/C/hello.txt', Buffer.from('HELLO'), 0);
			assert.equal((await readWhole(o, '/C/hello.txt')).toString(), 'HELLO world\n');
			await o.truncate('/C/hello.txt', 5);
			assert.equal((await readWhole(o, '/C/hello.txt')).toString(), 'HELLO');

			await o.mkdir('/C/New folder');
			await o.writeFile('/C/New folder/n.txt', Buffer.from('new'));
			assert.deepEqual((await o.list('/C/New folder'))!.map((e) => e.name), [ 'n.txt' ]);

			await o.rename('/C/Docs', '/C/Documents');
			assert.equal(await o.stat('/C/Docs'), undefined);
			assert.equal((await readWhole(o, '/C/Documents/Café notes.txt')).toString(), 'accents ok');

			// A deleted folder that is created again starts empty
			await o.mkdir('/C/Docs');
			assert.deepEqual(await o.list('/C/Docs'), []);

			await o.remove('/C/empty.txt');
			assert.equal(await o.stat('/C/empty.txt'), undefined);
			assert.ok(o.hasChanges);

			// Reopening the overlay keeps the changes
			let again = await OverlayFS.open(lower, path.join(root, 'ov1'));
			assert.equal((await readWhole(again, '/C/hello.txt')).toString(), 'HELLO');
			assert.equal(await again.stat('/C/empty.txt'), undefined);
			assert.equal((await again.list('/C/Docs'))!.length, 0);
		}
		finally {
			await a.close();
		}
		assert.equal(hashFile(backup), before, 'backup unchanged');
	});
});


describe('editing a backup into a new one', () => {
	test('deletions and additions; the original stays untouched', async () => {
		let dir = path.join(root, 'edit-src');
		fs.mkdirSync(dir);
		let backup = writeWindowsBackup(dir, standardEntries());
		let before = hashFile(backup);
		let extra = makeSourceFolder('edit-extra');

		let a = await openArchive(backup);
		let output: string;
		try {
			let o = await OverlayFS.open(await a.getSlice().openFileSystem(), path.join(root, 'edit-ov'));
			await o.remove('/C/Docs/big.bin');
			await addLocalToOverlay(o, path.join(extra, 'hello.txt'), '/C/Docs/added.txt');
			await addLocalToOverlay(o, path.join(extra, 'Sub'), '/C/Added folder');
			output = (await writeSnapshotBackup(o, path.join(root, 'Edited.tib'))).file;
		}
		finally {
			await a.close();
		}
		assert.equal(hashFile(backup), before);

		let b = await openArchive(output);
		try {
			let fsys = await b.getSlice().openFileSystem();
			assert.equal(await fsys.stat('/C/Docs/big.bin'), undefined);
			assert.equal((await readWhole(fsys, '/C/Docs/added.txt')).toString(), 'hello from a new backup\n');
			assert.ok((await readWhole(fsys, '/C/Added folder/random.bin')).equals(fs.readFileSync(path.join(extra, 'Sub', 'random.bin'))));
			assert.equal((await readWhole(fsys, '/C/Docs/Café notes.txt')).toString(), 'accents ok');
			let sparse = standardEntries().find((e) => e.path === 'C:/Docs/sparse.dat')!.data!;
			assert.ok((await readWhole(fsys, '/C/Docs/sparse.dat')).equals(sparse));
		}
		finally {
			await b.close();
		}
	});

	test('converts the files of a disk image into a file backup', async () => {
		let ntfs = buildNtfsImage([
			{ path: '/Users/Ann/notes.txt', kind: 'file', data: Buffer.from('from a disk image') },
			{ path: '/Users/Ann/big.bin', kind: 'file', data: crypto.randomBytes(300 * 1024) },
		], { label: 'Windows' });
		let dir = path.join(root, 'convert');
		fs.mkdirSync(dir);
		let disk = writeSectorBackup(dir, ntfs);

		let a = await openArchive(disk);
		let output: string;
		try {
			output = (await writeSnapshotBackup(await a.getSlice().openFileSystem(), path.join(dir, 'Files.tib'), { from: '/Volume (Windows)', drive: 'D' })).file;
		}
		finally {
			await a.close();
		}
		let b = await openArchive(output);
		try {
			let fsys = await b.getSlice().openFileSystem();
			assert.equal((await readWhole(fsys, '/D/Users/Ann/notes.txt')).toString(), 'from a disk image');
			assert.equal((await fsys.stat('/D/Users/Ann/big.bin'))!.size, 300 * 1024);
		}
		finally {
			await b.close();
		}
	});
});


describe('exporting disk images', () => {
	test('raw image and a VHD Windows can attach (volume wrapped in a partition)', async () => {
		let ntfs = buildNtfsImage([ { path: '/a.txt', kind: 'file', data: Buffer.from('in a vhd') } ], { label: 'Data' });
		let dir = path.join(root, 'export');
		fs.mkdirSync(dir);
		let a = await openArchive(writeSectorBackup(dir, ntfs));
		try {
			let fsys = await a.getSlice().openFileSystem();
			let raw = path.join(dir, 'vol.img');
			await exportImage(fsys, '/Volume.img', raw);
			assert.ok(fs.readFileSync(raw).equals(ntfs));

			let vhd = path.join(dir, 'vol.vhd');
			await exportImage(fsys, '/Volume.img', vhd);
			let v = fs.readFileSync(vhd);
			let footer = v.subarray(v.length - 512);
			assert.equal(footer.toString('latin1', 0, 8), 'conectix');
			assert.equal(footer.readUInt32BE(60), 2);
			let sum = 0;
			for(let i = 0; i < 512; i++) {
				sum += i >= 64 && i < 68 ? 0 : footer[i];
			}
			assert.equal(footer.readUInt32BE(64), (~sum) >>> 0);

			let diskBytes = v.subarray(0, v.length - 512);
			assert.equal(Number(footer.readBigUInt64BE(48)), diskBytes.length);
			let table = await readPartitionTable(new BufferImage(diskBytes));
			assert.equal(table!.partitions[0].start, 1024 * 1024);
			assert.ok(diskBytes.subarray(1024 * 1024, 1024 * 1024 + ntfs.length).equals(ntfs));

			await assert.rejects(exportImage(fsys, '/Volume.img', vhd), /exists/);
		}
		finally {
			await a.close();
		}
	});
});


describe('writable WebDAV', () => {
	let server: WebDavServer;
	let base = '';
	let archiveClose: () => Promise<void>;
	let overlayDir = '';

	before(async () => {
		let dir = path.join(root, 'dav');
		fs.mkdirSync(dir);
		let a = await openArchive(writeWindowsBackup(dir, standardEntries()));
		archiveClose = () => a.close();
		overlayDir = path.join(root, 'dav-overlay');
		let o = await OverlayFS.open(await a.getSlice().openFileSystem(), overlayDir);
		server = new WebDavServer(o);
		let addr = await server.listen(0);
		base = 'http://127.0.0.1:' + addr.port;
	});
	after(async () => {
		await server.close();
		await archiveClose();
	});

	test('PUT, MKCOL, MOVE, COPY, PROPPATCH, DELETE', async () => {
		assert.match((await fetch(base + '/', { method: 'OPTIONS' })).headers.get('allow')!, /PUT/);
		assert.equal((await fetch(base + '/C/new.txt', { method: 'PUT', body: 'created over WebDAV' })).status, 201);
		assert.equal(await (await fetch(base + '/C/new.txt')).text(), 'created over WebDAV');
		assert.equal((await fetch(base + '/C/hello.txt', { method: 'PUT', body: 'replaced' })).status, 204);
		assert.equal(await (await fetch(base + '/C/hello.txt')).text(), 'replaced');
		assert.equal((await fetch(base + '/C/missing/x.txt', { method: 'PUT', body: 'x' })).status, 409);

		assert.equal((await fetch(base + '/C/Made', { method: 'MKCOL' })).status, 201);
		assert.equal((await fetch(base + '/C/Made', { method: 'MKCOL' })).status, 405);
		assert.equal((await fetch(base + '/C/new.txt', { method: 'MOVE', headers: { Destination: base + '/C/Made/moved.txt' } })).status, 201);
		assert.equal((await fetch(base + '/C/new.txt')).status, 404);
		assert.equal((await fetch(base + '/C/Made/moved.txt', { method: 'COPY', headers: { Destination: base + '/C/Made/copy.txt' } })).status, 201);
		assert.equal((await fetch(base + '/C/Made/copy.txt', { method: 'COPY', headers: { Destination: base + '/C/Made/moved.txt', Overwrite: 'F' } })).status, 412);
		assert.equal((await fetch(base + '/C/Made/copy.txt', { method: 'PROPPATCH', body: '<propertyupdate/>' })).status, 207);

		assert.equal((await fetch(base + '/C/Docs', { method: 'DELETE' })).status, 204);
		assert.equal((await fetch(base + '/C/Docs/big.bin')).status, 404);
		assert.equal((await fetch(base + '/C/nothing', { method: 'DELETE' })).status, 404);
		assert.ok(fs.existsSync(path.join(overlayDir, 'overlay.json')));
	});
});


describe('write commands', () => {
	test('tib create, tib edit, tib export', () => {
		let src = makeSourceFolder('cli-src');
		let created = path.join(root, 'cli', 'Cli.tib');
		fs.mkdirSync(path.dirname(created));
		let r = tib('create', created, src, '-q');
		assert.equal(r.code, 0, r.err);
		let file = path.join(root, 'cli', 'Cli_full_b1_s1_v1.tib');
		assert.ok(fs.existsSync(file));

		let helloView = viewPathOf(path.join(src, 'hello.txt'));
		let r2 = tib('edit', file, path.join(root, 'cli', 'Edited.tib'), '--delete', helloView, '--add', path.join(src, 'empty.txt') + '=' + viewPathOf(src) + '/added.txt', '-q');
		assert.equal(r2.code, 0, r2.err);
		let ls = tib('ls', path.join(root, 'cli', 'Edited_full_b1_s1_v1.tib'), viewPathOf(src));
		assert.equal(ls.code, 0, ls.err);
		assert.match(ls.out, /added\.txt/);
		assert.doesNotMatch(ls.out, /hello\.txt/);

		// Refuses to write over the backup it reads
		assert.equal(tib('edit', file, file).code, 1);

		let disk = writeSectorBackup(path.join(root, 'cli'), buildNtfsImage([ { path: '/x.txt', kind: 'file', data: Buffer.from('x') } ]), { name: 'Disk' });
		let r3 = tib('export', disk, '/Volume.img', path.join(root, 'cli', 'out.vhd'), '-q');
		assert.equal(r3.code, 0, r3.err);
		assert.ok(fs.existsSync(path.join(root, 'cli', 'out.vhd')));
	});
});
