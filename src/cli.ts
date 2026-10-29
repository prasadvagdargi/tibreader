#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openArchive, Archive, Slice, FsEntry, OpenOptions } from './index';
import { extract, measure } from './fs/extract';
import { describeArchive } from './info';
import { verifyHeaders, verifySnapshot } from './verify';
import { WebDavServer } from './mount/webdav';
import { FuseMount } from './mount/fuse';
import { RcloneMount, normalizeDriveTarget } from './mount/rclone';
import { detectFormat } from './detect';
import os from 'node:os';
import { OverlayFS } from './write/overlay';
import { backupFileName, writeFileBackup } from './write/writer';
import { addLocalToOverlay, localEntries, writeSnapshotBackup } from './write/sources';
import { exportImage } from './write/export';


const USAGE = `Usage: tib <command> <backup file> [options]

Commands:
  info    <backup>                      Show the backup's files, backup points and settings
  ls      <backup> [path]               List a folder (default: the top level)
  cat     <backup> <path>               Write one file to standard output
  extract <backup> <destination> [path] Copy files out of the backup (default: everything)
  verify  <backup>                      Check the backup can be read; checks every data block
  mount   <backup>                      Serve the backup as a drive (see below)
  create  <new.tib> <file or folder>... Make a new file/folder backup of files on this computer
  edit    <backup> <new.tib>            Write a NEW backup: this one with changes (--add, --delete,
                                        --overlay); also converts disk images and Mac backups (--from)
  export  <backup> <image> <out>        Write a disk/partition image out, e.g. '/Partition 2.img'
                                        to out.img (raw) or out.vhd (Windows can attach it)

<backup> is any file of the backup: NAME_full_b1_s1_v1.tib (Windows), NAME.tib (Mac) or NAME.tibx.
Existing backup files are only ever read; create, edit and export write new files.
New backups are read by this tool; whether True Image accepts them is not known.

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
      --password <p>  Password of an encrypted .tibx backup (experimental; or set TIB_PASSWORD)
  -w, --writable <dir> mount: accept changes, keeping them in <dir> (the backup isn't changed);
                      'tib edit <backup> <new.tib> --overlay <dir>' turns them into a new backup
      --add <local=path>  edit: add a file or folder from this computer at a path in the backup
      --delete <path> edit: leave this file or folder out (repeatable, like --add)
      --overlay <dir> edit: apply the changes kept by 'mount --writable <dir>'
      --from <path>   edit: only take this folder of the backup, e.g. '/Volume (Windows)'
      --as-drive <X>  create, edit: drive letter for files without one (default C)
      --level <0-9>   create, edit: compression level (default 6)
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
	password: { type: 'string' },
	writable: { type: 'string', short: 'w' },
	add: { type: 'string', multiple: true },
	delete: { type: 'string', multiple: true },
	overlay: { type: 'string' },
	from: { type: 'string' },
	'as-drive': { type: 'string' },
	level: { type: 'string' },
	debug: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
	version: { type: 'boolean', short: 'v' },
} as const;

type Options = {
	slice?: string; long?: boolean; recursive?: boolean; json?: boolean; overwrite?: boolean; quick?: boolean;
	quiet?: boolean; port?: string; host?: string; fuse?: string; drive?: string; password?: string;
	writable?: string; add?: string[]; delete?: string[]; overlay?: string; from?: string; 'as-drive'?: string; level?: string; debug?: boolean; help?: boolean; version?: boolean;
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

/** Open options from the command line; the password can also come from TIB_PASSWORD */
function openOptions(opts: Options): OpenOptions {
	let password = opts.password ?? process.env.TIB_PASSWORD;
	return password !== undefined ? { password } : {};
}

async function withArchive<T>(file: string | undefined, opts: Options, fn: (a: Archive) => Promise<T>): Promise<T> {
	if(!file) {
		throw new UsageError('Missing the backup file');
	}

	let archive = await openArchive(file, openOptions(opts));
	try {
		return await fn(archive);
	}
	finally {
		await archive.close();
	}
}

async function cmdInfo(args: string[], opts: Options) {
	// Say what the file is, even when it can't be opened
	if(args[0] && fs.existsSync(args[0])) {
		let detected = await detectFormat(args[0]);
		if(detected.kind !== 'tib' && detected.kind !== 'tibx') {
			out('Format:        ' + detected.description);
		}
	}

	await withArchive(args[0], opts, async (archive) => {
		let info = await describeArchive(archive);
		let { format, volumes, slices } = info;

		if(opts.json) {
			out(JSON.stringify(info, null, 2));
			return;
		}

		out('Backup:        ' + archive.name + ' (' + format + ' format)');
		out('Files:         ' + volumes.length);
		for(let v of volumes) {
			out('  ' + path.basename(v.file) + '  ' + formatSize(v.size) + (v.headerChecksumOk ? '' : '  (header checksum mismatch)'));
		}

		out('Backup points: ' + slices.length);
		for(let s of slices) {
			out('  #' + s.number + '  ' + formatDate(new Date(s.created)) + '  ' + (s.incremental ? 'incremental' : 'full') + (s.kind === 'disk' ? ' disk image' : '') + '  id ' + s.id);

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
			let contents = s.contents!;
			out('      Contents:    ' + contents.files.toLocaleString('en-US') + ' files, ' + contents.folders.toLocaleString('en-US') + ' folders, ' + formatSize(contents.bytes));
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
	await withArchive(args[0], opts, async (archive) => {
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

	await withArchive(args[0], opts, async (archive) => {
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

	await withArchive(args[0], opts, async (archive) => {
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
	return withArchive(args[0], opts, async (archive) => {
		let problems = 0;
		let unstored = 0;

		// Opening already checked every header, footer, trailer and the metadata of each backup point
		for(let p of verifyHeaders(archive)) {
			err(p.message + ': ' + p.path);
			problems++;
		}

		let slices = opts.slice !== undefined ? [ pickSlice(archive, opts) ] : archive.slices;

		for(let s of slices) {
			let n = archive.slices.indexOf(s) + 1;
			let snapshot = await s.openFileSystem();
			let total = await measure(snapshot);
			out('Backup point #' + n + ': ' + total.files.toLocaleString('en-US') + ' files, ' + formatSize(total.bytes));

			if(opts.quick) {
				continue;
			}

			let lastReport = Date.now();
			let result = await verifySnapshot(snapshot, {
				totals: total,
				onProblem: (p) => err('FAILED ' + p.path + ': ' + p.message),
				onProgress: (p) => {
					if(!opts.quiet && Date.now() - lastReport > 2000) {
						lastReport = Date.now();
						err('  checked ' + p.files.toLocaleString('en-US') + ' / ' + p.totalFiles.toLocaleString('en-US') + ' files, ' + formatSize(p.bytes) + ' / ' + formatSize(p.totalBytes));
					}
				}
			});

			problems += result.problems.length;
			unstored += result.unstored;
		}

		let note = unstored > 0 ? ' (' + unstored + ' file(s) have no data stored in the backup and read as zeros)' : '';
		out((problems === 0 ? 'OK: no problems found' : problems + ' problem(s) found') + note);
		return problems === 0 ? 0 : 1;
	});
}


function compressionLevel(opts: Options): number | undefined {
	let level = opts.level === undefined ? undefined : parseIntOption(opts.level, 'level', 6);
	if(level !== undefined && (level < 0 || level > 9)) {
		throw new UsageError('--level must be 0 to 9');
	}
	return level;
}

function progressPrinter(opts: Options) {
	let last = 0;
	return (p: { files: number; bytes: number; path: string }) => {
		if(!opts.quiet && Date.now() - last > 2000) {
			last = Date.now();
			err('  ' + p.files.toLocaleString('en-US') + ' files, ' + formatSize(p.bytes) + '  ' + p.path);
		}
	};
}

async function cmdCreate(args: string[], opts: Options) {
	if(args.length < 2) {
		throw new UsageError('Usage: tib create <new.tib> <file or folder>...');
	}
	let started = Date.now();
	let result = await writeFileBackup(args[0], localEntries(args.slice(1), opts['as-drive']), {
		overwrite: opts.overwrite,
		compressionLevel: compressionLevel(opts),
		onProgress: progressPrinter(opts),
	});
	out('Created ' + result.file + ': ' + result.files.toLocaleString('en-US') + ' files, ' + result.folders.toLocaleString('en-US') + ' folders, ' + formatSize(result.bytes) + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
}

async function cmdEdit(args: string[], opts: Options) {
	if(args.length < 2) {
		throw new UsageError('Usage: tib edit <backup> <new.tib> [--add local=path] [--delete path] [--overlay dir] [--from path]');
	}
	await withArchive(args[0], opts, async (archive) => {
		// Never write over a file of the backup being read
		let output = path.resolve(backupFileName(args[1]));
		if((await archive.files()).some((f) => path.resolve(f.fileName).toLowerCase() === output.toLowerCase())) {
			throw new Error('The new backup would replace a file of the backup being edited; choose another name');
		}

		let snapshot = await pickSlice(archive, opts).openFileSystem();
		let tempDir = opts.overlay ? null : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tib-edit-'));
		try {
			let overlay = await OverlayFS.open(snapshot, opts.overlay || tempDir!);
			for(let p of opts.delete || []) {
				await overlay.remove(p);
			}
			for(let spec of opts.add || []) {
				let at = spec.indexOf('=');
				if(at <= 0) {
					throw new UsageError('--add needs local=path, e.g. --add "C:\\new.txt=/C/Users/me/new.txt"');
				}
				await addLocalToOverlay(overlay, spec.slice(0, at), spec.slice(at + 1));
			}

			let started = Date.now();
			let result = await writeSnapshotBackup(overlay, args[1], {
				from: opts.from,
				drive: opts['as-drive'],
				overwrite: opts.overwrite,
				compressionLevel: compressionLevel(opts),
				onProgress: progressPrinter(opts),
			});
			out('Created ' + result.file + ': ' + result.files.toLocaleString('en-US') + ' files, ' + result.folders.toLocaleString('en-US') + ' folders, ' + formatSize(result.bytes) + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
		}
		finally {
			if(tempDir) {
				await fs.promises.rm(tempDir, { recursive: true, force: true });
			}
		}
	});
}

async function cmdExport(args: string[], opts: Options) {
	if(args.length < 3) {
		throw new UsageError('Usage: tib export <backup> <image in the backup> <out.img|out.vhd>');
	}
	await withArchive(args[0], opts, async (archive) => {
		let snapshot = await pickSlice(archive, opts).openFileSystem();
		let last = 0;
		let result = await exportImage(snapshot, args[1], args[2], {
			overwrite: opts.overwrite,
			onProgress: (p) => {
				if(!opts.quiet && Date.now() - last > 2000) {
					last = Date.now();
					err('  ' + formatSize(p.bytes) + ' / ' + formatSize(p.totalBytes));
				}
			}
		});
		out('Exported ' + formatSize(result.bytes) + ' to ' + path.resolve(result.file));
	});
}


function isLoopback(host: string) {
	return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

async function cmdMount(args: string[], opts: Options) {
	if(!args[0]) {
		throw new UsageError('Missing the backup file');
	}

	let archive = await openArchive(args[0], openOptions(opts));
	let stop: () => Promise<void>;

	try {
		let snapshot = await pickSlice(archive, opts).openFileSystem();

		if(opts.fuse && opts.drive) {
			throw new UsageError('Use either --fuse or --drive, not both');
		}
		if(opts.writable) {
			if(opts.fuse) {
				throw new UsageError('--writable works with WebDAV and --drive, not --fuse');
			}
			snapshot = await OverlayFS.open(snapshot, opts.writable);
			out('Changes are kept in ' + path.resolve(opts.writable) + '; the backup itself is not changed.');
		}

		if(opts.fuse) {
			let mount = new FuseMount(snapshot, opts.fuse);
			await mount.mount();
			out('Mounted read-only at ' + path.resolve(opts.fuse) + '. Press Ctrl+C to unmount.');
			stop = () => mount.unmount();
		}
		else if(opts.drive) {
			// rclone talks to our WebDAV server over loopback; any free port will do. Only rclone uses
			// the address, so a random path keeps other programs from reading the backup through it.
			let server = new WebDavServer(snapshot, { basePath: WebDavServer.randomBasePath() });
			let addr = await server.listen(parseIntOption(opts.port, 'port', 0), '127.0.0.1');

			let target = normalizeDriveTarget(opts.drive);
			let drive = new RcloneMount('http://127.0.0.1:' + addr.port + server.basePath, target, archive.name, !!opts.writable);
			try {
				await drive.mount();
			}
			catch(e) {
				await server.close();
				throw e;
			}

			out('Mounted the backup ' + (opts.writable ? 'writable' : 'read-only') + ' as ' + target + '. Press Ctrl+C to unmount.');
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

			out('Serving the backup ' + (opts.writable ? 'writable' : 'read-only') + ' at ' + url);
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
			case 'create': await cmdCreate(args, opts); return 0;
			case 'edit': await cmdEdit(args, opts); return 0;
			case 'export': await cmdExport(args, opts); return 0;
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
