import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	Breadcrumb, BreadcrumbButton, BreadcrumbDivider, BreadcrumbItem, Caption1, Dropdown, makeStyles, MessageBar, MessageBarBody,
	Option, Toolbar, ToolbarButton, ToolbarDivider, tokens, Tooltip,
} from '@fluentui/react-components';
import {
	Archive16Regular, ArrowLeft20Regular, ArrowRight20Regular, ArrowUp20Regular, Dismiss20Regular, FolderOpen20Regular, Info20Regular,
} from '@fluentui/react-icons';
import type { Entry, Session } from '../../../shared/api';
import { call, errorCode, errorMessage, tib } from '../api';
import { driveLabel } from '../fileTypes';
import { formatDate, formatSize, plural } from '../format';
import { FileList } from './FileList';
import { ancestors, FolderTree } from './FolderTree';
import { InfoPanel } from './InfoPanel';
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
		height: '28px',
		padding: '0 14px',
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


export function BackupView(props: { session: Session; onPickAnother: () => void; onClose: () => void }) {
	let s = useStyles();
	let { session } = props;
	let { info } = session;

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
	let loadSeq = useRef(0);
	let crumbsRef = useRef<HTMLDivElement>(null);

	// List the folder whenever it or the backup point changes
	useEffect(() => {
		let seq = ++loadSeq.current;
		setLoading(true);
		call(session.id, 'list', slice, path).then(
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
	}, [session.id, slice, path]);

	// Keep the end of a long path visible
	useEffect(() => {
		let el = crumbsRef.current;
		if(el) {
			el.scrollLeft = el.scrollWidth;
		}
	}, [path]);

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

	let openEntry = useCallback((e: Entry) => {
		if(e.type === 'directory') {
			navigate(e.path);
		}
	}, [navigate]);

	let pickAnother = useCallback(async () => {
		let file = await tib.pickBackup();
		if(file) {
			await tib.openInNewWindow(file);
		}
	}, []);

	// Keyboard and mouse shortcuts that work anywhere in the window
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

	let selectedEntries = useMemo(() => entries.filter((e) => selected.has(e.path)), [entries, selected]);
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
				<Toolbar aria-label="Commands" size="medium">
					<ToolbarButton icon={<FolderOpen20Regular />} onClick={() => void pickAnother()}>Open another...</ToolbarButton>
					<ToolbarDivider />
					<ToolbarButton icon={<Info20Regular />} onClick={() => setInfoOpen(true)}>Backup info</ToolbarButton>
					<ToolbarDivider />
					<ToolbarButton icon={<Dismiss20Regular />} onClick={props.onClose}>Close backup</ToolbarButton>
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
						sessionId={session.id}
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
						onOpen={openEntry}
						onUp={goUp}
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
				<Caption1>{info.format} backup  {'·'}  backup point {slice} of {info.slices.length}</Caption1>
			</footer>

			<InfoPanel open={infoOpen} onClose={() => setInfoOpen(false)} session={session} slice={slice} />
		</div>
	);
}
