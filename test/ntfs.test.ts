import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openArchive, extract, NotSupportedError, setWarningHandler, DiskFS, NtfsFS } from '../src/index';
import { BufferImage } from '../src/disk/image';
import { lznt1Decompress } from '../src/ntfs/lznt1';
import { xpressHuffmanDecompress } from '../src/ntfs/xpress';
import { lznt1Compress, xpressHuffmanCompress } from './helpers/compressors';
import { buildNtfsImage, NtfsFixtureEntry } from './helpers/ntfs-fixture';
import { writeSectorBackup } from './helpers/sector-fixture';
import { tempDir } from './helpers/windows-fixture';


function compressibleText(size: number, seed = 1): Buffer {
	let words = [ 'backup', 'cluster', 'volume', 'True Image', 'NTFS', 'record', 'index', '\n' ];
	let parts: string[] = [];
	let x = seed;
	let length = 0;
	while(length < size) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		let w = words[(x >>> 16) % words.length] + ' ';
		parts.push(w);
		length += w.length;
	}
	return Buffer.from(parts.join('')).subarray(0, size);
}

let warnings: string[] = [];
before(() => setWarningHandler((m) => warnings.push(m)));
after(() => setWarningHandler(null));


describe('NTFS decompressors', () => {
	test('LZNT1 round trip, including stored and partial chunks', () => {
		for(let data of [ compressibleText(70000), crypto.randomBytes(9000), Buffer.alloc(5000, 7), Buffer.from('abcabcabcabcabcabcabc') ]) {
			let c = lznt1Compress(data);
			assert.ok(lznt1Decompress(c, data.length).equals(data));
		}
		// Output beyond the data is zero-filled to the unit size
		let small = lznt1Decompress(lznt1Compress(Buffer.from('hello hello hello')), 65536);
		assert.equal(small.length, 65536);
		assert.equal(small.toString('latin1', 0, 17), 'hello hello hello');
		assert.ok(small.subarray(17).every((b) => b === 0));
	});

	test('Xpress Huffman round trip, including long matches', () => {
		for(let data of [ compressibleText(16384), Buffer.concat([ Buffer.alloc(2000, 65), crypto.randomBytes(500), Buffer.alloc(70, 66) ]), Buffer.from('a') ]) {
			let c = xpressHuffmanCompress(data);
			assert.ok(xpressHuffmanDecompress(c, data.length).equals(data));
		}
	});

	test('damaged compressed data fails loudly', () => {
		assert.throws(() => lznt1Decompress(Buffer.from([ 0xff, 0xbf, 1, 2 ]), 4096));
		assert.throws(() => xpressHuffmanDecompress(Buffer.alloc(10), 100));
	});
});


describe('NTFS reader (synthetic volumes)', () => {
	let big = crypto.randomBytes(300 * 1024);
	let text = compressibleText(200 * 1024, 5);
	let sparse = Buffer.concat([ Buffer.alloc(3 * 4096), Buffer.from('after the hole') ]);
	let entries: NtfsFixtureEntry[] = [
		{ path: '/hello.txt', kind: 'file', data: Buffer.from('hello world\n'), mtime: new Date('2022-05-06T07:08:09Z') },
		{ path: '/Docs', kind: 'directory' },
		{ path: '/Docs/Café notes.txt', kind: 'file', data: Buffer.from('accents ok') },
		{ path: '/Docs/big.bin', kind: 'file', data: big },
		{ path: '/Docs/fragmented.bin', kind: 'file', data: big, fragmented: true },
		{ path: '/Docs/sparse.dat', kind: 'file', data: sparse, sparseLeadingClusters: 3 },
		{ path: '/Docs/compressed.txt', kind: 'file', data: Buffer.concat([ text, Buffer.alloc(70000), crypto.randomBytes(5000) ]), compressed: true },
		{ path: '/Docs/many-extents.bin', kind: 'file', data: big, useAttributeList: true },
		{ path: '/Docs/downloaded.zip', kind: 'file', data: Buffer.from('PK...'), streams: { 'Zone.Identifier': Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n') } },
		{ path: '/Docs/linked.txt', kind: 'file', data: Buffer.from('one file, two names'), hardLinkIn: '/Other' },
		{ path: '/Other', kind: 'directory' },
		{ path: '/Windows/System32/compact4k.dll', kind: 'file', data: compressibleText(50000, 2), wofAlgorithm: 0 },
		{ path: '/Windows/System32/compact8k.dll', kind: 'file', data: compressibleText(30000, 3), wofAlgorithm: 2 },
		{ path: '/Windows/System32/compact16k.dll', kind: 'file', data: compressibleText(40000, 4), wofAlgorithm: 3 },
		{ path: '/Windows/System32/lzx.dll', kind: 'file', data: compressibleText(1000, 6), wofAlgorithm: 1 },
		{ path: '/Empty folder', kind: 'directory' },
		{ path: '/empty.txt', kind: 'file', data: Buffer.alloc(0) },
	];
	for(let i = 0; i < 150; i++) {
		entries.push({ path: '/Big folder/f' + String(i).padStart(3, '0') + '.txt', kind: 'file', data: Buffer.from('file ' + i) });
	}
	let image = buildNtfsImage(entries, { label: 'Windows' });

	let open = () => NtfsFS.open(new BufferImage(image));

	test('lists folders, hides NTFS\'s own files, matches names case-insensitively', async () => {
		let fsys = await open();
		assert.equal(await fsys.volume.label(), 'Windows');
		let rootNames = (await fsys.list('/'))!.map((e) => e.name).sort();
		assert.deepEqual(rootNames, [ 'Big folder', 'Docs', 'Empty folder', 'Other', 'Windows', 'empty.txt', 'hello.txt' ]);

		let hello = await fsys.stat('/HELLO.TXT');
		assert.equal(hello!.name, 'hello.txt');
		assert.equal(hello!.path, '/hello.txt');
		assert.equal(hello!.size, 12);
		assert.equal(hello!.mtime.toISOString(), '2022-05-06T07:08:09.000Z');
		assert.equal((await fsys.stat('/docs/CAFÉ NOTES.TXT'))!.name, 'Café notes.txt');
		assert.equal(await fsys.stat('/nope'), undefined);
		assert.equal(await fsys.stat('/hello.txt/x'), undefined);
		assert.deepEqual(await fsys.list('/Empty folder'), []);
	});

	test('reads resident, contiguous, fragmented, sparse, compressed and attribute-list files', async () => {
		let fsys = await open();
		for(let e of entries) {
			if(e.kind !== 'file' || e.wofAlgorithm === 1) {
				continue;
			}
			let st = await fsys.stat(e.path);
			assert.equal(st!.size, e.data!.length, e.path);
			assert.ok((await fsys.read(e.path, 0, st!.size)).equals(e.data!), e.path);
		}
		// Reads at odd offsets inside compressed units and across runs
		let c = entries.find((e) => e.path.endsWith('compressed.txt'))!.data!;
		for(let [ off, len ] of [ [ 65530, 20 ], [ 131072 + 7, 70000 ], [ c.length - 5, 50 ] ]) {
			assert.ok((await fsys.read('/Docs/compressed.txt', off, len)).equals(c.subarray(off, off + len)));
		}
		assert.ok((await fsys.read('/Docs/fragmented.bin', 4090, 9000)).equals(big.subarray(4090, 13090)));
	});

	test('reads Windows Compact OS (WOF) files; LZX is refused clearly', async () => {
		let fsys = await open();
		for(let name of [ 'compact4k.dll', 'compact8k.dll', 'compact16k.dll' ]) {
			let want = entries.find((e) => e.path.endsWith(name))!.data!;
			assert.ok((await fsys.read('/Windows/System32/' + name, 0, want.length)).equals(want), name);
			assert.ok((await fsys.read('/Windows/System32/' + name, 4000, 9000)).equals(want.subarray(4000, 13000)), name + ' middle');
		}
		await assert.rejects(fsys.read('/Windows/System32/lzx.dll', 0, 10), NotSupportedError);
	});

	test('alternate data streams, hard links, big folders and walking', async () => {
		let fsys = await open();
		assert.deepEqual(await fsys.streamsOf('/Docs/downloaded.zip'), [ 'Zone.Identifier' ]);
		assert.match((await fsys.readStream('/Docs/downloaded.zip', 'Zone.Identifier', 0, 100)).toString(), /ZoneId=3/);
		assert.equal((await fsys.read('/Other/link to linked.txt', 0, 100)).toString(), 'one file, two names');

		let bigFolder = (await fsys.list('/Big folder'))!;
		assert.equal(bigFolder.length, 150);
		assert.deepEqual(bigFolder.map((e) => e.name), bigFolder.map((e) => e.name).slice().sort());
		assert.equal((await fsys.read('/Big folder/F149.TXT', 0, 100)).toString(), 'file 149');

		let walked: string[] = [];
		for await (let e of fsys.walk('/')) {
			walked.push(e.path);
		}
		assert.ok(walked.includes('/Windows/System32/compact8k.dll'));
		assert.ok(walked.includes('/Big folder/f000.txt'));
		assert.equal(walked.filter((p) => p.startsWith('/Big folder/')).length, 150);
	});

	test('NTFS inside a disk-image backup: browse, read and extract files', async () => {
		let dir = tempDir();
		try {
			let file = writeSectorBackup(dir, image);
			let a = await openArchive(file);
			try {
				let d = await a.getSlice().openFileSystem() as DiskFS;
				assert.deepEqual((await d.list('/'))!.map((e) => e.name).sort(), [ 'Volume (Windows)', 'Volume.img' ]);
				assert.equal(d.volumes[0].fileSystem, 'NTFS');
				assert.equal((await d.read('/Volume (Windows)/hello.txt', 0, 100)).toString(), 'hello world\n');
				let st = await d.stat('/volume (windows)/docs/BIG.BIN');
				assert.equal(st!.path, '/Volume (Windows)/Docs/big.bin');

				let out = path.join(dir, 'out');
				await extract(d, '/Volume (Windows)/Docs', out);
				assert.ok(fs.readFileSync(path.join(out, 'fragmented.bin')).equals(big));
				assert.ok(fs.readFileSync(path.join(out, 'compressed.txt')).equals(entries.find((e) => e.path.endsWith('compressed.txt'))!.data!));
			}
			finally {
				await a.close();
			}
		}
		finally {
			fs.rmSync(dir, { recursive: true });
		}
	});

	test('a whole disk: NTFS in an MBR partition', async () => {
		let disk = Buffer.alloc(1024 * 1024 + image.length);
		disk[446 + 4] = 0x07;
		disk.writeUInt32LE(2048, 446 + 8);
		disk.writeUInt32LE(image.length / 512, 446 + 12);
		disk[510] = 0x55; disk[511] = 0xaa;
		image.copy(disk, 2048 * 512);

		let d = await DiskFS.Create([ { name: 'Volume', image: new BufferImage(disk) } ], new Date());
		assert.deepEqual((await d.list('/'))!.map((e) => e.name).sort(), [ 'Disk.img', 'Partition 1 (Windows)', 'Partition 1.img' ]);
		assert.equal((await d.read('/Partition 1 (Windows)/Docs/Café notes.txt', 0, 100)).toString(), 'accents ok');
	});
});
