import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectFormat, detectFromBytes, openArchive, NotSupportedError, FormatError } from '../src/index';
import { tempDir } from './helpers/windows-fixture';


function tibHeader(version: number, headerLength: number, sectorSize: number) {
	let h = Buffer.alloc(64);
	h.writeUInt32LE(0xA2B924CE, 0);
	h.writeUInt16LE(headerLength, 4);
	h.writeUInt16LE(version, 6);
	h.writeUInt32LE(1, 0x14);
	h.writeUInt32LE(sectorSize, 0x1c);
	return h;
}

function tibxPage(type: number, inner: string) {
	let p = Buffer.alloc(4096);
	p[0] = 0x41;
	p[1] = type;
	p.write(inner, 8, 'latin1');
	return p;
}


describe('detectFormat', () => {
	test('recognizes each known kind from its first bytes', () => {
		assert.equal(detectFromBytes(tibHeader(0, 0x20, 32)).kind, 'tib');
		assert.equal(detectFromBytes(tibHeader(0, 0x20, 32)).version, 0);
		assert.equal(detectFromBytes(tibHeader(1, 0x24, 4096)).kind, 'tib');
		assert.equal(detectFromBytes(tibHeader(1, 0x24, 4096)).version, 1);
		assert.equal(detectFromBytes(tibHeader(1, 0x20, 0x1000)).kind, 'tib-very-old');

		let v1 = Buffer.alloc(64); v1.writeUInt32LE(0x8F5C36C6, 0);
		assert.equal(detectFromBytes(v1).kind, 'tib-files-v1');
		let v2 = Buffer.alloc(64); v2.writeUInt32LE(0x44686EB4, 0);
		assert.equal(detectFromBytes(v2).kind, 'tib-files-v2');
		let tapeTail = Buffer.alloc(4); tapeTail.writeUInt32LE(0x179631B4, 0);
		assert.equal(detectFromBytes(Buffer.alloc(64, 7), tapeTail).kind, 'tib-tape');

		let arch = detectFromBytes(tibxPage(1, 'ARCH'), undefined, 'Disk.tibx');
		assert.deepEqual([ arch.kind, arch.role ], [ 'tibx', 'archive' ]);
		let slice = detectFromBytes(tibxPage(0xff, 'SG\0\x01'), undefined, 'Disk-0001.tibx');
		assert.deepEqual([ slice.kind, slice.role ], [ 'tibx', 'slice' ]);

		assert.equal(detectFromBytes(Buffer.from('hello world, this is not a backup at all....')).kind, 'unknown');
		assert.equal(detectFromBytes(Buffer.alloc(3)).kind, 'unknown');
	});

	test('reads a file and names unsupported variants when opening', async () => {
		let dir = tempDir();
		try {
			let oldWin = path.join(dir, 'Old_full_b1_s1_v1.tib');
			fs.writeFileSync(oldWin, Buffer.concat([ tibHeader(1, 0x20, 0x1000), Buffer.alloc(8192) ]));
			assert.equal((await detectFormat(oldWin)).kind, 'tib-very-old');
			await assert.rejects(openArchive(oldWin), (e: any) => e instanceof NotSupportedError && /2010-2013/.test(e.message));

			let v2 = path.join(dir, 'v2.tib');
			let b = Buffer.alloc(8192); b.writeUInt32LE(0x44686EB4, 0);
			fs.writeFileSync(v2, b);
			await assert.rejects(openArchive(v2), (e: any) => e instanceof NotSupportedError && /44686EB4/.test(e.message));

			let junk = path.join(dir, 'junk.tib');
			fs.writeFileSync(junk, Buffer.alloc(100, 9));
			await assert.rejects(openArchive(junk), (e: any) => e instanceof FormatError && e.code === 'not-a-backup');

			let tiny = path.join(dir, 'tiny.tib');
			fs.writeFileSync(tiny, Buffer.from([ 1, 2 ]));
			assert.equal((await detectFormat(tiny)).kind, 'unknown');
		}
		finally {
			fs.rmSync(dir, { recursive: true });
		}
	});
});
