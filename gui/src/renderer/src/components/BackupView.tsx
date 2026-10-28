import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	Breadcrumb, BreadcrumbButton, BreadcrumbDivider, BreadcrumbItem, Button, Caption1, Dialog, DialogActions, DialogBody,
	DialogContent, DialogSurface, DialogTitle, Dropdown, Link, makeStyles, Menu, MenuDivider, MenuItem, MenuList, MenuPopover,
	MessageBar, MessageBarBody, Option, Toast, Toaster, ToastBody, ToastTitle, Toolbar, ToolbarButton, ToolbarDivider, tokens,
	Tooltip, useId, useToastController, type ToastIntent,
} from '@fluentui/react-components';
import {
	Archive16Regular, ArrowCounterclockwise20Regular, ArrowLeft20Regular, ArrowRight20Regular, ArrowUp20Regular, Copy20Regular,
	Dismiss20Regular, Edit20Regular, FolderArrowRight20Regular, FolderOpen20Regular, Info20Regular, Open20Regular,
} from '@fluentui/react-icons';
import type { ConflictPolicy, Entry, Session } from '../../../shared/api';
import { call, errorCode, errorMessage, tib } from '../api';
import { friendlyError } from '../errors';
import { displayName, driveLabel } from '../fileTypes';
import { baseName, dirName, formatDate, formatSize, plural } from '../format';
import { useJobs } from '../jobs';
import { ConflictDialog } from './ConflictDialog';
import { FileList } from './FileList';
import { ancestors, FolderTree } from './FolderTree';
import { InfoPanel } from './InfoPanel';
import { JobsButton } from './JobsButton';
import { RestoreDialog } from './RestoreDialog';
import { TitleBar } from './TitleBar';


const useStyles = makeStyles({
	root: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		backgroundColor: tokens.colorNeutralBackground2,
	},
	commands: {
		display: 'flex',
		alignItems: 'center',
		padding: '0 8px',
		minHeight: '44px',
	},
	toolbar: {
		flex: 1,
	},
	address: {
		display: 'flex',
		alignItems: 'center',
		gap: '4px',
		padding: '0 8px 8px',
	},
	crumbs: {
		flex: 1,
		minWidth: 0,
		height: '32px',
		display: 'flex',
		alignItems: 'center',
		padding: '0 6px',
		overflowX: 'auto',
		overflowY: 'hidden',
		scrollbarWidth: 'none',
		backgroundColor: tokens.colorNeutralBackground1,
		border: '1px solid ' + tokens.colorNeutralStroke2,
		borderRadius: tokens.borderRadiusMedium,
	},
	body: {
		flex: 1,
		display: 'flex',
		minHeight: 0,
	},
	tree: {
		width: '250px',
		flexShrink: 0,
		overflow: 'auto',
	},
	main: {
		flex: 1,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
		backgroundColor: tokens.colorNeutralBackground1,
		borderTop: '1px solid ' + tokens.colorNeutralStroke2,
		borderLeft: '1px solid ' + tokens.colorNeutralStroke2,
		borderTopLeftRadius: tokens.borderRadiusXLarge,
		overflow: 'hidden',
	},
	status: {
		display: 'flex',
		alignItems: 'center',
		gap: '16px',
		height: '30px',
		padding: '0 8px 0 14px',
		color: tokens.colorNeutralForeground2,
	},
	spacer: {
		flex: 1,
	},
	slice: {
		minWidth: '260px',
	},
	sliceText: {
		color: tokens.colorNeutralForeground3,
	},
});

function parentOf(path: string): string {
	let i = path.lastIndexOf('/');
	return i <= 0 ? '/' : path.slice(0, i);
}

function sliceLabel(created: string, incremental: boolean): string {
	return formatDate(Date.parse(created)) + '  ·  ' + (incremental ? 'Incremental' : 'Full');
}

/** Copies to the clipboard first make temporary copies, so big ones get a warning */
const CLIPBOARD_WARN_BYTES = 2 * 1024 * 1024 * 1024;

/** A point on the screen for the right-click menu to open at */
function pointAt(x: number, y: number) {
	return { getBoundingClientRect: () => ({ x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 }) as DOMRect };
}


export function BackupView(props: { session: Session; onPickAnother: () => void; onClose: () => void }) {
	let s = useStyles();
	let { session } = props;
	let { info } = session;
	let sid = session.id;

	let [slice, setSlice] = useState(info.slices.length);
	let [path, setPath] = useState('/');
	let [back, setBack] = useState<string[]>([]);
	let [forward, setForward] = useState<string[]>([]);
	let [entries, setEntries] = useState<Entry[]>([]);
	let [loading, setLoading] = useState(true);
	let [listError, setListError] = useState<string | null>(null);
	let [selected, setSelected] = useState<Set<string>>(() => new Set());
	let [focusPath, setFocusPath] = useState<string | undefined>();
	let [infoOpen, setInfoOpen] = useState(false);
	let [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null } | null>(null);
	let [restoreSource, setRestoreSource] = useState<Entry | null>(null);
	let [bigClipboard, setBigClipboard] = useState<{ paths: string[]; bytes: number } | null>(null);
	let loadSeq = useRef(0);
	let crumbsRef = useRef<HTMLDivElement>(null);

	let jobs = useJobs(sid);
	let toasterId = useId('toaster');
	let { dispatchToast } = useToastController(toasterId);

	let notify = useCallback((intent: ToastIntent, title: string, body?: ReactNode, action?: { label: string; run: () => void }) => {
		dispatchToast(
			<Toast>
				<ToastTitle action={action ? <Link onClick={action.run}>{action.label}</Link> : undefined}>{title}</ToastTitle>
				{body && <ToastBody>{body}</ToastBody>}
			</Toast>,
			{ intent, timeout: intent === 'error' ? 10000 : 6000 }
		);
	}, [dispatchToast]);

	let notifyError = useCallback((e: unknown) => {
		let f = friendlyError(errorCode(e));
		notify('error', f.title, errorMessage(e));
	}, [notify]);

	// List the folder whenever it or the backup point changes
	useEffect(() => {
		let seq = ++loadSeq.current;
		setLoading(true);
		call(sid, 'list', slice, path).then(
			(list) => {
				if(seq !== loadSeq.current) {
					return;
				}
				setEntries(list);
				setListError(null);
				setLoading(false);
			},
			(e) => {
				if(seq !== loadSeq.current) {
					return;
				}
				setLoading(false);
				// The folder isn't in this backup point: show the nearest folder above it that is
				if(errorCode(e) === 'not-found' && path !== '/') {
					setPath(parentOf(path));
					return;
				}
				setEntries([]);
				setListError(errorMessage(e));
			}
		);
	}, [sid, slice, path]);

	// Keep the end of a long path visible
	useEffect(() => {
		let el = crumbsRef.current;
		if(el) {
			el.scrollLeft = el.scrollWidth;
		}
	}, [path]);


	// ---- Navigation

	let navigate = useCallback((to: string, focus?: string) => {
		if(to === path) {
			return;
		}
		setBack((b) => [...b, path]);
		setForward([]);
		setFocusPath(focus);
		setSelected(new Set());
		setPath(to);
	}, [path]);

	let goBack = useCallback(() => {
		if(back.length === 0) {
			return;
		}
		let prev = back[back.length - 1];
		setBack(back.slice(0, -1));
		setForward((f) => [path, ...f]);
		// Going back up to a folder above this one selects the folder we were in
		let isAbove = path.startsWith(prev === '/' ? '/' : prev + '/') && prev !== path;
		setFocusPath(isAbove ? ancestors(path)[ancestors(prev).length] : undefined);
		setSelected(new Set());
		setPath(prev);
	}, [back, path]);

	let goForward = useCallback(() => {
		if(forward.length === 0) {
			return;
		}
		let next = forward[0];
		setForward(forward.slice(1));
		setBack((b) => [...b, path]);
		setFocusPath(undefined);
		setSelected(new Set());
		setPath(next);
	}, [forward, path]);

	// Going up selects the folder we came from, like File Explorer
	let goUp = useCallback(() => {
		if(path !== '/') {
			navigate(parentOf(path), path);
		}
	}, [path, navigate]);

	let pickAnother = useCallback(async () => {
		let file = await tib.pickBackup();
		if(file) {
			await tib.openInNewWindow(file);
		}
	}, []);


	// ---- Getting files out

	let selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.path)), [entries, selected]);
	let selectedPaths = selectedEntries.map((e) => e.path);
	let single = selectedEntries.length === 1 ? selectedEntries[0] : null;

	let describe = (paths: string[]) => {
		if(paths.length !== 1) {
			return plural(paths.length, 'item', 'items');
		}
		let e = entries.find((x) => x.path === paths[0]);
		return e ? displayName(e, info.format) : baseName(paths[0]);
	};

	let copyTo = async (paths: string[]) => {
		if(paths.length === 0) {
			return;
		}
		let dest = await tib.pickFolder('copy');
		if(!dest) {
			return;
		}
		try {
			let r = await jobs.run('copy', 'Copying ' + describe(paths) + ' to ' + baseName(dest), dest,
				(id) => tib.copyTo(sid, id, slice, paths, dest, 'ask'),
				(v) => ({ firstItem: v.items[0] }));
			if(r) {
				let notes = [plural(r.files, 'file', 'files') + ', ' + formatSize(r.bytes)];
				if(r.skipped) {
					notes.push(plural(r.skipped, 'file', 'files') + ' skipped');
				}
				if(r.renamed) {
					notes.push(plural(r.renamed, 'name', 'names') + ' changed to work on Windows');
				}
				notify('success', 'Copied to ' + baseName(dest), notes.join('  ·  '),
					{ label: 'Show', run: () => void tib.showInFolder(r.items[0]) });
			}
		}
		catch(e) {
			notifyError(e);
		}
	};

	let restore = async (source: Entry, dest: string, policy: ConflictPolicy) => {
		setRestoreSource(null);
		let label = source.path === '/' ? info.name : displayName(source, info.format);
		try {
			let r = await jobs.run('restore', 'Restoring ' + label + ' to ' + baseName(dest), dest,
				(id) => tib.copyTo(sid, id, slice, [source.path], dest, policy),
				(v) => ({ firstItem: v.items[0] }));
			if(r) {
				notify('success', 'Restored ' + label, plural(r.files, 'file', 'files') + ', ' + formatSize(r.bytes) + (r.skipped ? '  ·  ' + r.skipped + ' skipped' : ''),
					{ label: 'Show', run: () => void tib.showInFolder(r.items[0]) });
			}
		}
		catch(e) {
			notifyError(e);
		}
	};

	let openEntry = useCallback(async (e: Entry) => {
		if(e.type === 'directory') {
			navigate(e.path);
			return;
		}
		try {
			await jobs.run('open', 'Opening ' + e.name, undefined, (id) => tib.openFile(sid, id, slice, e.path));
		}
		catch(err) {
			notifyError(err);
		}
	}, [navigate, jobs, sid, slice, notifyError]);

	let editCopy = async (e: Entry) => {
		let dest = await tib.pickFolder('edit');
		if(!dest) {
			return;
		}
		try {
			let r = await jobs.run('edit', 'Saving a copy of ' + e.name, dest,
				(id) => tib.copyTo(sid, id, slice, [e.path], dest, 'rename'),
				(v) => ({ firstItem: v.items[0] }));
			if(r) {
				let opened = await tib.openPath(r.items[0]);
				notify('info', 'You\'re editing a copy', 'Saved as ' + baseName(r.items[0]) + ' in ' + dirName(r.items[0]) + '. The backup is unchanged.'
					+ (opened.ok ? '' : ' (' + opened.error.message + ')'),
					{ label: 'Show', run: () => void tib.showInFolder(r.items[0]) });
			}
		}
		catch(err) {
			notifyError(err);
		}
	};

	let toClipboard = async (paths: string[]) => {
		try {
			let n = await jobs.run('clipboard', 'Copying ' + describe(paths) + ' for pasting', undefined,
				(id) => tib.copyToClipboard(sid, id, slice, paths));
			if(n !== null) {
				notify('success', 'Copied ' + plural(n, 'item', 'items'), 'Paste them in File Explorer with Ctrl+V.');
			}
		}
		catch(e) {
			notifyError(e);
		}
	};

	let copyClipboard = async (paths: string[]) => {
		if(paths.length === 0) {
			return;
		}
		try {
			let size = await call(sid, 'measure', slice, paths);
			if(size.bytes > CLIPBOARD_WARN_BYTES) {
				setBigClipboard({ paths, bytes: size.bytes });
				return;
			}
		}
		catch(e) {
			notifyError(e);
			return;
		}
		await toClipboard(paths);
	};

	let dragOut = async (paths: string[]) => {
		let r = await tib.dragOut(sid, slice, paths);
		if(!r.ok) {
			notify('error', friendlyError(r.error.code).title, r.error.message);
		}
		else if(r.value === 'too-big') {
			notify('info', 'That\'s a lot to drag', 'Over 200 MB has to be copied before it can be dropped. Use Copy to... instead.');
		}
	};

	/** What Restore offers by default: the selected folder, or the folder being shown */
	let restoreTarget = (): Entry => {
		if(single && single.type === 'directory') {
			return single;
		}
		return { name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1), path, type: 'directory', size: 0, mtime: 0 };
	};

	/** The selection, or the one entry right-clicked if it isn't part of it */
	let pathsFor = (entry: Entry | null) => (entry && !selected.has(entry.path) ? [entry.path] : selectedPaths);


	// ---- Shortcuts that work anywhere in the window

	useEffect(() => {
		let onKey = (e: KeyboardEvent) => {
			if(e.altKey && e.key === 'ArrowLeft') { goBack(); e.preventDefault(); }
			else if(e.altKey && e.key === 'ArrowRight') { goForward(); e.preventDefault(); }
			else if(e.altKey && e.key === 'ArrowUp') { goUp(); e.preventDefault(); }
			else if(e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') { void pickAnother(); e.preventDefault(); }
		};
		// The back/forward buttons on many mice
		let onMouse = (e: MouseEvent) => {
			if(e.button === 3) { goBack(); e.preventDefault(); }
			else if(e.button === 4) { goForward(); e.preventDefault(); }
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('mouseup', onMouse);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('mouseup', onMouse);
		};
	}, [goBack, goForward, goUp, pickAnother]);


	// ---- Layout

	let selectedBytes = selectedEntries.reduce((sum, e) => sum + (e.type === 'file' ? e.size : 0), 0);
	let selectedHasFolder = selectedEntries.some((e) => e.type === 'directory');

	let crumbs = ancestors(path);
	let crumbLabel = (p: string, i: number) => {
		if(i === 0) {
			return info.name;
		}
		let name = p.slice(p.lastIndexOf('/') + 1);
		return i === 1 && info.format === 'Windows' ? driveLabel(name) : name;
	};

	let point = info.slices[slice - 1];
	let firstConflict = jobs.conflicts[0];

	return (
		<div className={s.root}>
			<TitleBar title={info.name}>
				{info.slices.length > 1
					? (
						<Dropdown
							className={s.slice}
							size="small"
							aria-label="Backup point"
							value={sliceLabel(point.created, point.incremental)}
							selectedOptions={[String(slice)]}
							onOptionSelect={(_e, d) => {
								if(d.optionValue) {
									setSelected(new Set());
									setSlice(parseInt(d.optionValue, 10));
								}
							}}
						>
							{[...info.slices].reverse().map((sl) => (
								<Option key={sl.number} value={String(sl.number)} text={sliceLabel(sl.created, sl.incremental)}>
									{sliceLabel(sl.created, sl.incremental)}
								</Option>
							))}
						</Dropdown>
					)
					: <Caption1 className={s.sliceText}>Backed up {formatDate(Date.parse(point.created))}</Caption1>}
			</TitleBar>

			<div className={s.commands}>
				<Toolbar aria-label="Commands" size="medium" className={s.toolbar}>
					<ToolbarButton appearance="primary" icon={<FolderArrowRight20Regular />} disabled={selectedPaths.length === 0}
						onClick={() => void copyTo(selectedPaths)}>
						Copy to...
					</ToolbarButton>
					<Tooltip content="Copy, then paste in File Explorer (Ctrl+C)" relationship="description">
						<ToolbarButton icon={<Copy20Regular />} disabled={selectedPaths.length === 0} onClick={() => void copyClipboard(selectedPaths)}>
							Copy
						</ToolbarButton>
					</Tooltip>
					<ToolbarButton icon={<Open20Regular />} disabled={!single} onClick={() => single && void openEntry(single)}>Open</ToolbarButton>
					<ToolbarButton icon={<Edit20Regular />} disabled={!single || single.type !== 'file'} onClick={() => single && void editCopy(single)}>
						Edit a copy
					</ToolbarButton>
					<ToolbarDivider />
					<ToolbarButton icon={<ArrowCounterclockwise20Regular />} onClick={() => setRestoreSource(restoreTarget())}>Restore...</ToolbarButton>
					<span className={s.spacer} />
					<ToolbarButton icon={<Info20Regular />} onClick={() => setInfoOpen(true)}>Backup info</ToolbarButton>
					<Tooltip content="Open another backup (Ctrl+O)" relationship="label">
						<ToolbarButton icon={<FolderOpen20Regular />} onClick={() => void pickAnother()} />
					</Tooltip>
					<Tooltip content="Close this backup" relationship="label">
						<ToolbarButton icon={<Dismiss20Regular />} onClick={props.onClose} />
					</Tooltip>
				</Toolbar>
			</div>

			<div className={s.address}>
				<Tooltip content="Back (Alt+Left)" relationship="label">
					<ToolbarButton appearance="subtle" icon={<ArrowLeft20Regular />} disabled={back.length === 0} onClick={goBack} />
				</Tooltip>
				<Tooltip content="Forward (Alt+Right)" relationship="label">
					<ToolbarButton appearance="subtle" icon={<ArrowRight20Regular />} disabled={forward.length === 0} onClick={goForward} />
				</Tooltip>
				<Tooltip content="Up (Alt+Up)" relationship="label">
					<ToolbarButton appearance="subtle" icon={<ArrowUp20Regular />} disabled={path === '/'} onClick={goUp} />
				</Tooltip>
				<div className={s.crumbs} ref={crumbsRef}>
					<Breadcrumb aria-label="Location" size="small">
						{crumbs.map((p, i) => (
							<Fragment key={p}>
								<BreadcrumbItem>
									<BreadcrumbButton
										current={i === crumbs.length - 1}
										icon={i === 0 ? <Archive16Regular /> : undefined}
										onClick={() => navigate(p)}
									>
										{crumbLabel(p, i)}
									</BreadcrumbButton>
								</BreadcrumbItem>
								{i < crumbs.length - 1 && <BreadcrumbDivider />}
							</Fragment>
						))}
					</Breadcrumb>
				</div>
			</div>

			<div className={s.body}>
				<nav className={s.tree} aria-label="Folders">
					<FolderTree
						sessionId={sid}
						slice={slice}
						format={info.format}
						rootLabel={info.name}
						current={path}
						onNavigate={(p) => navigate(p)}
					/>
				</nav>
				<main className={s.main}>
					{listError && (
						<MessageBar intent="error">
							<MessageBarBody>This folder couldn't be read: {listError}</MessageBarBody>
						</MessageBar>
					)}
					<FileList
						entries={entries}
						format={info.format}
						loading={loading}
						selected={selected}
						onSelect={setSelected}
						onOpen={(e) => void openEntry(e)}
						onUp={goUp}
						onCopy={() => void copyClipboard(selectedPaths)}
						onContextMenu={(e, entry) => setMenu({ x: e.clientX, y: e.clientY, entry })}
						onDragOut={(paths) => void dragOut(paths)}
						focusPath={focusPath}
					/>
				</main>
			</div>

			<footer className={s.status}>
				<Caption1>{plural(entries.length, 'item', 'items')}</Caption1>
				{selectedEntries.length > 0 && (
					<Caption1>
						{plural(selectedEntries.length, 'item', 'items')} selected
						{selectedBytes > 0 && '  ·  ' + formatSize(selectedBytes) + (selectedHasFolder ? ' in files' : '')}
					</Caption1>
				)}
				<span className={s.spacer} />
				<JobsButton jobs={jobs} />
				<Caption1>{info.format} backup  {'·'}  backup point {slice} of {info.slices.length}</Caption1>
			</footer>

			<Menu
				open={menu !== null}
				onOpenChange={(_e, d) => { if(!d.open) { setMenu(null); } }}
				positioning={menu ? { target: pointAt(menu.x, menu.y), position: 'below', align: 'start' } : undefined}
			>
				<MenuPopover>
					{menu && menu.entry && (
						<MenuList>
							<MenuItem icon={<Open20Regular />} onClick={() => void openEntry(menu.entry!)}>Open</MenuItem>
							{menu.entry.type === 'file' && pathsFor(menu.entry).length === 1 && (
								<MenuItem icon={<Edit20Regular />} onClick={() => void editCopy(menu.entry!)}>Edit a copy...</MenuItem>
							)}
							<MenuDivider />
							<MenuItem icon={<Copy20Regular />} secondaryContent="Ctrl+C" onClick={() => void copyClipboard(pathsFor(menu.entry))}>Copy</MenuItem>
							<MenuItem icon={<FolderArrowRight20Regular />} onClick={() => void copyTo(pathsFor(menu.entry))}>Copy to...</MenuItem>
							{menu.entry.type === 'directory' && (
								<MenuItem icon={<ArrowCounterclockwise20Regular />} onClick={() => setRestoreSource(menu.entry)}>Restore...</MenuItem>
							)}
						</MenuList>
					)}
					{menu && !menu.entry && (
						<MenuList>
							<MenuItem icon={<ArrowCounterclockwise20Regular />} onClick={() => setRestoreSource(restoreTarget())}>Restore this folder...</MenuItem>
							<MenuItem icon={<Info20Regular />} onClick={() => setInfoOpen(true)}>Backup info</MenuItem>
						</MenuList>
					)}
				</MenuPopover>
			</Menu>

			{restoreSource && (
				<RestoreDialog
					open
					source={restoreSource}
					sessionId={sid}
					slice={slice}
					sliceCreated={point.created}
					format={info.format}
					backupName={info.name}
					onClose={() => setRestoreSource(null)}
					onStart={(dest, policy) => void restore(restoreSource, dest, policy)}
				/>
			)}

			<ConflictDialog
				conflict={firstConflict}
				waiting={firstConflict ? jobs.conflicts.filter((c) => c.jobId === firstConflict.jobId).length : 0}
				onAnswer={jobs.answer}
			/>

			<Dialog open={bigClipboard !== null} onOpenChange={(_e, d) => { if(!d.open) { setBigClipboard(null); } }}>
				<DialogSurface>
					<DialogBody>
						<DialogTitle>Copy {bigClipboard ? formatSize(bigClipboard.bytes) : ''} for pasting?</DialogTitle>
						<DialogContent>
							To paste files, TibReader first makes a temporary copy of them on this computer. For this much,
							Copy to... is faster: it copies straight into the folder you choose.
						</DialogContent>
						<DialogActions>
							<Button appearance="primary" onClick={() => { let b = bigClipboard; setBigClipboard(null); if(b) { void copyTo(b.paths); } }}>
								Copy to...
							</Button>
							<Button onClick={() => { let b = bigClipboard; setBigClipboard(null); if(b) { void toClipboard(b.paths); } }}>
								Copy for pasting anyway
							</Button>
						</DialogActions>
					</DialogBody>
				</DialogSurface>
			</Dialog>

			<InfoPanel open={infoOpen} onClose={() => setInfoOpen(false)} session={session} slice={slice} />
			<Toaster toasterId={toasterId} position="bottom-end" offset={{ vertical: 40 }} />
		</div>
	);
}
