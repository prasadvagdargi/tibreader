import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DiskFS, FatFS, FormatError, setWarningHandler } from '../src/index';
import { BufferImage } from '../src/disk/image';
import { buildFat32Image, FatFixtureEntry } from './helpers/fat-fixture';
import { buildNtfsImage } from './helpers/ntfs-fixture';


before(() => setWarningHandler(() => {}));
after(() => setWarningHandler(null));

const bootx64 = crypto.randomBytes(5000);
const fragmented = crypto.randomBytes(3 * 512 + 100);
const modified = new Date(2019, 2, 18, 23, 44, 12);

const entries: FatFixtureEntry[] = [
	{ path: '/EFI', kind: 'folder' },
	{ path: '/EFI/Boot', kind: 'folder' },
	{ path: '/EFI/Boot/bootx64.efi', kind: 'file', data: bootx64, mtime: modified },
	{ path: '/EFI/Microsoft', kind: 'folder' },
	{ path: '/EFI/Microsoft/Boot', kind: 'folder' },
	{ path: '/EFI/Microsoft/Boot/BCD', kind: 'file', data: Buffer.from('boot configuration') },
	{ path: '/EFI/Microsoft/Boot/Fragmented boot file.bin', kind: 'file', data: fragmented },
	{ path: '/EFI/Microsoft/Boot/empty.txt', kind: 'file', data: Buffer.alloc(0) },
	{ path: '/Many', kind: 'folder' },
	// Enough long names to need several clusters of folder entries
	...Array.from({ length: 40 }, (_, i) => ({ path: '/Many/A long file name number ' + i + '.txt', kind: 'file' as const, data: Buffer.from('file ' + i) })),
];

async function open(image: Buffer): Promise<FatFS> {
	let fs = await FatFS.open(new BufferImage(image));
	assert.ok(fs, 'recognized as FAT32');
	return fs!;
}


describe('FAT32 volumes', () => {
	let image = buildFat32Image(entries, { label: 'SYSTEM', fragment: '/EFI/Microsoft/Boot/Fragmented boot file.bin', deletedEntry: true });

	test('lists folders with long names, short names in either case, and skips deleted entries', async () => {
		let fs = await open(image);
		assert.deepEqual((await fs.list('/'))!.map((e) => e.name), [ 'EFI', 'Many' ]);
		assert.deepEqual((await fs.list('/EFI/Microsoft/Boot'))!.map((e) => e.name), [ 'BCD', 'Fragmented boot file.bin', 'empty.txt' ]);
		assert.equal((await fs.list('/Many'))!.length, 40);
		assert.equal(await fs.label(), 'SYSTEM');
	});

	test('reads files, including fragmented ones and ranges across clusters', async () => {
		let fs = await open(image);
		assert.ok((await fs.read('/EFI/Boot/bootx64.efi', 0, bootx64.length + 10)).equals(bootx64));
		assert.ok((await fs.read('/EFI/Microsoft/Boot/Fragmented boot file.bin', 0, fragmented.length)).equals(fragmented));
		assert.ok((await fs.read('/EFI/Microsoft/Boot/Fragmented boot file.bin', 500, 600)).equals(fragmented.subarray(500, 1100)));
		assert.equal((await fs.read('/EFI/Microsoft/Boot/empty.txt', 0, 10)).length, 0);
		assert.equal((await fs.read('/Many/A long file name number 39.txt', 0, 100)).toString(), 'file 39');
		await assert.rejects(fs.read('/EFI', 0, 1), /Is a folder/);
		await assert.rejects(fs.read('/nope', 0, 1), /No such file/);
	});

	test('stat: case-insensitive paths, sizes and DOS times', async () => {
		let fs = await open(image);
		let e = await fs.stat('/efi/BOOT/BOOTX64.EFI');
		assert.equal(e!.path, '/EFI/Boot/bootx64.efi');
		assert.equal(e!.size, bootx64.length);
		assert.equal(e!.mtime.getTime(), modified.getTime());
		assert.equal((await fs.stat('/EFI'))!.type, 'directory');
		assert.equal(await fs.stat('/EFI/missing'), undefined);
	});

	test('walk visits every entry', async () => {
		let fs = await open(image);
		let paths: string[] = [];
		for await (let e of fs.walk('/')) {
			paths.push(e.path);
		}
		assert.equal(paths.length, 1 + entries.length);
	});

	test('a disk-image backup shows a FAT32 volume as a folder named after its label', async () => {
		let d = await DiskFS.Create([ { name: 'Volume 6', image: new BufferImage(image) } ], new Date(0));
		assert.deepEqual((await d.list('/'))!.map((e) => e.name).sort(), [ 'Volume 6 (SYSTEM)', 'Volume 6.img' ]);
		assert.equal(d.volumes[0].fileSystem, 'FAT32');
		assert.equal((await d.read('/Volume 6 (SYSTEM)/EFI/Microsoft/Boot/BCD', 0, 100)).toString(), 'boot configuration');
	});

	test('a broken cluster chain fails clearly', async () => {
		let fs = await open(buildFat32Image(entries, { breakChainOf: '/EFI/Boot/bootx64.efi' }));
		await assert.rejects(fs.read('/EFI/Boot/bootx64.efi', 0, bootx64.length), FormatError);
		assert.equal((await fs.read('/EFI/Microsoft/Boot/BCD', 0, 100)).toString(), 'boot configuration');
	});

	test('other volumes are not taken for FAT32', async () => {
		assert.equal(await FatFS.open(new BufferImage(buildNtfsImage([], { label: 'Windows' }))), null);
		assert.equal(await FatFS.open(new BufferImage(Buffer.alloc(4096))), null);
	});
});
