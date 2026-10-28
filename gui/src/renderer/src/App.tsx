import { useCallback, useEffect, useRef, useState } from 'react';
import { FluentProvider, makeStyles, Spinner, tokens } from '@fluentui/react-components';
import type { ErrorCode, Session } from '../../shared/api';
import { errorCode, errorMessage, openBackup, tib } from './api';
import { baseName } from './format';
import { useSystemTheme } from './theme';
import { BackupView } from './components/BackupView';
import { ErrorView } from './components/ErrorView';
import { TitleBar } from './components/TitleBar';
import { Welcome } from './components/Welcome';


type View =
	{ kind: 'welcome' } |
	{ kind: 'opening'; file: string } |
	{ kind: 'error'; file: string; code: ErrorCode; message: string } |
	{ kind: 'backup'; session: Session };

const useStyles = makeStyles({
	root: {
		height: '100%',
		backgroundColor: tokens.colorNeutralBackground2,
	},
	opening: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
	},
	center: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: tokens.colorNeutralBackground1,
		borderTop: '1px solid ' + tokens.colorNeutralStroke2,
	},
});

const BACKUP_FILE = /\.tib(\.metadata)?$/i;


export function App() {
	let s = useStyles();
	let { theme } = useSystemTheme();
	let [view, setView] = useState<View>({ kind: 'welcome' });
	let [dragging, setDragging] = useState(false);
	let [dropError, setDropError] = useState<string | null>(null);
	let viewRef = useRef(view);
	viewRef.current = view;

	let open = useCallback(async (file: string) => {
		setDropError(null);
		setView({ kind: 'opening', file });
		try {
			let session = await openBackup(file);
			setView({ kind: 'backup', session });
		}
		catch(e) {
			setView({ kind: 'error', file, code: errorCode(e), message: errorMessage(e) });
		}
	}, []);

	/** Opens here, or in a new window if this one already shows a backup */
	let openFile = useCallback((file: string) => {
		let v = viewRef.current;
		if(v.kind === 'backup' || v.kind === 'opening') {
			void tib.openInNewWindow(file);
		}
		else {
			void open(file);
		}
	}, [open]);

	let pick = useCallback(async () => {
		let file = await tib.pickBackup();
		if(file) {
			openFile(file);
		}
	}, [openFile]);

	let close = useCallback(async () => {
		let v = viewRef.current;
		if(v.kind === 'backup') {
			await tib.closeBackup(v.session.id);
		}
		setView({ kind: 'welcome' });
	}, []);

	// A backup given on the command line, by a file association or by another window
	useEffect(() => {
		void tib.takeInitialFile().then((f) => {
			if(f) {
				void open(f);
			}
		});
	}, [open]);

	useEffect(() => tib.onEvent((ev) => {
		let v = viewRef.current;
		if(ev.name === 'session-lost' && v.kind === 'backup' && v.session.id === ev.sessionId) {
			setView({ kind: 'error', file: v.session.info.file, code: 'engine', message: ev.message });
		}
		else if(ev.name === 'warning') {
			console.warn('Backup warning:', ev.message);
		}
		else if(ev.name === 'open-file') {
			openFile(ev.file);
		}
	}), [openFile]);

	useEffect(() => {
		document.title = view.kind === 'backup' ? view.session.info.name + ' - TibReader' : 'TibReader';
	}, [view]);

	// Drop a .tib file anywhere on the window to open it
	useEffect(() => {
		let depth = 0;
		let hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

		let enter = (e: DragEvent) => {
			if(hasFiles(e)) {
				depth++;
				setDragging(true);
			}
		};
		let leave = (e: DragEvent) => {
			if(hasFiles(e)) {
				depth = Math.max(0, depth - 1);
				if(depth === 0) {
					setDragging(false);
				}
			}
		};
		let over = (e: DragEvent) => {
			if(hasFiles(e)) {
				e.preventDefault();
				e.dataTransfer!.dropEffect = 'copy';
			}
		};
		let drop = (e: DragEvent) => {
			if(!hasFiles(e)) {
				return;
			}
			e.preventDefault();
			depth = 0;
			setDragging(false);

			let files = Array.from(e.dataTransfer!.files).map((f) => tib.pathForFile(f)).filter((p) => BACKUP_FILE.test(p));
			if(files.length === 0) {
				setDropError('That isn\'t a backup file. Drop a .tib file made by Acronis True Image.');
				return;
			}
			openFile(files[0]);
			for(let f of files.slice(1)) {
				void tib.openInNewWindow(f);
			}
		};

		window.addEventListener('dragenter', enter);
		window.addEventListener('dragleave', leave);
		window.addEventListener('dragover', over);
		window.addEventListener('drop', drop);
		return () => {
			window.removeEventListener('dragenter', enter);
			window.removeEventListener('dragleave', leave);
			window.removeEventListener('dragover', over);
			window.removeEventListener('drop', drop);
		};
	}, [openFile]);

	return (
		<FluentProvider theme={theme} className={s.root}>
			{view.kind === 'welcome' && <Welcome onOpen={openFile} dragging={dragging} dropError={dropError} />}
			{view.kind === 'opening' && (
				<div className={s.opening}>
					<TitleBar title="TibReader" />
					<div className={s.center}>
						<Spinner label={'Opening ' + baseName(view.file) + '...'} />
					</div>
				</div>
			)}
			{view.kind === 'error' && (
				<ErrorView
					file={view.file}
					code={view.code}
					message={view.message}
					onPick={() => void pick()}
					onBack={() => setView({ kind: 'welcome' })}
				/>
			)}
			{view.kind === 'backup' && (
				<BackupView session={view.session} onPickAnother={() => void pick()} onClose={() => void close()} />
			)}
		</FluentProvider>
	);
}
