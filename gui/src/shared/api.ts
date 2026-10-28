/**
 * The contract between the app's processes. Plain data only: everything here crosses process
 * boundaries (renderer <-> main <-> engine), so dates are milliseconds since 1970.
 */

export type EntryType = 'file' | 'directory';

/** A file or folder inside one backup point */
export interface Entry {
	name: string;
	/** '/'-separated path inside the backup; '/' is the root */
	path: string;
	type: EntryType;
	/** Bytes; 0 for folders */
	size: number;
	/** Last modified, ms since 1970 */
	mtime: number;
}

/** An entry plus what only some formats store */
export interface EntryDetails extends Entry {
	/** ms since 1970 */
	created?: number;
	/** Windows FILE_ATTRIBUTE_* flags */
	attributes?: number;
}

export interface SliceInfo {
	/** 1 is the oldest */
	number: number;
	id: string;
	/** ISO 8601 */
	created: string;
	incremental: boolean;
	config: {
		machine_id?: string;
		includePaths?: string[];
		excludePaths?: string[];
		productinfo?: { name: string; version: { major: number; minor: number }; build_number: number };
		compression?: string;
		encryption?: string;
	};
}

export interface BackupInfo {
	/** The file that was opened */
	file: string;
	name: string;
	format: 'Windows' | 'Mac';
	volumes: Array<{ file: string; size: number; headerChecksumOk: boolean }>;
	/** Oldest first */
	slices: SliceInfo[];
}

export interface Contents {
	files: number;
	folders: number;
	bytes: number;
}

/**
 * Error codes: the library's (see src/errors.ts) plus 'not-found' (the file is gone), 'io' (couldn't
 * read or write a file), 'engine' (the backup process stopped) and 'internal'
 */
export type ErrorCode =
	'not-a-backup' | 'unexpected-name' | 'missing-part' | 'damaged' | 'encrypted' | 'disk-image' | 'unsupported' |
	'not-found' | 'io' | 'no-space' | 'cancelled' | 'not-allowed' | 'engine' | 'internal';

export interface ErrorInfo {
	code: ErrorCode;
	message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorInfo };


/** What to do when a file already exists at the destination */
export type ConflictPolicy = 'ask' | 'overwrite' | 'skip' | 'rename';
export type ConflictChoice = 'overwrite' | 'skip' | 'rename' | 'abort';

export interface CopyResult {
	files: number;
	folders: number;
	bytes: number;
	skipped: number;
	/** Names changed to be valid on Windows */
	renamed: number;
	/** Where each copied item ended up (same order as the paths asked for) */
	items: string[];
	destination: string;
}

/**
 * What the engine (one process per open backup) can do. Slice numbers are 1-based.
 * Jobs (copy, stage) report progress as events and finish when the request returns.
 */
export interface EngineMethods {
	open(file: string): BackupInfo;
	list(slice: number, path: string): Entry[];
	stat(slice: number, path: string): Entry | null;
	details(slice: number, path: string): EntryDetails | null;
	contents(slice: number): Contents;
	measure(slice: number, paths: string[]): Contents;
	/** Copies items into a folder, each as dest/<name> (folders included) */
	copy(jobId: string, slice: number, paths: string[], dest: string, policy: ConflictPolicy): CopyResult;
	/** Copies items into a new private folder (for opening, the clipboard or dragging) */
	stage(jobId: string, slice: number, paths: string[], dir: string, readOnly: boolean): CopyResult;
	cancel(jobId: string): void;
	answer(jobId: string, conflictId: number, choice: ConflictChoice, applyToAll: boolean): void;
}

/** The engine methods a window may call directly; the rest go through main, which picks destinations */
export const WINDOW_METHODS = ['list', 'stat', 'details', 'contents', 'measure', 'cancel', 'answer'] as const;

export type EngineMethod = keyof EngineMethods;
export type EngineArgs<M extends EngineMethod> = Parameters<EngineMethods[M]>;
export type EngineReturn<M extends EngineMethod> = ReturnType<EngineMethods[M]>;

/** Messages between main and an engine process ('shutdown' closes the backup, then the process exits) */
export type EngineRequest = { type: 'request'; id: number; method: EngineMethod; args: unknown[] } | { type: 'shutdown' };
export type EngineMessage =
	{ type: 'response'; id: number; result: Result<unknown> } |
	{ type: 'event'; event: EngineEvent };

export interface JobProgress {
	jobId: string;
	files: number;
	bytes: number;
	totalFiles: number;
	totalBytes: number;
	/** Backup path being copied */
	path: string;
}

export interface JobConflict {
	jobId: string;
	conflictId: number;
	/** In the backup */
	entry: Entry;
	/** The file that is already there */
	dest: string;
	existing: { size: number; mtime: number } | null;
}

export type EngineEvent =
	{ name: 'warning'; message: string } |
	{ name: 'job-progress'; progress: JobProgress } |
	{ name: 'job-conflict'; conflict: JobConflict };


/** Events main sends to a window */
export type AppEvent =
	{ name: 'warning'; sessionId: string; message: string } |
	{ name: 'session-lost'; sessionId: string; message: string } |
	{ name: 'open-file'; file: string } |
	{ name: 'job-progress'; sessionId: string; progress: JobProgress } |
	{ name: 'job-conflict'; sessionId: string; conflict: JobConflict };


export interface RecentBackup {
	file: string;
	name: string;
	/** ms since 1970 */
	lastOpened: number;
	exists: boolean;
}

export interface AppInfo {
	version: string;
	portable: boolean;
}

export interface Session {
	id: string;
	info: BackupInfo;
}

/**
 * What the preload script gives the renderer, as window.tib
 */
export interface TibBridge {
	appInfo(): Promise<AppInfo>;
	/** Shows the Open dialog; null if cancelled */
	pickBackup(): Promise<string | null>;
	/** The backup this window was opened for (file association, drop, second instance), once */
	takeInitialFile(): Promise<string | null>;
	openBackup(file: string): Promise<Result<Session>>;
	closeBackup(sessionId: string): Promise<void>;
	/** Opens a backup in a new window */
	openInNewWindow(file: string): Promise<void>;
	call<M extends EngineMethod>(sessionId: string, method: M, ...args: EngineArgs<M>): Promise<Result<EngineReturn<M>>>;
	recent(): Promise<RecentBackup[]>;
	forgetRecent(file: string): Promise<void>;
	/** The file system path of a dropped file */
	pathForFile(file: object): string;
	/** Matches the window buttons to the title bar */
	setTitleBarColors(background: string, symbols: string): void;
	onEvent(listener: (event: AppEvent) => void): () => void;

	// Getting files out. Destinations must come from pickFolder.
	/** Shows a folder dialog; null if cancelled */
	pickFolder(purpose: 'copy' | 'restore' | 'edit'): Promise<string | null>;
	copyTo(sessionId: string, jobId: string, slice: number, paths: string[], dest: string, policy: ConflictPolicy): Promise<Result<CopyResult>>;
	/** Opens a read-only temporary copy with its usual app */
	openFile(sessionId: string, jobId: string, slice: number, path: string): Promise<Result<void>>;
	/** Puts temporary copies on the clipboard as files; returns how many */
	copyToClipboard(sessionId: string, jobId: string, slice: number, paths: string[]): Promise<Result<number>>;
	/** Starts dragging the items out of the window ('too-big' for large selections) */
	dragOut(sessionId: string, slice: number, paths: string[]): Promise<Result<'started' | 'too-big'>>;
	/** Opens a file or folder TibReader wrote */
	openPath(path: string): Promise<Result<void>>;
	showInFolder(path: string): Promise<void>;
	/** Free bytes on the drive of a picked folder, or null if unknown */
	freeSpace(folder: string): Promise<number | null>;
}
