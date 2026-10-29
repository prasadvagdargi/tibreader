import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, ChildProcess } from 'node:child_process';
import { writeFileBackup, openArchive, BackupEntry } from '../src/index';
import { tempDir } from './helpers/windows-fixture';


const CLI = path.join(__dirname, '..', 'src', 'cli.js');

/** Talks to 'tib mcp' over its standard input and output */
class McpClient {
	private child: ChildProcess;
	private nextId = 1;
	private waiting = new Map<number | string | null, (message: any) => void>();
	/** Every message received, in order */
	received: any[] = [];
	stderr = '';

	constructor() {
		this.child = spawn(process.execPath, [ CLI, 'mcp' ], { stdio: [ 'pipe', 'pipe', 'pipe' ] });
		this.child.stderr!.on('data', (d) => this.stderr += d);
		let lines = readline.createInterface({ input: this.child.stdout! });
		lines.on('line', (line) => {
			let message = JSON.parse(line); // stdout must carry only JSON-RPC messages
			this.received.push(message);
			let resolve = this.waiting.get(message.id);
			if(resolve) {
				this.waiting.delete(message.id);
				resolve(message);
			}
		});
	}

	sendRaw(text: string) {
		this.child.stdin!.write(text + '\n');
	}

	/** Sends a request and waits for its response */
	request(method: string, params?: object, id: number | string | null = this.nextId++): Promise<any> {
		let response = new Promise((resolve) => this.waiting.set(id, resolve));
		this.sendRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		return response;
	}

	/** Calls a tool; returns the parsed result, or the error text for a failed call */
	async call(name: string, args: object): Promise<any> {
		let response = await this.request('tools/call', { name, arguments: args });
		assert.ok(response.result, 'tools/call answered with a result: ' + JSON.stringify(response));
		let text = response.result.content[0].text;
		return response.result.isError ? { error: text } : JSON.parse(text);
	}

	async close(): Promise<number | null> {
		let exited = new Promise<number | null>((resolve) => this.child.once('exit', resolve));
		this.child.stdin!.end();
		return exited;
	}
}


const MODIFIED = new Date('2024-01-02T03:04:05Z');

function folder(backupPath: string): BackupEntry {
	return { backupPath, type: 'directory', size: 0, modified: MODIFIED };
}

function file(backupPath: string, data: Buffer | string, modified = MODIFIED): BackupEntry {
	let buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
	return { backupPath, type: 'file', size: buf.length, modified, read: async (offset, length) => buf.subarray(offset, offset + length) };
}

// Three copies of one photo; a file of the same size that only differs at the end (not a duplicate)
const PHOTO = crypto.randomBytes(200 * 1024);
const ALMOST_PHOTO = Buffer.concat([ PHOTO.subarray(0, PHOTO.length - 1), Buffer.from([ PHOTO[PHOTO.length - 1] ^ 0xFF ]) ]);
const MOVIE = crypto.randomBytes(1024 * 1024);
const UTF16 = Buffer.concat([ Buffer.from([ 0xFF, 0xFE ]), Buffer.from('Grüße aus dem Backup', 'utf16le') ]);

function olderEntries(): BackupEntry[] {
	return [
		folder('C:/Docs'),
		file('C:/Docs/notes.txt', 'hello notes\nline 2\n'),
		file('C:/Docs/utf16.txt', UTF16),
		file('C:/Docs/empty.txt', ''),
		file('C:/Docs/photo.jpg', PHOTO),
		file('C:/Docs/almost.jpg', ALMOST_PHOTO),
		folder('C:/Copies'),
		file('C:/Copies/photo copy.jpg', PHOTO),
		folder('C:/Copies/Deeper'),
		file('C:/Copies/Deeper/PHOTO.jpg', PHOTO),
		folder('C:/Video'),
		file('C:/Video/movie.mp4', MOVIE),
	];
}

function newerEntries(): BackupEntry[] {
	return [
		...olderEntries().filter((e) => e.backupPath !== 'C:/Video/movie.mp4' && e.backupPath !== 'C:/Docs/notes.txt'),
		file('C:/Docs/notes.txt', 'hello notes\nline 2\nline 3\n', new Date('2024-02-01T00:00:00Z')),
		file('C:/Docs/new.txt', 'brand new'),
	];
}


describe('tib mcp (MCP server)', () => {
	let dir = '';
	let older = '';
	let newer = '';
	let client: McpClient;

	before(async () => {
		dir = tempDir('tib-mcp-');
		fs.mkdirSync(path.join(dir, 'backups', 'copy'), { recursive: true });
		older = (await writeFileBackup(path.join(dir, 'backups', 'Older.tib'), olderEntries())).file;
		newer = (await writeFileBackup(path.join(dir, 'backups', 'Newer.tib'), newerEntries())).file;
		fs.copyFileSync(older, path.join(dir, 'backups', 'copy', path.basename(older)));
		client = new McpClient();
	});

	after(async () => {
		await client.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('initialize agrees on a protocol version and offers tools', async () => {
		let r = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
		assert.equal(r.result.protocolVersion, '2025-06-18');
		assert.ok(r.result.capabilities.tools);
		assert.equal(r.result.serverInfo.name, 'tibreader');
		client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

		let unknownVersion = await client.request('initialize', { protocolVersion: '1999-01-01' });
		assert.match(unknownVersion.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
		assert.notEqual(unknownVersion.result.protocolVersion, '1999-01-01');
	});

	test('tools/list describes every tool with a schema; writing tools are marked', async () => {
		let r = await client.request('tools/list');
		let names = r.result.tools.map((t: any) => t.name);
		assert.deepEqual(names.sort(), [
			'compare_backup_points', 'describe_backup', 'extract_files', 'find_backups_in_folder', 'find_duplicate_files',
			'find_files', 'list_folder', 'read_file_text', 'summarize_folder_sizes', 'verify_backup', 'write_cleaned_copy_of_backup',
		]);
		for(let t of r.result.tools) {
			assert.equal(t.inputSchema.type, 'object');
			assert.ok(t.description.length > 20, t.name);
			assert.equal(t.annotations.readOnlyHint, !/^(extract_files|write_cleaned_copy_of_backup)$/.test(t.name), t.name);
		}
	});

	test('protocol errors: bad JSON, unknown method, unknown tool; notifications get no answer', async () => {
		let before = client.received.length;
		client.sendRaw('{ not json');
		client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } }));
		assert.deepEqual((await client.request('ping')).result, {});
		let parseError = client.received.slice(before).find((m) => m.error && m.error.code === -32700);
		assert.ok(parseError, 'a parse error was reported');
		assert.equal(client.received.length - before, 2, 'only the parse error and the ping were answered');

		assert.equal((await client.request('no/such/method')).error.code, -32601);
		assert.equal((await client.request('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
	});

	test('wrong arguments come back as tool errors the assistant can fix', async () => {
		assert.match((await client.call('list_folder', {})).error, /Missing argument "backup_file"/);
		assert.match((await client.call('list_folder', { backup_file: older, folder: '/C' })).error, /Unknown argument "folder"/);
		assert.match((await client.call('list_folder', { backup_file: older, backup_point: 'last' })).error, /whole number/);
		assert.match((await client.call('find_files', { backup_file: older, sort_by: 'color' })).error, /one of: size, modified, path/);
		assert.match((await client.call('describe_backup', { backup_file: path.join(dir, 'missing.tib') })).error, /No such backup file/);
		assert.match((await client.call('list_folder', { backup_file: older, backup_point: 2 })).error, /No backup point 2/);
	});

	test('find_backups_in_folder groups backup files and spots identical copies', async () => {
		let r = await client.call('find_backups_in_folder', { folder_path: path.join(dir, 'backups') });
		assert.equal(r.backups_found, 3);
		assert.deepEqual(r.backups.map((b: any) => b.backup_name).sort(), [ 'Newer', 'Older', 'Older' ]);
		let olderBackup = r.backups.find((b: any) => b.backup_file_to_open === older);
		assert.equal(olderBackup.files.length, 1);
		assert.equal(olderBackup.total.bytes, fs.statSync(older).size);

		assert.equal(r.identical_copies.length, 1);
		assert.deepEqual(r.identical_copies[0].files.sort(), [ older, path.join(dir, 'backups', 'copy', path.basename(older)) ].sort());

		let confirmed = await client.call('find_backups_in_folder', { folder_path: path.join(dir, 'backups'), confirm_identical_with_full_hash: true });
		assert.match(confirmed.identical_copies[0].compared, /SHA-256/);

		let shallow = await client.call('find_backups_in_folder', { folder_path: path.join(dir, 'backups'), search_subfolders: false, look_for_identical_copies: false });
		assert.equal(shallow.backups_found, 2);
	});

	test('describe_backup shows format, files and backup points with contents', async () => {
		let r = await client.call('describe_backup', { backup_file: older });
		assert.equal(r.format, 'Windows');
		assert.equal(r.files.length, 1);
		assert.equal(r.backup_points.length, 1);
		assert.equal(r.backup_points[0].number, 1);
		assert.equal(r.backup_points[0].contents.files, 8);
		assert.equal(r.backup_points[0].contents.bytes, olderEntries().reduce((s, e) => s + e.size, 0));
	});

	test('list_folder lists one level, recursively, and truncates', async () => {
		let top = await client.call('list_folder', { backup_file: older, folder_path: '/c/docs' });
		assert.equal(top.folder, '/C/Docs');
		assert.deepEqual(top.entries.map((e: any) => e.path).sort(), [ '/C/Docs/almost.jpg', '/C/Docs/empty.txt', '/C/Docs/notes.txt', '/C/Docs/photo.jpg', '/C/Docs/utf16.txt' ]);
		let notes = top.entries.find((e: any) => e.path === '/C/Docs/notes.txt');
		assert.equal(notes.bytes, 19);
		assert.equal(notes.modified, MODIFIED.toISOString());

		let all = await client.call('list_folder', { backup_file: older, folder_path: '/C', recursive: true, max_entries: 3 });
		assert.equal(all.total_entries, 12);
		assert.equal(all.entries.length, 3);
		assert.equal(all.truncated, true);
	});

	test('summarize_folder_sizes shows the biggest folders and extensions first', async () => {
		let r = await client.call('summarize_folder_sizes', { backup_file: older, folder_path: '/C' });
		assert.deepEqual(r.entries.map((e: any) => e.path), [ '/C/Video', '/C/Docs', '/C/Copies' ]);
		assert.equal(r.entries[0].bytes, MOVIE.length);
		assert.equal(r.total.files, 8);
		assert.equal(r.by_extension[0].extension, '.mp4');
		assert.equal(r.by_extension[1].extension, '.jpg');
		assert.equal(r.by_extension[1].files, 4);

		let deeper = await client.call('summarize_folder_sizes', { backup_file: older, folder_path: '/C', depth: 2 });
		let paths = deeper.entries.map((e: any) => e.path);
		assert.ok(paths.includes('/C/Copies/Deeper'));
		assert.ok(paths.includes('/C/Docs/photo.jpg'));
		assert.ok(!paths.includes('/C/Copies'), 'folders above the depth are broken down');
	});

	test('find_files filters by name, extension, size and date, and sorts', async () => {
		let largest = await client.call('find_files', { backup_file: older, max_results: 2 });
		assert.equal(largest.matching_files, 8);
		assert.deepEqual(largest.files.map((f: any) => f.path)[0], '/C/Video/movie.mp4');
		assert.equal(largest.truncated, true);

		let photos = await client.call('find_files', { backup_file: older, name_pattern: 'photo*.JPG' });
		assert.deepEqual(photos.files.map((f: any) => f.path).sort(), [ '/C/Copies/Deeper/PHOTO.jpg', '/C/Copies/photo copy.jpg', '/C/Docs/photo.jpg' ]);

		let txt = await client.call('find_files', { backup_file: older, extensions: [ 'TXT' ], sort_by: 'path', folder_path: '/C/Docs' });
		assert.deepEqual(txt.files.map((f: any) => f.path), [ '/C/Docs/empty.txt', '/C/Docs/notes.txt', '/C/Docs/utf16.txt' ]);

		let small = await client.call('find_files', { backup_file: older, min_size_bytes: 1, max_size_bytes: 100 });
		assert.equal(small.matching_files, 2);

		assert.equal((await client.call('find_files', { backup_file: newer, modified_after: '2024-01-15' })).matching_files, 1);
		assert.match((await client.call('find_files', { backup_file: older, modified_after: 'yesterday-ish' })).error, /not a date/);
	});

	test('find_duplicate_files finds equal contents, not just equal sizes', async () => {
		let r = await client.call('find_duplicate_files', { backup_file: older });
		assert.equal(r.duplicate_groups, 1);
		assert.equal(r.groups[0].copies, 3);
		assert.equal(r.groups[0].wasted.bytes, 2 * PHOTO.length);
		assert.ok(!r.groups[0].paths.includes('/C/Docs/almost.jpg'));
		assert.equal(r.stopped_early, false);

		let byName = await client.call('find_duplicate_files', { backup_file: older, match_by: 'name_and_size' });
		assert.deepEqual(byName.groups[0].paths, [ '/C/Copies/Deeper/PHOTO.jpg', '/C/Docs/photo.jpg' ]);

		let limited = await client.call('find_duplicate_files', { backup_file: older, max_bytes_to_hash: 1000 });
		assert.equal(limited.stopped_early, true);
		assert.equal(limited.duplicate_groups, 0);
	});

	test('read_file_text reads UTF-8 and UTF-16 text, and previews binary files as hex', async () => {
		let notes = await client.call('read_file_text', { backup_file: older, file_path: '/C/Docs/notes.txt' });
		assert.equal(notes.text, 'hello notes\nline 2\n');
		assert.equal(notes.more_after, false);

		let part = await client.call('read_file_text', { backup_file: older, file_path: '/C/Docs/notes.txt', offset: 6, max_bytes: 5 });
		assert.equal(part.text, 'notes');
		assert.equal(part.more_after, true);

		let utf16 = await client.call('read_file_text', { backup_file: older, file_path: '/C/Docs/utf16.txt' });
		assert.equal(utf16.encoding, 'utf-16le');
		assert.equal(utf16.text, 'Grüße aus dem Backup');

		let binary = await client.call('read_file_text', { backup_file: older, file_path: '/C/Video/movie.mp4' });
		assert.equal(binary.binary, true);
		assert.ok(binary.hex_preview.startsWith(MOVIE.subarray(0, 16).toString('hex')));

		assert.match((await client.call('read_file_text', { backup_file: older, file_path: '/C/Docs' })).error, /Not a file/);
	});

	test('compare_backup_points lists added, removed and changed files', async () => {
		let r = await client.call('compare_backup_points', { backup_file: older, newer_backup_file: newer });
		assert.deepEqual(r.added.map((e: any) => e.path), [ '/C/Docs/new.txt' ]);
		assert.deepEqual(r.removed.map((e: any) => e.path), [ '/C/Video/movie.mp4' ]);
		assert.deepEqual(r.changed.map((e: any) => e.path), [ '/C/Docs/notes.txt' ]);
		assert.equal(r.summary.removed.bytes, MOVIE.length);
		assert.equal(r.summary.unchanged_files, 6);

		// A backup with one backup point has nothing before it to compare with
		assert.match((await client.call('compare_backup_points', { backup_file: older })).error, /No backup point -2/);
	});

	test('verify_backup checks data, or only the structure', async () => {
		let full = await client.call('verify_backup', { backup_file: older });
		assert.equal(full.ok, true);
		assert.equal(full.backup_points[0].files_checked, 8);

		let quick = await client.call('verify_backup', { backup_file: older, quick: true, backup_point: -1 });
		assert.equal(quick.ok, true);
		assert.equal(quick.checked, 'structure only');
	});

	test('extract_files copies files out, and handles existing files as asked', async () => {
		let dest = path.join(dir, 'extracted');
		let r = await client.call('extract_files', { backup_file: older, paths_in_backup: [ '/C/Docs/notes.txt', '/C/Copies' ], destination_folder: dest });
		assert.equal(r.files_written, 3);
		assert.equal(fs.readFileSync(path.join(dest, 'notes.txt'), 'utf8'), 'hello notes\nline 2\n');
		assert.ok(fs.readFileSync(path.join(dest, 'Copies', 'Deeper', 'PHOTO.jpg')).equals(PHOTO));

		let again = { backup_file: older, paths_in_backup: [ '/C/Docs/notes.txt' ], destination_folder: dest };
		assert.match((await client.call('extract_files', again)).error, /already exists/);
		assert.equal((await client.call('extract_files', { ...again, if_file_exists: 'skip' })).files_skipped, 1);
		await client.call('extract_files', { ...again, if_file_exists: 'rename' });
		assert.ok(fs.existsSync(path.join(dest, 'notes (2).txt')));
	});

	test('write_cleaned_copy_of_backup writes a new backup without the chosen files', async () => {
		let output = path.join(dir, 'Cleaned.tib');
		let before = fs.readFileSync(older);
		let r = await client.call('write_cleaned_copy_of_backup', {
			backup_file: older,
			paths_to_leave_out: [ '/C/Copies', '/C/Video/movie.mp4' ],
			new_backup_file: output,
		});
		assert.equal(r.new_backup_file, path.join(dir, 'Cleaned_full_b1_s1_v1.tib'));
		assert.equal(r.left_out_total.bytes, 2 * PHOTO.length + MOVIE.length);
		assert.ok(fs.readFileSync(older).equals(before), 'the original backup is unchanged');

		let archive = await openArchive(r.new_backup_file);
		try {
			let snapshot = await archive.getSlice().openFileSystem();
			assert.equal(await snapshot.stat('/C/Copies'), undefined);
			assert.equal(await snapshot.stat('/C/Video/movie.mp4'), undefined);
			assert.ok((await snapshot.read('/C/Docs/photo.jpg', 0, PHOTO.length)).equals(PHOTO));
		}
		finally {
			await archive.close();
		}

		// Never replaces a file: neither an existing one nor one of the backup being read
		let args = { backup_file: older, paths_to_leave_out: [ '/C/Copies' ], new_backup_file: output };
		assert.match((await client.call('write_cleaned_copy_of_backup', args)).error, /exists/);
		assert.match((await client.call('write_cleaned_copy_of_backup', { ...args, new_backup_file: older })).error, /would replace a file of the backup/);
	});

	test('the server exits cleanly when its input ends, and writes nothing else to stdout', async () => {
		let other = new McpClient();
		assert.equal((await other.request('ping')).id, 1);
		assert.equal(await other.close(), 0);
		assert.equal(other.stderr, '');
	});
});
