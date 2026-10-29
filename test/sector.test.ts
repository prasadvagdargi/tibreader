import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openArchive, describeArchive, verifySnapshot, NotSupportedError, setWarningHandler } from '../src/index';
import { DiskFS } from '../src/disk/fs';
import { decodeChunkMap, encodeChunkMap } from '../src/sector/chunkmap';
import { parseTlv, encodeTlv, encodeUintLE, uintLE } from '../src/sector/tlv';
import { readPartitionTable } from '../src/disk/partitions';
import { BufferImage } from '../src/disk/image';
import { tempDir } from './helpers/windows-fixture';
import { sampleImage, writeSectorBackup, writeSectorChain, SectorFixtureOptions } from './helpers/sector-fixture';


let cacheDir: string;
before(() => {
	cacheDir = tempDir('tib-cache-');
	process.env.TIB_CACHE_DIR = cacheDir;
	setWarningHandler(() => {});
});
after(() => {
	fs.rmSync(cacheDir, { recursive: true, force: true });
	delete process.env.TIB_CACHE_DIR;
	setWarningHandler(null);
});

async function withBackup<T>(image: Buffer, opts: SectorFixtureOptions, fn: (file: string) => Promise<T>): Promise<T> {
	let dir = tempDir();
	try {
		return await fn(writeSectorBackup(dir, image, opts));
	}
	finally {
		fs.rmSync(dir, { recursive: true });
	}
}

async function readAll(file: string, inner: string, slice = -1): Promise<Buffer> {
	let a = await openArchive(file);
	try {
		let s = a.getSlice(slice);
		let fsys = await s.openFileSystem();
		let e = await fsys.stat(inner);
		assert.ok(e, inner + ' exists');
		return await fsys.read(inner, 0, e!.size);
	}
	finally {
		await a.close();
	}
}


describe('sector-by-sector building blocks', () => {
	test('chunk maps round-trip, including backwards deltas', () => {
		let offsets = [ 100, 0, 5000, 4000, 4000, 2 ** 40 ];
		let lengths = [ 50, 100, 7, 0, 3000, 12345 ];
		let m = decodeChunkMap(encodeChunkMap({ offsets, lengths }));
		assert.deepEqual(Array.from(m.offsets), offsets);
		assert.deepEqual(Array.from(m.lengths), lengths);
	});

	test('tag/length records, short and long', () => {
		let long = Buffer.alloc(300, 7);
		let b = encodeTlv([ { tag: 0x8000, value: encodeUintLE(1234567, 6) }, { tag: 6, value: long } ]);
		let r = parseTlv(b);
		assert.equal(r.length, 2);
		assert.equal(r[0].tag, 0x8000);
		assert.equal(uintLE(r[0].value), 1234567);
		assert.ok(r[1].value.equals(long));
	});

	test('reads MBR (with logical partitions) and GPT tables', async () => {
		let disk = Buffer.alloc(8 * 1024 * 1024);
		let entry = (i: number, type: number, lba: number, n: number, at = 0) => {
			let o = at + 446 + i * 16;
			disk[o + 4] = type;
			disk.writeUInt32LE(lba, o + 8);
			disk.writeUInt32LE(n, o + 12);
		};
		entry(0, 0x07, 2048, 4096);
		entry(1, 0x0f, 8192, 6000);
		disk[510] = 0x55; disk[511] = 0xaa;
		// Extended partition at sector 8192 with one logical partition
		entry(0, 0x83, 64, 1000, 8192 * 512);
		disk[8192 * 512 + 510] = 0x55; disk[8192 * 512 + 511] = 0xaa;

		let t = await readPartitionTable(new BufferImage(disk));
		assert.equal(t!.style, 'mbr');
		assert.deepEqual(t!.partitions.map((p) => [ p.number, p.start, p.size ]), [ [ 1, 2048 * 512, 4096 * 512 ], [ 5, (8192 + 64) * 512, 1000 * 512 ] ]);

		let g = Buffer.alloc(4 * 1024 * 1024);
		g[446 + 4] = 0xee; g[510] = 0x55; g[511] = 0xaa;
		g.write('EFI PART', 512, 'latin1');
		g.writeBigUInt64LE(2n, 512 + 72);
		g.writeUInt32LE(128, 512 + 80);
		g.writeUInt32LE(128, 512 + 84);
		let e = 1024;
		Buffer.from('a2a0d0ebe5b9334487c068b6b72699c7', 'hex').copy(g, e);
		g.writeBigUInt64LE(2048n, e + 32);
		g.writeBigUInt64LE(4095n, e + 40);
		g.write('Data', e + 56, 'utf16le');
		let gt = await readPartitionTable(new BufferImage(g));
		assert.equal(gt!.style, 'gpt');
		assert.equal(gt!.partitions[0].description, 'Basic data');
		assert.equal(gt!.partitions[0].name, 'Data');
		assert.equal(gt!.partitions[0].size, 2048 * 512);
	});
});


describe('sector-by-sector .tib (synthetic)', () => {
	let image = sampleImage(3 * 512 * 1024 + 12345, 7);

	test('modern: shows the volume as a raw image that reads back exactly', async () => {
		await withBackup(image, {}, async (file) => {
			let a = await openArchive(file);
			try {
				let s = a.getSlice();
				assert.equal(s.kind, 'disk');
				let info = await describeArchive(a);
				assert.equal(info.slices[0].kind, 'disk');
				assert.equal(info.slices[0].config.productinfo!.build_number, 5554);
				assert.equal(info.slices[0].config.encryption, 'none');

				let d = await s.openFileSystem();
				assert.ok(d instanceof DiskFS);
				let list = (await d.list('/'))!.map((e) => e.name);
				assert.deepEqual(list, [ 'Volume.img' ]);
				let e = await d.stat('/volume.img');
				assert.equal(e!.size, image.length);
				assert.ok((await d.read('/Volume.img', 0, image.length)).equals(image));

				// Reads that start and end inside clusters and blocks
				for(let [ off, len ] of [ [ 1, 10 ], [ 4095, 2 ], [ 524287, 5000 ], [ image.length - 3, 100 ] ]) {
					assert.ok((await d.read('/Volume.img', off, len)).equals(image.subarray(off, off + len)), 'read ' + off);
				}

				let v = await verifySnapshot(d);
				assert.equal(v.problems.length, 0);
				assert.equal(v.bytes, image.length);
			}
			finally {
				await a.close();
			}
		});
	});

	test('modern: out-of-order blocks, compressed and stored blocks, split files', async () => {
		await withBackup(image, { shuffle: true, compression: 'mixed', volumeSplit: 300 * 1024 }, async (file) => {
			assert.ok(fs.readdirSync(path.dirname(file)).length >= 3, 'split over several files');
			assert.ok((await readAll(file, '/Volume.img')).equals(image));
		});
	});

	test('modern: without a stored partition size the image is whole blocks', async () => {
		await withBackup(image, { partitionSize: false }, async (file) => {
			let all = await readAll(file, '/Volume.img');
			assert.equal(all.length, 4 * 512 * 1024);
			assert.ok(all.subarray(0, image.length).equals(image));
			assert.ok(all.subarray(image.length).every((b) => b === 0));
		});
	});

	test('modern: several partition images in one backup point', async () => {
		let second = sampleImage(700 * 1024, 99);
		await withBackup(image, { extraImages: [ second ] }, async (file) => {
			assert.ok((await readAll(file, '/Volume 1.img')).subarray(0, image.length).equals(image));
			assert.ok((await readAll(file, '/Volume 2.img')).subarray(0, second.length).equals(second));
		});
	});

	test('legacy (2014-2016): finds the chunk-map records between blocks, caches the result', async () => {
		let before = fs.readdirSync(cacheDir).length;
		await withBackup(image, { era: 'legacy', compression: 'mixed' }, async (file) => {
			assert.ok((await readAll(file, '/Volume.img')).equals(image));
			assert.equal(fs.readdirSync(cacheDir).length, before + 1, 'index cached');
			// Second open uses the cache
			assert.ok((await readAll(file, '/Volume.img')).equals(image));
			let a = await openArchive(file);
			try {
				assert.equal(a.getSlice().config.productinfo!.version.major, 22);
			}
			finally {
				await a.close();
			}
		});
	});

	test('a whole disk with a partition table shows each partition', async () => {
		let disk = Buffer.alloc(4 * 1024 * 1024);
		disk[446 + 4] = 0x07;
		disk.writeUInt32LE(2048, 446 + 8);
		disk.writeUInt32LE(4096, 446 + 12);
		disk[510] = 0x55; disk[511] = 0xaa;
		let part = sampleImage(4096 * 512, 3);
		part.copy(disk, 2048 * 512);

		await withBackup(disk, {}, async (file) => {
			let a = await openArchive(file);
			try {
				let d = await a.getSlice().openFileSystem() as DiskFS;
				assert.deepEqual((await d.list('/'))!.map((e) => e.name).sort(), [ 'Disk.img', 'Partition 1.img' ]);
				assert.ok((await d.read('/Partition 1.img', 0, part.length)).equals(part));
				assert.equal(d.volumes[0].partition!.description, 'NTFS/exFAT');
			}
			finally {
				await a.close();
			}
		});
	});

	test('incremental backup points read through to the full backup', async () => {
		let v1 = sampleImage(2 * 512 * 1024, 11);
		let v2 = Buffer.from(v1);
		v2.fill('changed!', 600 * 1024, 610 * 1024);
		let dir = tempDir();
		try {
			let files = writeSectorChain(dir, [ v1, v2 ]);
			assert.ok((await readAll(files[0], '/Volume.img', 1)).equals(v1));
			assert.ok((await readAll(files[0], '/Volume.img', 2)).equals(v2));
		}
		finally {
			fs.rmSync(dir, { recursive: true });
		}
	});

	test('damaged blocks are reported by verify and fail reads', async () => {
		await withBackup(image, { corruptBlock: 1, compression: 'deflate' }, async (file) => {
			let a = await openArchive(file);
			try {
				let d = await a.getSlice().openFileSystem();
				await assert.rejects(d.read('/Volume.img', 512 * 1024, 10), /damaged|bytes/);
				let v = await verifySnapshot(d);
				assert.equal(v.problems.length, 1);
				// Other blocks still read
				assert.ok((await d.read('/Volume.img', 0, 1000)).equals(image.subarray(0, 1000)));
			}
			finally {
				await a.close();
			}
		});
	});

	test('encrypted disk images are refused clearly', async () => {
		await withBackup(image, { encryption: 'aes256' }, async (file) => {
			await assert.rejects(openArchive(file), (e: any) => e instanceof NotSupportedError && e.code === 'encrypted');
		});
	});

	test('the chunk-map stream compresses and decodes at real-world scale quickly', () => {
		let n = 200000;
		let offsets = new Float64Array(n);
		let lengths = new Uint32Array(n);
		let pos = 0;
		for(let i = 0; i < n; i++) {
			lengths[i] = i % 3 === 0 ? 0 : 500000 + (i % 7);
			offsets[i] = lengths[i] ? pos : pos;
			pos += lengths[i];
		}
		let z = zlib.deflateSync(encodeChunkMap({ offsets, lengths }));
		let t = Date.now();
		let m = decodeChunkMap(zlib.inflateSync(z));
		assert.ok(Date.now() - t < 2000);
		assert.equal(m.offsets[n - 1], offsets[n - 1]);
	});
});
