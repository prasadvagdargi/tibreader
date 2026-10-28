import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { extract, extractItems, measure, safeFileName } from '../src/fs/extract';
import { WebDavServer, hostAllowed } from '../src/mount/webdav';
import { MemoryFS } from './helpers/memory-fs';
import { tempDir } from './helpers/windows-fixture';


function sampleFS() {
	return new MemoryFS([
		{ path: '/top.txt', data: Buffer.from('top'), mtime: new Date('2021-01-01T00:00:00Z') },
		{ path: '/Docs', mtime: new Date('2022-02-02T00:00:00Z') },
		{ path: '/Docs/Café notes.txt', data: Buffer.from('accents'), mtime: new Date('2023-03-03T00:00:00Z') },
		{ path: '/Docs/a?b.txt', data: Buffer.from('odd name') },
		{ path: '/Docs/big.bin', data: Buffer.alloc(3 * 1024 * 1024 + 7, 0x41) },
		{ path: '/Docs/Sub/deep.txt', data: Buffer.from('deep') },
	]);
}


describe('extract', () => {
	test('copies a folder with contents and modified times', async () => {
		let dest = tempDir();
		let res = await extract(sampleFS(), '/Docs', dest, { chunkSize: 1024 * 1024 });

		assert.deepEqual(res, { files: 4, directories: 1, bytes: 7 + 8 + 3 * 1024 * 1024 + 7 + 4, skipped: 0 });
		assert.equal(fs.readFileSync(path.join(dest, 'Café notes.txt'), 'utf8'), 'accents');
		assert.equal(fs.readFileSync(path.join(dest, safeFileName('a?b.txt')), 'utf8'), 'odd name');
		assert.equal(fs.readFileSync(path.join(dest, 'Sub', 'deep.txt'), 'utf8'), 'deep');
		assert.equal(fs.statSync(path.join(dest, 'big.bin')).size, 3 * 1024 * 1024 + 7);
		assert.equal(fs.statSync(path.join(dest, 'Café notes.txt')).mtime.toISOString(), '2023-03-03T00:00:00.000Z');

		fs.rmSync(dest, { recursive: true });
	});

	test('extracts a single file into the destination', async () => {
		let dest = tempDir();
		await extract(sampleFS(), '/top.txt', dest);
		assert.deepEqual(fs.readdirSync(dest), ['top.txt']);
		fs.rmSync(dest, { recursive: true });
	});

	test('does not overwrite unless asked', async () => {
		let dest = tempDir();
		fs.writeFileSync(path.join(dest, 'top.txt'), 'mine');

		await assert.rejects(extract(sampleFS(), '/top.txt', dest), /already exists/);
		assert.equal(fs.readFileSync(path.join(dest, 'top.txt'), 'utf8'), 'mine');

		await extract(sampleFS(), '/top.txt', dest, { overwrite: true });
		assert.equal(fs.readFileSync(path.join(dest, 'top.txt'), 'utf8'), 'top');
		fs.rmSync(dest, { recursive: true });
	});

	test('fails for paths that are not in the backup', async () => {
		await assert.rejects(extract(sampleFS(), '/nope', tempDir()), /No such file/);
	});

	test('skips or keeps both copies of files that already exist', async () => {
		let dest = tempDir();
		fs.writeFileSync(path.join(dest, 'top.txt'), 'mine');

		let skipped = await extract(sampleFS(), '/top.txt', dest, { conflict: 'skip' });
		assert.equal(skipped.skipped, 1);
		assert.equal(skipped.files, 0);
		assert.equal(fs.readFileSync(path.join(dest, 'top.txt'), 'utf8'), 'mine');

		await extract(sampleFS(), '/top.txt', dest, { conflict: 'rename' });
		await extract(sampleFS(), '/top.txt', dest, { conflict: 'rename' });
		assert.deepEqual(fs.readdirSync(dest).sort(), ['top (2).txt', 'top (3).txt', 'top.txt']);
		assert.equal(fs.readFileSync(path.join(dest, 'top (2).txt'), 'utf8'), 'top');
		assert.equal(fs.readFileSync(path.join(dest, 'top.txt'), 'utf8'), 'mine');
		fs.rmSync(dest, { recursive: true });
	});

	test('asks a function about each conflict, and can stop', async () => {
		let dest = tempDir();
		fs.writeFileSync(path.join(dest, 'top.txt'), 'mine');

		let asked: string[] = [];
		await extract(sampleFS(), '/top.txt', dest, { conflict: async (e, d) => { asked.push(e.path + ' ' + path.basename(d)); return 'overwrite' as const; } });
		assert.deepEqual(asked, ['/top.txt top.txt']);
		assert.equal(fs.readFileSync(path.join(dest, 'top.txt'), 'utf8'), 'top');

		await assert.rejects(extract(sampleFS(), '/top.txt', dest, { conflict: () => 'abort' as const }), { name: 'AbortError' });
		assert.deepEqual(fs.readdirSync(dest), ['top.txt']);
		fs.rmSync(dest, { recursive: true });
	});

	test('reports progress and stops when cancelled, removing the unfinished file', async () => {
		let dest = tempDir();
		let ctl = new AbortController();
		let seen: number[] = [];

		await assert.rejects(extract(sampleFS(), '/Docs/big.bin', dest, {
			chunkSize: 1024 * 1024,
			signal: ctl.signal,
			onProgress: (p) => {
				seen.push(p.bytes);
				if(p.bytes >= 2 * 1024 * 1024) {
					ctl.abort();
				}
			}
		}), { name: 'AbortError' });

		assert.deepEqual(seen, [1024 * 1024, 2 * 1024 * 1024]);
		assert.deepEqual(fs.readdirSync(dest), []);
		fs.rmSync(dest, { recursive: true });
	});

	test('a cancelled overwrite keeps the original file', async () => {
		let dest = tempDir();
		fs.writeFileSync(path.join(dest, 'big.bin'), 'original');
		let ctl = new AbortController();

		await assert.rejects(extract(sampleFS(), '/Docs/big.bin', dest, {
			chunkSize: 1024 * 1024, overwrite: true, signal: ctl.signal, onProgress: () => ctl.abort()
		}), { name: 'AbortError' });

		assert.deepEqual(fs.readdirSync(dest), ['big.bin']);
		assert.equal(fs.readFileSync(path.join(dest, 'big.bin'), 'utf8'), 'original');
		fs.rmSync(dest, { recursive: true });
	});

	test('reports names that had to change for this OS', async () => {
		let dest = tempDir();
		let renamed: string[] = [];
		let mfs = new MemoryFS([ { path: '/bad\u0001name.txt', data: Buffer.from('x') } ]);
		await extract(mfs, '/', dest, { onRenamed: (e, safe) => renamed.push(e.name + ' -> ' + safe) });
		assert.deepEqual(renamed, ['bad\u0001name.txt -> bad_name.txt']);
		assert.deepEqual(fs.readdirSync(dest), ['bad_name.txt']);
		fs.rmSync(dest, { recursive: true });
	});
});


describe('extractItems and measure', () => {
	test('copies a selection the way a file manager does', async () => {
		let dest = tempDir();
		let res = await extractItems(sampleFS(), ['/top.txt', '/Docs'], dest);

		assert.equal(res.files, 5);
		assert.deepEqual(fs.readdirSync(dest).sort(), ['Docs', 'top.txt']);
		assert.equal(fs.readFileSync(path.join(dest, 'Docs', 'Sub', 'deep.txt'), 'utf8'), 'deep');
		assert.equal(fs.statSync(path.join(dest, 'Docs')).mtime.toISOString(), '2022-02-02T00:00:00.000Z');
		fs.rmSync(dest, { recursive: true });
	});

	test('the root copies everything into the destination', async () => {
		let dest = tempDir();
		await extractItems(sampleFS(), ['/'], dest);
		assert.deepEqual(fs.readdirSync(dest).sort(), ['Docs', 'top.txt']);
		fs.rmSync(dest, { recursive: true });
	});

	test('measure counts what would be written', async () => {
		assert.deepEqual(await measure(sampleFS()), { files: 5, directories: 2, bytes: 3 + 7 + 8 + 3 * 1024 * 1024 + 7 + 4 });
		assert.deepEqual(await measure(sampleFS(), ['/top.txt', '/Docs/Sub']), { files: 2, directories: 1, bytes: 3 + 4 });
		await assert.rejects(measure(sampleFS(), ['/nope']), /No such file/);
	});
});


describe('WebDAV server', () => {
	let server: WebDavServer;
	let base = '';

	before(async () => {
		server = new WebDavServer(sampleFS());
		let addr = await server.listen(0);
		base = 'http://127.0.0.1:' + addr.port;
	});

	after(async () => {
		await server.close();
	});

	test('OPTIONS advertises WebDAV', async () => {
		let r = await fetch(base + '/', { method: 'OPTIONS' });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get('dav'), '1, 2');
	});

	test('PROPFIND lists a folder with encoded names', async () => {
		let r = await fetch(base + '/Docs/', { method: 'PROPFIND', headers: { Depth: '1' } });
		assert.equal(r.status, 207);
		let xml = await r.text();
		assert.match(xml, /<D:href>\/Docs\/<\/D:href>/);
		assert.match(xml, /<D:href>\/Docs\/Caf%C3%A9%20notes\.txt<\/D:href>/);
		assert.match(xml, /<D:href>\/Docs\/Sub\/<\/D:href>/);
		assert.match(xml, /<D:getcontentlength>7<\/D:getcontentlength>/);

		let r0 = await fetch(base + '/Docs/', { method: 'PROPFIND', headers: { Depth: '0' } });
		assert.equal((await r0.text()).match(/<D:response>/g)!.length, 1);
	});

	test('GET returns whole files and ranges', async () => {
		let r = await fetch(base + '/Docs/Caf%C3%A9%20notes.txt');
		assert.equal(r.status, 200);
		assert.equal(await r.text(), 'accents');

		let rr = await fetch(base + '/Docs/big.bin', { headers: { Range: 'bytes=10-19' } });
		assert.equal(rr.status, 206);
		assert.equal(rr.headers.get('content-range'), 'bytes 10-19/' + (3 * 1024 * 1024 + 7));
		assert.equal(await rr.text(), 'AAAAAAAAAA');

		let big = await fetch(base + '/Docs/big.bin');
		assert.equal((await big.arrayBuffer()).byteLength, 3 * 1024 * 1024 + 7);

		let bad = await fetch(base + '/top.txt', { headers: { Range: 'bytes=50-' } });
		assert.equal(bad.status, 416);
	});

	test('HEAD returns the size without a body', async () => {
		let r = await fetch(base + '/top.txt', { method: 'HEAD' });
		assert.equal(r.headers.get('content-length'), '3');
	});

	test('is read-only and rejects bad paths', async () => {
		assert.equal((await fetch(base + '/top.txt', { method: 'PUT', body: 'x' })).status, 403);
		assert.equal((await fetch(base + '/top.txt', { method: 'DELETE' })).status, 403);
		assert.equal((await fetch(base + '/missing')).status, 404);
		assert.equal((await fetch(base + '/Docs/..%2F..%2Fsecret')).status, 400);
	});

	test('hands out locks so Windows can open files', async () => {
		let r = await fetch(base + '/top.txt', { method: 'LOCK', body: '<lockinfo/>' });
		assert.equal(r.status, 200);
		assert.match(r.headers.get('lock-token')!, /^<opaquelocktoken:/);
		assert.equal((await fetch(base + '/top.txt', { method: 'UNLOCK' })).status, 204);
	});

	test('folders open as a simple web page', async () => {
		let r = await fetch(base + '/Docs/');
		assert.match(r.headers.get('content-type')!, /text\/html/);
		assert.match(await r.text(), /Caf%C3%A9%20notes\.txt/);
	});

	test('refuses requests for other host names (DNS rebinding)', async () => {
		let port = parseInt(new URL(base).port, 10);
		assert.equal((await rawGet(port, '/top.txt', 'evil.example:' + port)).status, 403);
		assert.equal((await rawGet(port, '/top.txt', '127.0.0.1:' + port)).status, 200);
		assert.equal((await rawGet(port, '/top.txt', 'localhost:' + port)).status, 200);
		assert.equal((await rawGet(port, '/top.txt', '127.0.0.1:1')).status, 403);
	});
});


describe('WebDAV server with a secret base path', () => {
	let server: WebDavServer;
	let base = '';
	let secret = WebDavServer.randomBasePath();

	before(async () => {
		server = new WebDavServer(sampleFS(), { basePath: secret });
		let addr = await server.listen(0);
		base = 'http://127.0.0.1:' + addr.port;
	});

	after(async () => {
		await server.close();
	});

	test('serves only below the base path', async () => {
		assert.match(secret, /^\/[0-9a-f]{32}\/$/);
		assert.equal(server.basePath, secret);
		assert.equal(await (await fetch(base + secret + 'top.txt')).text(), 'top');
		assert.equal((await fetch(base + '/top.txt')).status, 404);
		assert.equal((await fetch(base + '/')).status, 404);
	});

	test('listings link below the base path', async () => {
		let xml = await (await fetch(base + secret + 'Docs/', { method: 'PROPFIND', headers: { Depth: '1' } })).text();
		assert.ok(xml.includes('<D:href>' + secret + 'Docs/Sub/</D:href>'));
		assert.match(await (await fetch(base + secret)).text(), new RegExp(secret + 'Docs/'));
	});

	test('rejects base paths that are not folders', () => {
		assert.throws(() => new WebDavServer(sampleFS(), { basePath: 'nope' }));
		assert.throws(() => new WebDavServer(sampleFS(), { basePath: '/../' }));
	});
});


describe('hostAllowed', () => {
	test('accepts this computer with the right port only', () => {
		assert.ok(hostAllowed('127.0.0.1:8642', 8642));
		assert.ok(hostAllowed('LOCALHOST:8642', 8642));
		assert.ok(hostAllowed('[::1]:8642', 8642));
		assert.ok(hostAllowed('localhost', 80));
		assert.ok(!hostAllowed('localhost', 8642));
		assert.ok(!hostAllowed('127.0.0.1:80', 8642));
		assert.ok(!hostAllowed('attacker.example:8642', 8642));
		assert.ok(!hostAllowed('127.0.0.1.attacker.example:8642', 8642));
		assert.ok(!hostAllowed(undefined, 8642));
	});
});


/** GET with a chosen Host header (fetch doesn't allow setting it) */
function rawGet(port: number, p: string, host: string): Promise<{ status: number }> {
	return new Promise((resolve, reject) => {
		let req = http.request({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
			res.resume();
			res.on('end', () => resolve({ status: res.statusCode! }));
		});
		req.on('error', reject);
		req.end();
	});
}
