import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openArchive, describeArchive, verifySnapshot, NotSupportedError, FormatError, setWarningHandler, DiskFS, detectFormat } from '../src/index';
import { TibxSlice } from '../src/tibx/archive';
import { crc32c } from '../src/tibx/crc32c';
import { lz4DecompressBlockInto, lz4DecompressChain } from '../src/tibx/lz4';
import { lz4CompressBlock } from './helpers/compressors';
import { writeTibx, TibxFixtureOptions } from './helpers/tibx-fixture';
import { buildNtfsImage } from './helpers/ntfs-fixture';
import { sampleImage } from './helpers/sector-fixture';
import { tempDir } from './helpers/windows-fixture';


before(() => setWarningHandler(() => {}));
after(() => setWarningHandler(null));

async function withTibx<T>(points: Array<{ volumes: { [id: number]: Buffer } }>, opts: TibxFixtureOptions, fn: (file: string, dir: string) => Promise<T>): Promise<T> {
	let dir = tempDir('tibx-');
	try {
		return await fn(writeTibx(dir, points, opts), dir);
	}
	finally {
		fs.rmSync(dir, { recursive: true });
	}
}

async function readImage(file: string, inner: string, slice = -1): Promise<Buffer> {
	let a = await openArchive(file);
	try {
		let d = await a.getSlice(slice).openFileSystem();
		let e = await d.stat(inner);
		assert.ok(e, inner + ' exists');
		return await d.read(inner, 0, e!.size);
	}
	finally {
		await a.close();
	}
}


describe('.tibx building blocks', () => {
	test('CRC-32C matches the standard check value', () => {
		assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
		let data = crypto.randomBytes(10001);
		assert.equal(crc32c(data.subarray(5000), crc32c(data.subarray(0, 5000))), crc32c(data));
	});

	test('LZ4 blocks, alone and chained with the previous block as dictionary', () => {
		let text = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(200));
		let block = lz4CompressBlock(text);
		let out = Buffer.alloc(text.length);
		lz4DecompressBlockInto(block, out, 0, text.length);
		assert.ok(out.equals(text));

		let second = Buffer.from('the quick brown fox again, the lazy dog again');
		let b2 = lz4CompressBlock(second, text);
		let chain = Buffer.alloc(16);
		chain.writeUInt32BE(block.length, 0); chain.writeUInt32BE(text.length, 4);
		let h2 = Buffer.alloc(8);
		h2.writeUInt32BE(b2.length, 0); h2.writeUInt32BE(second.length, 4);
		let all = lz4DecompressChain(Buffer.concat([ chain.subarray(0, 8), block, h2, b2 ]), text.length + second.length);
		assert.ok(all.equals(Buffer.concat([ text, second ])));
		assert.throws(() => lz4DecompressChain(Buffer.concat([ chain.subarray(0, 8), block ]), text.length + 1), FormatError);
	});
});


describe('.tibx archives (synthetic)', () => {
	let ntfs = buildNtfsImage([
		{ path: '/Users/Ann/notes.txt', kind: 'file', data: Buffer.from('notes from a tibx') },
		{ path: '/Users/Ann/photo.jpg', kind: 'file', data: crypto.randomBytes(200 * 1024) },
	], { label: 'Windows' });

	test('opens a backup: format, backup point, settings, NTFS files and raw image', async () => {
		await withTibx([ { volumes: { 10: ntfs } } ], { metadataStream: true }, async (file) => {
			assert.equal((await detectFormat(file)).kind, 'tibx');
			let a = await openArchive(file);
			try {
				let info = await describeArchive(a);
				assert.equal(info.format, 'tibx');
				assert.equal(info.slices.length, 1, 'the deleted backup point is not shown');
				assert.equal(info.slices[0].kind, 'disk');
				assert.equal(info.slices[0].created, '2025-01-01T12:00:00.000Z');
				assert.equal(info.slices[0].config.productinfo!.build_number, 40173);
				assert.equal(info.slices[0].config.computer_name, 'TEST-PC');

				let d = await a.getSlice().openFileSystem() as DiskFS;
				assert.deepEqual((await d.list('/'))!.map((e) => e.name).sort(), [ 'Volume (Windows)', 'Volume.img' ], 'small metadata streams are hidden');
				assert.equal((await d.read('/Volume (Windows)/Users/Ann/notes.txt', 0, 100)).toString(), 'notes from a tibx');
				assert.ok((await d.read('/Volume.img', 0, ntfs.length)).equals(ntfs));

				let v = await verifySnapshot(d);
				assert.equal(v.problems.length, 0);
			}
			finally {
				await a.close();
			}
		});
	});

	test('raw (not LZ4) tree pages, several streams, and two extents sharing a segment', async () => {
		let other = sampleImage(1536 * 1024, 21);
		await withTibx([ { volumes: { 6: ntfs, 10: other } } ], { lz4Pages: false, shareFirstSegment: true }, async (file) => {
			assert.ok((await readImage(file, '/Volume 6.img')).equals(ntfs));
			assert.ok((await readImage(file, '/Volume 10.img')).equals(other.subarray(0, (await readImage(file, '/Volume 10.img')).length)));
		});
	});

	test('incremental backup points each show their own state', async () => {
		let v1 = sampleImage(2 * 1024 * 1024, 31);
		let v2 = Buffer.from(v1);
		v2.fill('changed in backup 2', 300000, 400000);
		let v3 = Buffer.from(v2);
		v3.fill('changed in backup 3', 1000000, 1100000);
		await withTibx([ { volumes: { 10: v1 } }, { volumes: { 10: v2 } }, { volumes: { 10: v3 } } ], {}, async (file) => {
			let a = await openArchive(file);
			try {
				assert.equal(a.slices.length, 3);
				assert.equal((a.getSlice(2) as TibxSlice).backupType, 'incremental');
				assert.equal((a.getSlice(1) as TibxSlice).backupType, 'full');
			}
			finally {
				await a.close();
			}
			assert.ok((await readImage(file, '/Volume.img', 1)).equals(v1.subarray(0, (await readImage(file, '/Volume.img', 1)).length)));
			let two = await readImage(file, '/Volume.img', 2);
			assert.ok(two.equals(v2.subarray(0, two.length)));
			let three = await readImage(file, '/Volume.img', 3);
			assert.ok(three.equals(v3.subarray(0, three.length)));
		});
	});

	test('split archives open from any of their files', async () => {
		let big = sampleImage(3 * 1024 * 1024, 41);
		await withTibx([ { volumes: { 10: big } } ], { splitPages: 120 }, async (file, dir) => {
			let parts = fs.readdirSync(dir).filter((f) => /-\d{4}\.tibx$/.test(f));
			assert.ok(parts.length >= 3, 'several data files');
			let whole = await readImage(file, '/Volume.img');
			assert.ok(whole.equals(big.subarray(0, whole.length)));
			assert.ok((await readImage(path.join(dir, parts[1]), '/Volume.img')).equals(whole));

			fs.rmSync(path.join(dir, parts[1]));
			let a = await openArchive(file);
			try {
				let d = await a.getSlice().openFileSystem();
				await assert.rejects(d.read('/Volume.img', 0, big.length), (e: any) => e instanceof FormatError);
			}
			finally {
				await a.close();
			}
		});
	});

	test('damaged pages are caught by their checksum', async () => {
		let img = sampleImage(1536 * 1024, 51);
		await withTibx([ { volumes: { 10: img } } ], { corruptSegment: 6 }, async (file) => {
			let a = await openArchive(file);
			try {
				let d = await a.getSlice().openFileSystem();
				let v = await verifySnapshot(d);
				assert.equal(v.problems.length, 1);
				assert.match(v.problems[0].message, /checksum/);
			}
			finally {
				await a.close();
			}
		});
	});

	test('encrypted archives without key records are refused clearly', async () => {
		await withTibx([ { volumes: { 10: sampleImage(256 * 1024, 61) } } ], { encrypted: true }, async (file) => {
			await assert.rejects(openArchive(file), (e: any) => e instanceof NotSupportedError && e.code === 'encrypted');
			await assert.rejects(openArchive(file, { password: 'x' }), (e: any) => e instanceof NotSupportedError && e.code === 'encrypted');
		});
	});

	for(let [ algorithm, name ] of [ [ 3, 'aes-256-cbc' ], [ 1, 'aes-128-cbc' ], [ 7, 'aes-256-gcm' ], [ 5, 'aes-128-gcm' ] ] as Array<[number, string]>) {
		test('experimental: password-encrypted archive, ' + name, async () => {
			let img = sampleImage(1536 * 1024, 71);
			await withTibx([ { volumes: { 10: img } } ], { password: 'correct horse', encryptionAlgorithm: algorithm }, async (file) => {
				await assert.rejects(openArchive(file), (e: any) => e instanceof NotSupportedError && e.code === 'encrypted');
				await assert.rejects(openArchive(file, { password: 'wrong' }), (e: any) => e instanceof FormatError && e.code === 'wrong-password');

				let a = await openArchive(file, { password: 'correct horse' });
				try {
					assert.equal(a.getSlice().config.encryption, name);
					let d = await a.getSlice().openFileSystem();
					let all = await d.read('/Volume.img', 0, img.length);
					assert.ok(all.equals(img.subarray(0, all.length)));
				}
				finally {
					await a.close();
				}
			});
		});
	}
});
