import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FsEntry, SnapshotFS } from '../fs/types';
import { extractItems, measure } from '../fs/extract';
import { describeArchive } from '../info';
import { verifyHeaders, verifySnapshot } from '../verify';
import { OverlayFS } from '../write/overlay';
import { refuseToReplaceBackupFiles, writeSnapshotBackup } from '../write/sources';
import { formatSize } from '../format';
import { BackupPointView, BackupSession } from './session';


interface PropertySchema {
	type: 'string' | 'integer' | 'boolean' | 'array';
	description: string;
	enum?: string[];
	items?: { type: 'string' };
	minItems?: number;
	minimum?: number;
	maximum?: number;
	default?: unknown;
}

export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: { type: 'object'; properties: { [name: string]: PropertySchema }; required: string[]; additionalProperties: false };
	/** Creates files on this computer (never changes a backup) */
	writesFiles?: boolean;
	run(args: any, session: BackupSession): Promise<object>;
}

function tool(t: Omit<ToolDefinition, 'inputSchema'> & { properties: { [name: string]: PropertySchema }; required?: string[] }): ToolDefinition {
	let { properties, required, ...rest } = t;
	return { ...rest, inputSchema: { type: 'object', properties, required: required || [], additionalProperties: false } };
}

/**
 * Checks tool arguments against the tool's input schema (types, required, enums, ranges, unknown names)
 */
export function checkArguments(t: ToolDefinition, args: any) {
	if(!args || typeof args !== 'object' || Array.isArray(args)) {
		throw new Error('Arguments must be an object');
	}

	let { properties, required } = t.inputSchema;
	for(let name of Object.keys(args)) {
		if(!properties[name]) {
			throw new Error('Unknown argument "' + name + '"; ' + t.name + ' takes: ' + Object.keys(properties).join(', '));
		}
	}
	for(let name of required) {
		if(args[name] === undefined) {
			throw new Error('Missing argument "' + name + '"');
		}
	}

	for(let [ name, schema ] of Object.entries(properties)) {
		let v = args[name];
		if(v === undefined) {
			continue;
		}
		let ok = schema.type === 'integer' ? Number.isSafeInteger(v)
			: schema.type === 'array' ? Array.isArray(v) && v.every((x) => typeof x === 'string')
			: typeof v === schema.type;
		if(!ok) {
			throw new Error('"' + name + '" must be ' + (schema.type === 'array' ? 'a list of strings' : schema.type === 'integer' ? 'a whole number' : 'a ' + schema.type));
		}
		if(schema.enum && !schema.enum.includes(v)) {
			throw new Error('"' + name + '" must be one of: ' + schema.enum.join(', '));
		}
		if(schema.minimum !== undefined && v < schema.minimum) {
			throw new Error('"' + name + '" must be at least ' + schema.minimum);
		}
		if(schema.maximum !== undefined && v > schema.maximum) {
			throw new Error('"' + name + '" must be at most ' + schema.maximum);
		}
		if(schema.minItems !== undefined && v.length < schema.minItems) {
			throw new Error('"' + name + '" needs at least ' + schema.minItems + ' item(s)');
		}
	}
}


// Arguments shared by most tools

const backup_file: PropertySchema = {
	type: 'string',
	description: 'Path on this computer of any file of the backup: NAME_full_b1_s1_v1.tib (Windows), NAME.tib (Mac) or NAME.tibx',
};
const backup_point: PropertySchema = {
	type: 'integer',
	description: 'Backup point (version) to use: 1 is the oldest, -1 the newest, -2 the one before it',
	default: -1,
};
const password: PropertySchema = {
	type: 'string',
	description: 'Password of an encrypted .tibx backup (default: the TIB_PASSWORD environment variable)',
};
const folder_path: PropertySchema = {
	type: 'string',
	description: 'Folder inside the backup, e.g. "/C/Users" (default "/", everything)',
	default: '/',
};
const BACKUP_ARGUMENTS = { backup_file, backup_point, password };

function maxCount(what: string, fallback: number): PropertySchema {
	return { type: 'integer', description: 'Most ' + what + ' to return (default ' + fallback + ')', minimum: 1, default: fallback };
}


// Helpers

function sized(bytes: number) {
	return { bytes, size: formatSize(bytes) };
}

function entryRow(e: FsEntry) {
	return e.type === 'directory'
		? { path: e.path, type: 'folder', modified: e.mtime.toISOString() }
		: { path: e.path, type: 'file', ...sized(e.size), modified: e.mtime.toISOString() };
}

function openBackupPoint(session: BackupSession, args: any): Promise<BackupPointView> {
	return session.backupPoint(args.backup_file, args.backup_point ?? -1, args.password);
}

async function folderIn(view: BackupPointView, folderPath: string = '/'): Promise<FsEntry> {
	let folder = await view.fileSystem.stat(folderPath);
	if(!folder) {
		throw new Error('No such folder in backup point #' + view.backupPointNumber + ': ' + folderPath);
	}
	if(folder.type !== 'directory') {
		throw new Error('Not a folder: ' + folderPath);
	}
	return folder;
}

/** Everything below a folder (not the folder itself) */
async function entriesBelow(view: BackupPointView, folder: FsEntry): Promise<FsEntry[]> {
	let prefix = folder.path === '/' ? '/' : folder.path + '/';
	return (await view.allEntries()).filter((e) => e.path.startsWith(prefix) && e.path !== folder.path);
}

/** Path below 'folder', e.g. "/C/Users/me" below "/C" -> "Users/me" */
function relativePath(e: FsEntry, folder: FsEntry): string {
	return e.path.slice(folder.path === '/' ? 1 : folder.path.length + 1);
}

function extensionOf(name: string): string {
	let dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot).toLowerCase() : '(none)';
}

/** "*.jp?g" -> a case-insensitive regular expression for whole names */
function globToRegExp(glob: string): RegExp {
	let source = glob.split('').map((c) => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$.|+()[\]{}]/g, '\\$&')).join('');
	return new RegExp('^' + source + '$', 'is');
}

function parseDate(value: string | undefined, name: string): number | undefined {
	if(value === undefined) {
		return undefined;
	}
	let t = Date.parse(value);
	if(Number.isNaN(t)) {
		throw new Error('"' + name + '" is not a date (use e.g. 2024-05-31 or 2024-05-31T12:00:00Z)');
	}
	return t;
}

const READ_CHUNK = 4 * 1024 * 1024;

/** SHA-256 of [offset, offset + length) of a file in a backup */
async function hashPart(fileSystem: SnapshotFS, filePath: string, offset: number, length: number): Promise<string> {
	let hash = crypto.createHash('sha256');
	for(let at = offset; at < offset + length; at += READ_CHUNK) {
		hash.update(await fileSystem.read(filePath, at, Math.min(READ_CHUNK, offset + length - at)));
	}
	return hash.digest('hex');
}

/** SHA-256 of a file on this computer, or of its first and last MiB only */
async function hashLocalFile(file: string, size: number, wholeFile: boolean): Promise<string> {
	let hash = crypto.createHash('sha256');
	if(wholeFile) {
		for await (let chunk of fs.createReadStream(file)) {
			hash.update(chunk as Buffer);
		}
		return hash.digest('hex');
	}

	const EDGE = 1024 * 1024;
	let fh = await fs.promises.open(file, 'r');
	try {
		for(let offset of size > 2 * EDGE ? [ 0, size - EDGE ] : [ 0 ]) {
			let buf = Buffer.alloc(Math.min(size, size > 2 * EDGE ? EDGE : size));
			let { bytesRead } = await fh.read(buf, 0, buf.length, offset);
			hash.update(buf.subarray(0, bytesRead));
		}
	}
	finally {
		await fh.close();
	}
	return hash.digest('hex');
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
	let groups = new Map<string, T[]>();
	for(let item of items) {
		let key = keyOf(item);
		let group = groups.get(key);
		if(group) {
			group.push(item);
		}
		else {
			groups.set(key, [ item ]);
		}
	}
	return groups;
}


// Backup files on this computer

const BACKUP_FILE_NAME = /\.(tib|tibx|tib\.metadata)$/i;
/** NAME_full_b1_s1_v1.tib: the backup name and its number (b1) */
const WINDOWS_VOLUME_NAME = /^(.*)_(full|inc|diff)_b(\d+)_s(\d+)_v(\d+)\.tib$/i;

interface FoundFile {
	file: string;
	size: number;
	modified: Date;
}

async function findBackupFiles(folder: string, searchSubfolders: boolean, unreadable: string[]): Promise<FoundFile[]> {
	let found: FoundFile[] = [];
	let stack = [ folder ];
	while(stack.length) {
		let dir = stack.pop()!;
		let items: fs.Dirent[];
		try {
			items = await fs.promises.readdir(dir, { withFileTypes: true });
		}
		catch(e: any) {
			unreadable.push(dir + ' (' + e.code + ')');
			continue;
		}
		for(let item of items) {
			let full = path.join(dir, item.name);
			if(item.isDirectory() && searchSubfolders) {
				stack.push(full);
			}
			else if(item.isFile() && BACKUP_FILE_NAME.test(item.name)) {
				let st = await fs.promises.stat(full);
				found.push({ file: full, size: st.size, modified: st.mtime });
			}
		}
	}
	return found;
}

const findBackupsInFolder = tool({
	name: 'find_backups_in_folder',
	title: 'Find backups in a folder',
	description: 'Finds Acronis backup files (.tib, .tibx, .tib.metadata) in a folder on this computer and groups ' +
		'them into backups (a Windows backup is several NAME_full_b1_s1_v1.tib / NAME_inc_b1_s2_v1.tib files). ' +
		'Reports each backup\'s files, total size and dates, largest first, and files that look like identical ' +
		'copies of each other. Doesn\'t open the backups; use describe_backup for what is inside.',
	properties: {
		folder_path: { type: 'string', description: 'Folder on this computer to search' },
		search_subfolders: { type: 'boolean', description: 'Also search every folder below it (default true)', default: true },
		look_for_identical_copies: {
			type: 'boolean',
			description: 'Compare files of the same size by their first and last MiB (default true)',
			default: true,
		},
		confirm_identical_with_full_hash: {
			type: 'boolean',
			description: 'Read same-sized files completely (SHA-256) to confirm they are identical; slow for big files (default false)',
			default: false,
		},
	},
	required: [ 'folder_path' ],
	async run(args) {
		let folder = path.resolve(args.folder_path);
		let st = await fs.promises.stat(folder).catch(() => null);
		if(!st || !st.isDirectory()) {
			throw new Error('No such folder: ' + folder);
		}

		let unreadable: string[] = [];
		let files = await findBackupFiles(folder, args.search_subfolders !== false, unreadable);

		let groups = groupBy(files, (f) => {
			let name = path.basename(f.file);
			let m = WINDOWS_VOLUME_NAME.exec(name);
			let base = m ? m[1] + '_b' + m[3] : name.replace(BACKUP_FILE_NAME, '');
			return path.join(path.dirname(f.file), base);
		});

		let backups = Array.from(groups.values()).map((group) => {
			group.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
			let m = WINDOWS_VOLUME_NAME.exec(path.basename(group[0].file));
			let total = group.reduce((s, f) => s + f.size, 0);
			let times = group.map((f) => f.modified.getTime());
			// Any file opens the backup; prefer the first full backup's first file, or the .tib/.tibx itself
			let openWith = group.find((f) => /_full_b\d+_s\d+_v1\.tib$/i.test(f.file)) || group.find((f) => !/\.metadata$/i.test(f.file)) || group[0];
			return {
				backup_name: m ? m[1] : path.basename(group[0].file).replace(BACKUP_FILE_NAME, ''),
				folder: path.dirname(group[0].file),
				backup_file_to_open: openWith.file,
				total: sized(total),
				oldest_file_modified: new Date(Math.min(...times)).toISOString(),
				newest_file_modified: new Date(Math.max(...times)).toISOString(),
				files: group.map((f) => ({ name: path.basename(f.file), ...sized(f.size), modified: f.modified.toISOString() })),
			};
		}).sort((a, b) => b.total.bytes - a.total.bytes);

		let identical: object[] = [];
		if(args.look_for_identical_copies !== false) {
			let fullHash = !!args.confirm_identical_with_full_hash;
			for(let sameSize of groupBy(files.filter((f) => f.size > 0), (f) => String(f.size)).values()) {
				if(sameSize.length < 2) {
					continue;
				}
				let fingerprints = new Map<FoundFile, string>();
				for(let f of sameSize) {
					fingerprints.set(f, await hashLocalFile(f.file, f.size, fullHash));
				}
				for(let copies of groupBy(sameSize, (f) => fingerprints.get(f)!).values()) {
					if(copies.length > 1) {
						identical.push({
							each: sized(copies[0].size),
							files: copies.map((f) => f.file),
							compared: fullHash ? 'whole files (SHA-256)' : 'size and first and last MiB only; confirm before deleting',
						});
					}
				}
			}
		}

		return {
			folder,
			backups_found: backups.length,
			total: sized(files.reduce((s, f) => s + f.size, 0)),
			backups,
			identical_copies: identical,
			unreadable_folders: unreadable,
		};
	},
});


// Looking inside a backup

const describeBackup = tool({
	name: 'describe_backup',
	title: 'Describe a backup',
	description: 'Shows what a backup is: its format, the files it is stored in, and each backup point ' +
		'(number, date, full or incremental, files or disk image, settings, and how many files and bytes it holds).',
	properties: {
		backup_file,
		password,
		count_contents: {
			type: 'boolean',
			description: 'Count each backup point\'s files, folders and bytes (default true; reads every backup point\'s file list)',
			default: true,
		},
	},
	required: [ 'backup_file' ],
	async run(args, session) {
		let archive = await session.archive(args.backup_file, args.password);
		let info = await describeArchive(archive, {
			contents: args.count_contents !== false,
			openFileSystem: (slice) => session.fileSystemOf(slice),
		});
		let { volumes, slices, ...rest } = info;
		return {
			...rest,
			stored_in: sized(volumes.reduce((s, v) => s + v.size, 0)),
			files: volumes.map((v) => ({ file: v.file, ...sized(v.size), header_checksum_ok: v.headerChecksumOk })),
			backup_points: slices.map((s) => ({ ...s, contents: s.contents && { ...s.contents, size: formatSize(s.contents.bytes) } })),
		};
	},
});

const listFolder = tool({
	name: 'list_folder',
	title: 'List a folder in a backup',
	description: 'Lists the files and folders in a folder of a backup point, with sizes and modified times.',
	properties: {
		...BACKUP_ARGUMENTS,
		folder_path,
		recursive: { type: 'boolean', description: 'List everything below the folder (default false)', default: false },
		max_entries: maxCount('entries', 500),
	},
	required: [ 'backup_file' ],
	async run(args, session) {
		let view = await openBackupPoint(session, args);
		let target = await view.fileSystem.stat(args.folder_path ?? '/');
		if(!target) {
			throw new Error('No such file or folder in backup point #' + view.backupPointNumber + ': ' + args.folder_path);
		}

		let entries = target.type !== 'directory' ? [ target ]
			: args.recursive ? await entriesBelow(view, target)
			: (await view.fileSystem.list(target.path))!;
		let max = args.max_entries ?? 500;

		return {
			backup_point: view.backupPointNumber,
			folder: target.path,
			total_entries: entries.length,
			truncated: entries.length > max,
			entries: entries.slice(0, max).map(entryRow),
		};
	},
});

const summarizeFolderSizes = tool({
	name: 'summarize_folder_sizes',
	title: 'Summarize folder sizes',
	description: 'Shows where the space goes in a backup point: the total size of each folder and file below a ' +
		'folder (down to "depth" levels), largest first, and the bytes per file extension. Use it to find what ' +
		'takes up the most space.',
	properties: {
		...BACKUP_ARGUMENTS,
		folder_path,
		depth: { type: 'integer', description: 'How many folder levels to break down (default 1: the folder\'s direct children)', minimum: 1, default: 1 },
		max_entries: maxCount('folders and files', 50),
		max_extensions: maxCount('file extensions', 20),
	},
	required: [ 'backup_file' ],
	async run(args, session) {
		let view = await openBackupPoint(session, args);
		let folder = await folderIn(view, args.folder_path);
		let depth = args.depth ?? 1;
		let below = await entriesBelow(view, folder);

		let rows = new Map<string, { path: string; type: string; bytes: number; files: number }>();
		let extensions = new Map<string, { extension: string; bytes: number; files: number }>();
		let total = { bytes: 0, files: 0, folders: 0 };

		for(let e of below) {
			let parts = relativePath(e, folder).split('/');
			if(e.type === 'directory') {
				total.folders++;
				// Folders above 'depth' are broken down into their children
				if(parts.length < depth) {
					continue;
				}
			}

			let key = (folder.path === '/' ? '' : folder.path) + '/' + parts.slice(0, depth).join('/');
			let row = rows.get(key);
			if(!row) {
				let isFolder = parts.length > depth || e.type === 'directory';
				row = { path: key, type: isFolder ? 'folder' : 'file', bytes: 0, files: 0 };
				rows.set(key, row);
			}
			if(e.type === 'directory') {
				continue;
			}
			row.bytes += e.size;
			row.files++;
			total.bytes += e.size;
			total.files++;

			let ext = extensionOf(e.name);
			let x = extensions.get(ext) || { extension: ext, bytes: 0, files: 0 };
			x.bytes += e.size;
			x.files++;
			extensions.set(ext, x);
		}

		let sorted = Array.from(rows.values()).sort((a, b) => b.bytes - a.bytes);
		let max = args.max_entries ?? 50;
		return {
			backup_point: view.backupPointNumber,
			folder: folder.path,
			total: { ...sized(total.bytes), files: total.files, folders: total.folders },
			entries: sorted.slice(0, max).map((r) => ({ ...r, size: formatSize(r.bytes) })),
			entries_not_shown: Math.max(0, sorted.length - max),
			by_extension: Array.from(extensions.values()).sort((a, b) => b.bytes - a.bytes)
				.slice(0, args.max_extensions ?? 20).map((x) => ({ ...x, size: formatSize(x.bytes) })),
		};
	},
});

const findFiles = tool({
	name: 'find_files',
	title: 'Find files in a backup',
	description: 'Finds files in a backup point by name, extension, size or modified date. Sorted largest first ' +
		'by default, so with no filters it lists the largest files.',
	properties: {
		...BACKUP_ARGUMENTS,
		folder_path,
		name_pattern: { type: 'string', description: 'File name pattern, case-insensitive: * any characters, ? one character (e.g. "*.iso", "IMG_????.JPG")' },
		extensions: { type: 'array', items: { type: 'string' }, description: 'Only these extensions, e.g. ["mp4", ".mkv"]' },
		min_size_bytes: { type: 'integer', description: 'Only files at least this big', minimum: 0 },
		max_size_bytes: { type: 'integer', description: 'Only files at most this big', minimum: 0 },
		modified_after: { type: 'string', description: 'Only files modified after this date (ISO 8601, e.g. 2023-01-01)' },
		modified_before: { type: 'string', description: 'Only files modified before this date (ISO 8601)' },
		sort_by: { type: 'string', enum: [ 'size', 'modified', 'path' ], description: 'size (largest first, default), modified (newest first) or path', default: 'size' },
		max_results: maxCount('files', 100),
	},
	required: [ 'backup_file' ],
	async run(args, session) {
		let view = await openBackupPoint(session, args);
		let folder = await folderIn(view, args.folder_path);
		let name = args.name_pattern !== undefined ? globToRegExp(args.name_pattern) : undefined;
		let extensions = args.extensions && new Set((args.extensions as string[]).map((x) => '.' + x.replace(/^\./, '').toLowerCase()));
		let after = parseDate(args.modified_after, 'modified_after');
		let before = parseDate(args.modified_before, 'modified_before');

		let matches = (await entriesBelow(view, folder)).filter((e) => e.type === 'file' &&
			(!name || name.test(e.name)) &&
			(!extensions || extensions.has(extensionOf(e.name))) &&
			(args.min_size_bytes === undefined || e.size >= args.min_size_bytes) &&
			(args.max_size_bytes === undefined || e.size <= args.max_size_bytes) &&
			(after === undefined || e.mtime.getTime() > after) &&
			(before === undefined || e.mtime.getTime() < before));

		let sortBy = args.sort_by ?? 'size';
		matches.sort(sortBy === 'size' ? (a, b) => b.size - a.size
			: sortBy === 'modified' ? (a, b) => b.mtime.getTime() - a.mtime.getTime()
			: (a, b) => a.path.localeCompare(b.path));

		let max = args.max_results ?? 100;
		return {
			backup_point: view.backupPointNumber,
			matching_files: matches.length,
			matching_total: sized(matches.reduce((s, e) => s + e.size, 0)),
			truncated: matches.length > max,
			files: matches.slice(0, max).map(entryRow),
		};
	},
});

const findDuplicateFiles = tool({
	name: 'find_duplicate_files',
	title: 'Find duplicate files in a backup',
	description: 'Finds files stored more than once in a backup point, and how much space the extra copies take ' +
		'(wasted bytes), most wasteful first. match_by "content" compares file contents (SHA-256, only for ' +
		'files of equal size); "name_and_size" only compares names and sizes, which is fast but can be wrong.',
	properties: {
		...BACKUP_ARGUMENTS,
		folder_path,
		match_by: { type: 'string', enum: [ 'content', 'name_and_size' ], description: 'content (default) or name_and_size', default: 'content' },
		min_size_bytes: { type: 'integer', description: 'Ignore files smaller than this (default 1: skip empty files)', minimum: 0, default: 1 },
		max_bytes_to_hash: {
			type: 'integer',
			description: 'Stop comparing contents after reading this many bytes (default 10 GiB); the result says if it stopped early',
			minimum: 0,
			default: 10 * 1024 * 1024 * 1024,
		},
		max_groups: maxCount('groups of duplicates', 50),
	},
	required: [ 'backup_file' ],
	async run(args, session) {
		let view = await openBackupPoint(session, args);
		let folder = await folderIn(view, args.folder_path);
		let minSize = args.min_size_bytes ?? 1;
		let files = (await entriesBelow(view, folder)).filter((e) => e.type === 'file' && e.size >= minSize);

		let duplicates: FsEntry[][] = [];
		let budget = args.max_bytes_to_hash ?? 10 * 1024 * 1024 * 1024;
		let bytesHashed = 0;
		let stoppedEarly = false;
		let groupsNotChecked = 0;

		if(args.match_by === 'name_and_size') {
			duplicates = Array.from(groupBy(files, (e) => e.name.toLowerCase() + '\0' + e.size).values()).filter((g) => g.length > 1);
		}
		else {
			// Biggest possible waste first, so a limited budget is spent where it matters
			let candidates = Array.from(groupBy(files, (e) => String(e.size)).values()).filter((g) => g.length > 1)
				.sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));

			const HEAD = 64 * 1024;
			for(let sameSize of candidates) {
				let size = sameSize[0].size;
				let cost = sameSize.length * (size > HEAD ? Math.min(size, HEAD) + size : size);
				if(bytesHashed + cost > budget) {
					stoppedEarly = true;
					groupsNotChecked++;
					continue;
				}

				// The first 64 KiB rule out most files cheaply; only matching ones are read completely
				let heads = new Map<FsEntry, string>();
				for(let e of sameSize) {
					heads.set(e, await hashPart(view.fileSystem, e.path, 0, Math.min(size, HEAD)));
					bytesHashed += Math.min(size, HEAD);
				}
				for(let sameHead of groupBy(sameSize, (e) => heads.get(e)!).values()) {
					if(sameHead.length < 2) {
						continue;
					}
					if(size <= HEAD) {
						duplicates.push(sameHead);
						continue;
					}
					let full = new Map<FsEntry, string>();
					for(let e of sameHead) {
						full.set(e, await hashPart(view.fileSystem, e.path, 0, size));
						bytesHashed += size;
					}
					duplicates.push(...Array.from(groupBy(sameHead, (e) => full.get(e)!).values()).filter((g) => g.length > 1));
				}
			}
		}

		let groups = duplicates.map((g) => ({
			each: sized(g[0].size),
			copies: g.length,
			wasted: sized(g[0].size * (g.length - 1)),
			paths: g.map((e) => e.path).sort(),
		})).sort((a, b) => b.wasted.bytes - a.wasted.bytes);
		let max = args.max_groups ?? 50;

		return {
			backup_point: view.backupPointNumber,
			matched_by: args.match_by ?? 'content',
			duplicate_groups: groups.length,
			total_wasted: sized(groups.reduce((s, g) => s + g.wasted.bytes, 0)),
			groups: groups.slice(0, max),
			groups_not_shown: Math.max(0, groups.length - max),
			...(args.match_by === 'name_and_size' ? {} : { bytes_read: bytesHashed, stopped_early: stoppedEarly, size_groups_not_checked: groupsNotChecked }),
		};
	},
});

const readFileText = tool({
	name: 'read_file_text',
	title: 'Read a file in a backup',
	description: 'Reads part of a file in a backup point as text (UTF-8, or UTF-16 with a byte order mark), to see ' +
		'what it is. Binary files get a hex preview of their first bytes instead.',
	properties: {
		...BACKUP_ARGUMENTS,
		file_path: { type: 'string', description: 'File inside the backup, e.g. "/C/Users/me/notes.txt"' },
		offset: { type: 'integer', description: 'Byte to start at (default 0)', minimum: 0, default: 0 },
		max_bytes: { type: 'integer', description: 'Most bytes to read (default 65536, at most 1048576)', minimum: 1, maximum: 1024 * 1024, default: 64 * 1024 },
	},
	required: [ 'backup_file', 'file_path' ],
	async run(args, session) {
		let view = await openBackupPoint(session, args);
		let e = await view.fileSystem.stat(args.file_path);
		if(!e) {
			throw new Error('No such file in backup point #' + view.backupPointNumber + ': ' + args.file_path);
		}
		if(e.type !== 'file') {
			throw new Error('Not a file (use list_folder for folders): ' + args.file_path);
		}

		let offset = args.offset ?? 0;
		let data = await view.fileSystem.read(e.path, offset, args.max_bytes ?? 64 * 1024);
		let head = { path: e.path, ...sized(e.size), offset, bytes_read: data.length, more_after: offset + data.length < e.size };

		// The byte order mark is only at the start of the file, so look there for it
		let start = offset === 0 ? data : await view.fileSystem.read(e.path, 0, 3);
		let encoding: BufferEncoding | 'utf16be' = 'utf8';
		let bomLength = 0;
		if(start[0] === 0xEF && start[1] === 0xBB && start[2] === 0xBF) {
			bomLength = 3;
		}
		else if(start[0] === 0xFF && start[1] === 0xFE) {
			encoding = 'utf16le';
			bomLength = 2;
		}
		else if(start[0] === 0xFE && start[1] === 0xFF) {
			encoding = 'utf16be';
			bomLength = 2;
		}

		let body = offset === 0 ? data.subarray(bomLength) : data;
		if(encoding === 'utf16be') {
			body = Buffer.from(body.subarray(0, body.length & ~1)).swap16();
		}
		let text = body.toString(encoding === 'utf16be' ? 'utf16le' : encoding);

		// Text has no NUL characters and few invalid sequences
		let suspicious = (text.match(/[\u0000�]/g) || []).length;
		if(suspicious > text.length / 100 + 1) {
			let preview = data.subarray(0, 512);
			return { ...head, binary: true, hex_preview: preview.toString('hex').replace(/(.{32})/g, '$1\n').trim() };
		}

		return { ...head, encoding: encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be', text };
	},
});

const compareBackupPoints = tool({
	name: 'compare_backup_points',
	title: 'Compare backup points',
	description: 'Shows which files were added, removed or changed (size or modified time) between two backup ' +
		'points of a backup, or between backup points of two different backups. Use it to see what an ' +
		'incremental backup holds, or whether one backup has everything another has.',
	properties: {
		backup_file,
		password,
		older_backup_point: { type: 'integer', description: 'Backup point to compare from (default -2, or -1 when comparing with another backup file)' },
		newer_backup_point: { type: 'integer', description: 'Backup point to compare to (default -1, the newest)', default: -1 },
		newer_backup_file: { type: 'string', description: 'Compare with a backup point of this other backup (default: the same backup)' },
		newer_password: { type: 'string', description: 'Password of newer_backup_file, if different' },
		folder_path,
		max_entries: maxCount('files per list (added, removed, changed)', 100),
	},
	required: [ 'backup_file' ],
	async run(args, session) {
		let older = await session.backupPoint(args.backup_file, args.older_backup_point ?? (args.newer_backup_file ? -1 : -2), args.password);
		let newer = await session.backupPoint(args.newer_backup_file ?? args.backup_file, args.newer_backup_point ?? -1, args.newer_password ?? args.password);

		let filesOf = async (view: BackupPointView) => {
			let folder = await folderIn(view, args.folder_path);
			let files = (await entriesBelow(view, folder)).filter((e) => e.type === 'file');
			// Windows and Mac names are case-insensitive
			return new Map(files.map((e) => [ relativePath(e, folder).toLowerCase(), e ]));
		};
		let a = await filesOf(older);
		let b = await filesOf(newer);

		let added = Array.from(b.entries()).filter(([ k ]) => !a.has(k)).map(([ , e ]) => e);
		let removed = Array.from(a.entries()).filter(([ k ]) => !b.has(k)).map(([ , e ]) => e);
		let changed = Array.from(b.entries()).filter(([ k, e ]) => {
			let o = a.get(k);
			return o && (o.size !== e.size || o.mtime.getTime() !== e.mtime.getTime());
		}).map(([ k, e ]) => ({ older: a.get(k)!, newer: e }));

		let total = (list: FsEntry[]) => sized(list.reduce((s, e) => s + e.size, 0));
		let max = args.max_entries ?? 100;
		let bySize = (list: FsEntry[]) => list.sort((x, y) => y.size - x.size).slice(0, max).map(entryRow);

		return {
			older: { backup_file: older.archive.volumes[0]?.fileName, backup_point: older.backupPointNumber, created: older.slice.creationTime.toISOString() },
			newer: { backup_file: newer.archive.volumes[0]?.fileName, backup_point: newer.backupPointNumber, created: newer.slice.creationTime.toISOString() },
			summary: {
				added_files: added.length, added: total(added),
				removed_files: removed.length, removed: total(removed),
				changed_files: changed.length,
				unchanged_files: b.size - added.length - changed.length,
			},
			added: bySize(added),
			removed: bySize(removed),
			changed: changed.sort((x, y) => y.newer.size - x.newer.size).slice(0, max).map((c) => ({
				path: c.newer.path,
				older_bytes: c.older.size, newer_bytes: c.newer.size,
				older_modified: c.older.mtime.toISOString(), newer_modified: c.newer.mtime.toISOString(),
			})),
			lists_truncated: Math.max(added.length, removed.length, changed.length) > max,
		};
	},
});

const verifyBackup = tool({
	name: 'verify_backup',
	title: 'Verify a backup',
	description: 'Checks that a backup can be read. By default reads every file of every backup point and checks ' +
		'its data (checksums where the format has them); this reads the whole backup and can take long. ' +
		'quick only checks the structure and file lists.',
	properties: {
		backup_file,
		password,
		backup_point: { type: 'integer', description: 'Only check this backup point (default: all of them)' },
		quick: { type: 'boolean', description: 'Only check headers and file lists, not the data (default false)', default: false },
		max_problems: maxCount('problems per backup point', 50),
	},
	required: [ 'backup_file' ],
	async run(args, session) {
		let archive = await session.archive(args.backup_file, args.password);
		let numbers = args.backup_point !== undefined ? [ args.backup_point ] : archive.slices.map((_, i) => i + 1);
		let headerProblems = verifyHeaders(archive);
		let max = args.max_problems ?? 50;
		let problemCount = headerProblems.length;

		let points = [];
		for(let n of numbers) {
			let view = await session.backupPoint(args.backup_file, n, args.password);
			let totals = await measure(view.fileSystem);
			if(args.quick) {
				points.push({ backup_point: view.backupPointNumber, files: totals.files, ...sized(totals.bytes) });
				continue;
			}
			let result = await verifySnapshot(view.fileSystem, { totals });
			problemCount += result.problems.length;
			points.push({
				backup_point: view.backupPointNumber,
				files_checked: result.files,
				...sized(result.bytes),
				problems: result.problems.slice(0, max),
				problems_not_shown: Math.max(0, result.problems.length - max),
				files_without_stored_data: result.unstored,
			});
		}

		return {
			ok: problemCount === 0,
			checked: args.quick ? 'structure only' : 'every file\'s data',
			header_problems: headerProblems,
			backup_points: points,
		};
	},
});


// Writing new files

const extractFiles = tool({
	name: 'extract_files',
	title: 'Extract files from a backup',
	description: 'Copies files and folders out of a backup point into a folder on this computer (each one as ' +
		'destination_folder/<its name>), keeping modified times. The backup is only read. Ask the user first.',
	writesFiles: true,
	properties: {
		...BACKUP_ARGUMENTS,
		paths_in_backup: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Files and folders to copy, e.g. ["/C/Users/me/Documents"]' },
		destination_folder: { type: 'string', description: 'Folder on this computer to copy into (created if missing)' },
		if_file_exists: {
			type: 'string',
			enum: [ 'fail', 'skip', 'rename', 'overwrite' ],
			description: 'When a file already exists: fail (default), skip it, rename the new one ("name (2).txt") or overwrite it',
			default: 'fail',
		},
	},
	required: [ 'backup_file', 'paths_in_backup', 'destination_folder' ],
	async run(args, session) {
		let view = await openBackupPoint(session, args);
		let destination = path.resolve(args.destination_folder);
		let renamed: string[] = [];
		let result = await extractItems(view.fileSystem, args.paths_in_backup, destination, {
			conflict: args.if_file_exists ?? 'fail',
			onRenamed: (e, safeName) => renamed.push(e.path + ' -> ' + safeName),
		});
		return {
			backup_point: view.backupPointNumber,
			destination_folder: destination,
			files_written: result.files,
			folders_written: result.directories,
			...sized(result.bytes),
			files_skipped: result.skipped,
			names_changed_for_this_os: renamed,
		};
	},
});

const writeCleanedCopyOfBackup = tool({
	name: 'write_cleaned_copy_of_backup',
	title: 'Write a cleaned-up copy of a backup',
	description: 'Writes a NEW backup file holding one backup point without the given files and folders (e.g. ' +
		'duplicates or files not worth keeping). The original backup is not changed; deleting it afterwards is ' +
		'up to the user. The new file is a single full Windows-format .tib that this tool reads; whether ' +
		'Acronis True Image accepts it is not known. Ask the user first.',
	writesFiles: true,
	properties: {
		...BACKUP_ARGUMENTS,
		paths_to_leave_out: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Files and folders inside the backup to leave out' },
		new_backup_file: { type: 'string', description: 'Path of the new backup; "_full_b1_s1_v1.tib" is added unless it already ends like that. Never replaces an existing file.' },
		only_folder: { type: 'string', description: 'Only copy this folder of the backup point, e.g. "/Volume (Windows)" in a disk image (default: everything)' },
		compression_level: { type: 'integer', description: 'zlib level 0-9 (default 6)', minimum: 0, maximum: 9 },
	},
	required: [ 'backup_file', 'paths_to_leave_out', 'new_backup_file' ],
	async run(args, session) {
		let view = await openBackupPoint(session, args);
		await refuseToReplaceBackupFiles(view.archive, args.new_backup_file);

		let tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tib-mcp-'));
		try {
			let overlay = await OverlayFS.open(view.fileSystem, tempDir);
			let leftOut = [];
			for(let p of args.paths_to_leave_out as string[]) {
				let e = await view.fileSystem.stat(p);
				if(!e) {
					throw new Error('No such file or folder in backup point #' + view.backupPointNumber + ': ' + p);
				}
				let m = await measure(view.fileSystem, [ e.path ]);
				leftOut.push({ path: e.path, files: m.files, ...sized(m.bytes) });
				await overlay.remove(e.path);
			}

			let result = await writeSnapshotBackup(overlay, args.new_backup_file, {
				from: args.only_folder,
				compressionLevel: args.compression_level,
			});
			let onDisk = (await fs.promises.stat(result.file)).size;
			return {
				new_backup_file: path.resolve(result.file),
				from_backup_point: view.backupPointNumber,
				files: result.files,
				folders: result.folders,
				data: sized(result.bytes),
				file_size: sized(onDisk),
				left_out: leftOut,
				left_out_total: sized(leftOut.reduce((s, x) => s + x.bytes, 0)),
				note: 'The original backup was not changed. Check the new one (verify_backup, compare_backup_points) before deleting anything.',
			};
		}
		finally {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	},
});


export const TOOLS: ToolDefinition[] = [
	findBackupsInFolder,
	describeBackup,
	listFolder,
	summarizeFolderSizes,
	findFiles,
	findDuplicateFiles,
	readFileText,
	compareBackupPoints,
	verifyBackup,
	extractFiles,
	writeCleanedCopyOfBackup,
];
