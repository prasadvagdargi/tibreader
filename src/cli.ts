#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openArchive, Archive, Slice, FsEntry, SnapshotFS, VolumeVersion } from './index';
import { extract } from './fs/extract';
import { WindowsFS } from './win/fs';
import { WebDavServer } from './mount/webdav';
import { FuseMount } from './mount/fuse';
import { RcloneMount, normalizeDriveTarget } from './mount/rclone';


const USAGE = `Usage: tib <command> <backup file> [options]

Commands:
  info    <backup>                      Show the backup's files, backup points and settings
  ls      <backup> [path]               List a folder (default: the top level)
  cat     <backup> <path>               Write one file to standard output
  extract <backup> <destination> [path] Copy files out of the backup (default: everything)
  verify  <backup>                      Check the backup can be read; checks every data block
  mount   <backup>                      Serve the backup as a read-only drive (see below)

<backup> is any file of the backup: NAME_full_b1_s1_v1.tib (Windows) or NAME.tib (Mac).
Backup files are only ever read.

Options:
  -s, --slice <n>     Backup point to use: 1 is the oldest, -1 (default) the newest
  -l, --long          ls: show type, size and modified time
  -R, --recursive     ls: list everything below the path
      --json          info, ls: print JSON
      --overwrite     extract: replace files that already exist
      --quick         verify: only check the structure, not every data block
  -q, --quiet         extract, verify: only print the summary
  -d, --drive <X:>    mount: also mount it as a real drive (Windows letter, or a folder on macOS/Linux)
                      through rclone; no file size limits. Needs rclone + WinFsp (Windows) or FUSE
  -p, --port <n>      mount: WebDAV port (default 8642; a free port with --drive)
      --host <addr>   mount: address to listen on (default 127.0.0.1, this computer only)
      --fuse <dir>    mount: use native FUSE at <dir> instead of WebDAV (Linux/macOS, optional package)
      --debug         Show stack traces on errors
  -h, --help          Show this help
  -v, --version       Show the version

Mounting:
  'tib mount <backup> --drive R:' shows the backup as drive R: (best on Windows; needs
  'winget install WinFsp.WinFsp' and 'winget install Rclone.Rclone' once).
  Without --drive, 'tib mount' only starts a read-only WebDAV server, which every OS can open:
    Windows: net use Z: http://127.0.0.1:8642/   (Windows limits files to 50 MB this way)
    macOS:   Finder > Go > Connect to Server > http://127.0.0.1:8642/
    Linux:   gio mount dav://127.0.0.1:8642/     (or open that address in the file manager)
  Press Ctrl+C to stop.`;


class UsageError extends Error {}

const OPTIONS = {
	slice: { type: 'string', short: 's' },
	long: { type: 'boolean', short: 'l' },
	recursive: { type: 'boolean', short: 'R' },
	json: { type: 'boolean' },
	overwrite: { type: 'boolean' },
	quick: { type: 'boolean' },
	quiet: { type: 'boolean', short: 'q' },
	port: { type: 'string', short: 'p' },
	host: { type: 'string' },
	fuse: { type: 'string' },
	drive: { type: 'string', short: 'd' },
	debug: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
	version: { type: 'boolean', short: 'v' },
} as const;

type Options = {
	slice?: string; long?: boolean; recursive?: boolean; json?: boolean; overwrite?: boolean; quick?: boolean;
	quiet?: boolean; port?: string; host?: string; fuse?: string; drive?: string; debug?: boolean; help?: boolean; version?: boolean;
};


export function formatSize(bytes: number): string {
	let units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let v = bytes;
	let i = 0;
	while(v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

function formatDate(d: Date): string {
	let p = (n: number) => String(n).padStart(2, '0');
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function out(line = '') {
	process.stdout.write(line + '\n');
}

function err(line: string) {
	process.stderr.write(line + '\n');
}

function parseIntOption(value: string | undefined, name: string, fallback: number): number {
	if(value === undefined) {
		return fallback;
	}

	if(!/^-?\d+$/.test(value)) {
		throw new UsageError('--' + name + ' must be a whole number');
	}

	return parseInt(value, 10);
}

function pickSlice(archive: Archive, opts: Options): Slice {
	return archive.getSlice(parseIntOption(opts.slice, 'slice', -1));
}

async function withArchive<T>(file: string | undefined, fn: (a: Archive) => Promise<T>): Promise<T> {
	if(!file) {
		throw new UsageError('Missing the backup file');
	}

	let archive = await openArchive(file);
	try {
		return await fn(archive);
	}
	finally {
		await archive.close();
	}
}

async function countContents(snapshot: SnapshotFS) {
	let files = 0, folders = 0, bytes = 0;
	for await (let e of snapshot.walk()) {
		if(e.type === 'file') {
			files++;
			bytes += e.size;
		}
		else if(e.path !== '/') {
			folders++;
		}
	}
	return { files, folders, bytes };
}


async function cmdInfo(args: string[], opts: Options) {
	await withArchive(args[0], async (archive) => {
		let format = archive.volumes[0].header.version === VolumeVersion.Windows ? 'Windows' : 'Mac';

		let volumes = await Promise.all(archive.volumes.map(async (v) => ({
			file: v.fileName,
			size: await v.reader.length(),
			headerChecksumOk: v.header.checkSumValid
		})));

		let slices = [];
		for(let i = 0; i < archive.slices.length; i++) {
			let s = archive.slices[i];
			let contents = await countContents(await s.openFileSystem());
			slices.push({
				number: i + 1,
				id: s.id.toString('hex'),
				created: s.creationTime.toISOString(),
				incremental: s.parent !== null,
				config: s.config,
				contents
			});
		}

		if(opts.json) {
			out(JSON.stringify({ name: archive.name, format, volumes, slices }, null, 2));
			return;
		}

		out('Backup:        ' + archive.name + ' (' + format + ' format)');
		out('Files:         ' + volumes.length);
		for(let v of volumes) {
			out('  ' + path.basename(v.file) + '  ' + formatSize(v.size) + (v.headerChecksumOk ? '' : '  (header checksum mismatch)'));
		}

		out('Backup points: ' + slices.length);
		for(let s of slices) {
			out('  #' + s.number + '  ' + formatDate(new Date(s.created)) + '  ' + (s.incremental ? 'incremental' : 'full') + '  id ' + s.id);

			let c = s.config;
			if(c.productinfo) {
				out('      Made by:     ' + c.productinfo.name + ' ' + c.productinfo.version.major + '.' + c.productinfo.version.minor + ' (build ' + c.productinfo.build_number + ')');
			}
			if(c.compression) {
				out('      Compression: ' + c.compression);
			}
			if(c.encryption) {
				out('      Encryption:  ' + c.encryption);
			}
			if(c.machine_id) {
				out('      Computer id: ' + c.machine_id);
			}
			if(c.includePaths && c.includePaths.length) {
				out('      Included:    ' + c.includePaths.join(', '));
			}
			out('      Contents:    ' + s.contents.files.toLocaleString('en-US') + ' files, ' + s.contents.folders.toLocaleString('en-US') + ' folders, ' + formatSize(s.contents.bytes));
		}
	});
}


function lsLine(e: FsEntry, name: string, long?: boolean) {
	if(!long) {
		return name + (e.type === 'directory' ? '/' : '');
	}

	let type = e.type === 'directory' ? 'd' : '-';
	let size = e.type === 'directory' ? '' : String(e.size);
	return type + '  ' + formatDate(e.mtime) + '  ' + size.padStart(14) + '  ' + name + (e.type === 'directory' ? '/' : '');
}

async function cmdLs(args: string[], opts: Options) {
	await withArchive(args[0], async (archive) => {
		let snapshot = await pickSlice(archive, opts).openFileSystem();
		let target = args[1] || '/';

		let top = await snapshot.stat(target);
		if(!top) {
			throw new Error('No such file or folder in the backup: ' + target);
		}

		let entries: FsEntry[] = [];
		if(opts.recursive) {
			for await (let e of snapshot.walk(target)) {
				if(e.path !== top.path || top.type === 'file') {
					entries.push(e);
				}
			}
		}
		else {
			entries = top.type === 'directory' ? (await snapshot.list(target))! : [ top ];
		}

		if(opts.json) {
			out(JSON.stringify(entries, null, 2));
			return;
		}

		for(let e of entries) {
			out(lsLine(e, opts.recursive ? e.path : e.name, opts.long));
		}
	});
}


async function cmdCat(args: string[], opts: Options) {
	if(!args[1]) {
		throw new UsageError('Missing the path of the file inside the backup');
	}

	await withArchive(args[0], async (archive) => {
		let snapshot = await pickSlice(archive, opts).openFileSystem();
		let e = await snapshot.stat(args[1]);
		if(!e) {
			throw new Error('No such file in the backup: ' + args[1]);
		}
		if(e.type !== 'file') {
			throw new Error('Not a file: ' + args[1]);
		}

		let chunk = 1024 * 1024;
		for(let off = 0; off < e.size; off += chunk) {
			let buf = await snapshot.read(e.path, off, chunk);
			if(!process.stdout.write(buf)) {
				await new Promise((resolve) => process.stdout.once('drain', resolve));
			}
		}
	});
}


async function cmdExtract(args: string[], opts: Options) {
	if(!args[1]) {
		throw new UsageError('Missing the destination folder');
	}

	await withArchive(args[0], async (archive) => {
		let snapshot = await pickSlice(archive, opts).openFileSystem();
		let started = Date.now();

		let result = await extract(snapshot, args[2] || '/', args[1], {
			overwrite: opts.overwrite,
			onEntry: (e) => {
				if(!opts.quiet && e.type === 'file') {
					out(e.path);
				}
			}
		});

		let secs = (Date.now() - started) / 1000;
		out('Extracted ' + result.files.toLocaleString('en-US') + ' files and ' + result.directories.toLocaleString('en-US') + ' folders (' + formatSize(result.bytes) + ') in ' + secs.toFixed(1) + ' s to ' + path.resolve(args[1]));
	});
}


async function cmdVerify(args: string[], opts: Options) {
	return withArchive(args[0], async (archive) => {
		let problems = 0;
		let unstored = 0;

		// Opening already checked every header, footer, trailer and the metadata of each backup point
		for(let v of archive.volumes) {
			if(!v.header.checkSumValid) {
				err('Header checksum mismatch: ' + v.fileName);
				problems++;
			}
		}

		let slices = opts.slice !== undefined ? [ pickSlice(archive, opts) ] : archive.slices;

		for(let s of slices) {
			let n = archive.slices.indexOf(s) + 1;
			let snapshot = await s.openFileSystem();
			let total = await countContents(snapshot);
			out('Backup point #' + n + ': ' + total.files.toLocaleString('en-US') + ' files, ' + formatSize(total.bytes));

			if(opts.quick) {
				continue;
			}

			let files = 0, bytes = 0, lastReport = Date.now();
			for await (let e of snapshot.walk()) {
				if(e.type !== 'file') {
					continue;
				}

				try {
					if(snapshot instanceof WindowsFS) {
						// Checks each block against its stored MD5
						let blocks = await snapshot.verifyFile(e.path);
						if(blocks === 0 && e.size > 0) {
							unstored++;
						}
					}
					else {
						// Decompressing every block checks its structure
						for(let off = 0; off < e.size; off += 4 * 1024 * 1024) {
							await snapshot.read(e.path, off, 4 * 1024 * 1024);
						}
					}
				}
				catch(ex: any) {
					err('FAILED ' + e.path + ': ' + ex.message);
					problems++;
				}

				files++;
				bytes += e.size;

				if(!opts.quiet && Date.now() - lastReport > 2000) {
					lastReport = Date.now();
					err('  checked ' + files.toLocaleString('en-US') + ' / ' + total.files.toLocaleString('en-US') + ' files, ' + formatSize(bytes) + ' / ' + formatSize(total.bytes));
				}
			}
		}

		let note = unstored > 0 ? ' (' + unstored + ' file(s) have no data stored in the backup and read as zeros)' : '';
		out((problems === 0 ? 'OK: no problems found' : problems + ' problem(s) found') + note);
		return problems === 0 ? 0 : 1;
	});
}


function isLoopback(host: string) {
	return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

async function cmdMount(args: string[], opts: Options) {
	if(!args[0]) {
		throw new UsageError('Missing the backup file');
	}

	let archive = await openArchive(args[0]);
	let stop: () => Promise<void>;

	try {
		let snapshot = await pickSlice(archive, opts).openFileSystem();

		if(opts.fuse && opts.drive) {
			throw new UsageError('Use either --fuse or --drive, not both');
		}

		if(opts.fuse) {
			let mount = new FuseMount(snapshot, opts.fuse);
			await mount.mount();
			out('Mounted read-only at ' + path.resolve(opts.fuse) + '. Press Ctrl+C to unmount.');
			stop = () => mount.unmount();
		}
		else if(opts.drive) {
			// rclone talks to our WebDAV server over loopback; any free port will do
			let server = new WebDavServer(snapshot);
			let addr = await server.listen(parseIntOption(opts.port, 'port', 0), '127.0.0.1');

			let target = normalizeDriveTarget(opts.drive);
			let drive = new RcloneMount('http://127.0.0.1:' + addr.port + '/', target, archive.name);
			try {
				await drive.mount();
			}
			catch(e) {
				await server.close();
				throw e;
			}

			out('Mounted the backup read-only as ' + target + '. Press Ctrl+C to unmount.');
			stop = async () => {
				await drive.unmount();
				await server.close();
			};
		}
		else {
			let host = opts.host || '127.0.0.1';
			let port = parseIntOption(opts.port, 'port', 8642);
			if(!isLoopback(host)) {
				err('warning: listening on ' + host + ' lets other computers on the network read this backup');
			}

			let server = new WebDavServer(snapshot);
			let addr = await server.listen(port, host);
			let url = 'http://' + (addr.family === 'IPv6' ? '[' + addr.address + ']' : addr.address) + ':' + addr.port + '/';

			out('Serving the backup read-only at ' + url);
			if(process.platform === 'win32') {
				out('Open it as a drive:  net use Z: ' + url + ' /persistent:no');
				out('                     (or File Explorer > This PC > Map network drive > ' + url + ')');
				out('Windows only copies files up to 50 MB over WebDAV unless that limit is raised; see README.');
				out('When done:           net use Z: /delete');
			}
			else if(process.platform === 'darwin') {
				out('Open it in Finder:   Go > Connect to Server > ' + url);
			}
			else {
				out('Open it:             gio mount dav://' + url.slice('http://'.length));
			}
			out('Press Ctrl+C to stop.');

			stop = () => server.close();
		}
	}
	catch(e) {
		await archive.close();
		throw e;
	}

	await new Promise<void>((resolve) => {
		let done = false;
		let onSignal = () => {
			if(done) {
				return;
			}
			done = true;
			out('\nStopping...');
			resolve();
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});

	try {
		await stop();
	}
	finally {
		await archive.close();
	}
}


/**
 * Version from the package's package.json (searched upwards, so it works from dist/ and test builds)
 */
function packageVersion(): string {
	let dir = __dirname;
	for(let i = 0; i < 4; i++) {
		let file = path.join(dir, 'package.json');
		if(fs.existsSync(file)) {
			let pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
			if(pkg.name === 'tibreader') {
				return pkg.version;
			}
		}
		dir = path.dirname(dir);
	}

	return 'unknown';
}

export async function main(argv: string[]): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
	}
	catch(e: any) {
		err('tib: ' + e.message);
		err('Run "tib --help" for usage.');
		return 2;
	}

	let opts = parsed.values as Options;
	let [ command, ...args ] = parsed.positionals;

	if(opts.version) {
		out(packageVersion());
		return 0;
	}

	if(opts.help || !command) {
		out(USAGE);
		return command || opts.help ? 0 : 2;
	}

	try {
		switch(command) {
			case 'info': await cmdInfo(args, opts); return 0;
			case 'ls': await cmdLs(args, opts); return 0;
			case 'cat': await cmdCat(args, opts); return 0;
			case 'extract': await cmdExtract(args, opts); return 0;
			case 'verify': return await cmdVerify(args, opts);
			case 'mount': await cmdMount(args, opts); return 0;
			default:
				throw new UsageError('Unknown command: ' + command);
		}
	}
	catch(e: any) {
		if(e instanceof UsageError) {
			err('tib: ' + e.message);
			err('Run "tib --help" for usage.');
			return 2;
		}

		err('tib: ' + (opts.debug && e.stack ? e.stack : e.message));
		return 1;
	}
}

if(require.main === module) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
