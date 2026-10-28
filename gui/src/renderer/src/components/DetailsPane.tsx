import { useEffect, useState, type ReactNode } from 'react';
import { Button, Caption1, makeStyles, Spinner, Subtitle2, Text, tokens } from '@fluentui/react-components';
import { Open20Regular } from '@fluentui/react-icons';
import type { Contents, Entry, EntryDetails } from '../../../shared/api';
import { call, errorMessage } from '../api';
import { displayName, extensionOf, iconFor, typeOf } from '../fileTypes';
import { formatCount, formatLongDate, formatSize, plural } from '../format';


const useStyles = makeStyles({
	root: {
		width: '100%',
		height: '100%',
		overflowY: 'auto',
		boxSizing: 'border-box',
		padding: '16px',
		display: 'flex',
		flexDirection: 'column',
		gap: '14px',
	},
	preview: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		minHeight: '140px',
		maxHeight: '320px',
		borderRadius: tokens.borderRadiusLarge,
		backgroundColor: tokens.colorNeutralBackground3,
		overflow: 'hidden',
	},
	media: {
		maxWidth: '100%',
		maxHeight: '320px',
		objectFit: 'contain',
		display: 'block',
	},
	bigIcon: {
		transform: 'scale(3)',
		display: 'flex',
	},
	text: {
		alignSelf: 'flex-start',
		width: '100%',
		boxSizing: 'border-box',
		margin: 0,
		padding: '10px',
		fontFamily: tokens.fontFamilyMonospace,
		fontSize: tokens.fontSizeBase200,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		overflow: 'auto',
		maxHeight: '300px',
	},
	name: {
		display: 'block',
		wordBreak: 'break-word',
	},
	kind: {
		display: 'block',
		color: tokens.colorNeutralForeground3,
	},
	grid: {
		display: 'grid',
		gridTemplateColumns: '92px 1fr',
		columnGap: '10px',
		rowGap: '6px',
	},
	label: {
		color: tokens.colorNeutralForeground3,
	},
	value: {
		wordBreak: 'break-word',
	},
	muted: {
		color: tokens.colorNeutralForeground3,
	},
});

type PreviewKind = 'image' | 'video' | 'audio' | 'text' | null;

const PREVIEWS: Record<string, PreviewKind> = {};
for(let e of 'jpg jpeg png gif webp bmp ico svg avif'.split(' ')) PREVIEWS[e] = 'image';
for(let e of 'mp4 m4v webm ogv'.split(' ')) PREVIEWS[e] = 'video';
for(let e of 'mp3 wav ogg oga m4a aac flac opus'.split(' ')) PREVIEWS[e] = 'audio';
for(let e of 'txt log md ini cfg csv json xml yml yaml js ts py c h cpp cs java html htm css bat ps1 sh sql reg'.split(' ')) PREVIEWS[e] = 'text';

/** How much of a text file the preview shows */
const TEXT_BYTES = 64 * 1024;

/** Windows FILE_ATTRIBUTE_* flags shown in Properties */
const ATTRIBUTES: Array<[number, string]> = [
	[0x1, 'Read-only'], [0x2, 'Hidden'], [0x4, 'System'], [0x20, 'Archive'],
	[0x200, 'Sparse'], [0x800, 'Compressed'], [0x4000, 'Encrypted'],
];

export function previewUrl(sessionId: string, slice: number, path: string): string {
	return 'tib-preview://' + sessionId + '/' + slice + path.split('/').map(encodeURIComponent).join('/');
}

/** The path as it was on the backed-up computer: C:\Users\... for Windows backups */
export function originalPath(path: string, format: 'Windows' | 'Mac'): string {
	if(format !== 'Windows') {
		return path;
	}
	let parts = path.split('/').filter((p) => p.length > 0);
	if(parts.length === 0) {
		return '\\';
	}
	return parts[0] + ':\\' + parts.slice(1).join('\\');
}

function decodeText(buf: ArrayBuffer): string {
	let b = new Uint8Array(buf);
	if(b[0] === 0xff && b[1] === 0xfe) {
		return new TextDecoder('utf-16le').decode(b.subarray(2));
	}
	if(b[0] === 0xfe && b[1] === 0xff) {
		return new TextDecoder('utf-16be').decode(b.subarray(2));
	}
	return new TextDecoder('utf-8').decode(b);
}


function Row(props: { label: string; children: ReactNode }) {
	let s = useStyles();
	return (
		<>
			<Caption1 className={s.label}>{props.label}</Caption1>
			<Caption1 className={s.value}>{props.children}</Caption1>
		</>
	);
}

function Preview(props: { sessionId: string; slice: number; entry: Entry; format: 'Windows' | 'Mac' }) {
	let s = useStyles();
	let kind = props.entry.type === 'file' && props.entry.size > 0 ? PREVIEWS[extensionOf(props.entry.name)] ?? null : null;
	let url = previewUrl(props.sessionId, props.slice, props.entry.path);
	let [text, setText] = useState<string | null>(null);
	let [failed, setFailed] = useState(false);

	useEffect(() => {
		setText(null);
		setFailed(false);
		if(kind !== 'text') {
			return;
		}
		let cancelled = false;
		fetch(url, { headers: { Range: 'bytes=0-' + (TEXT_BYTES - 1) } })
			.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
			.then((b) => { if(!cancelled) { setText(decodeText(b) + (props.entry.size > TEXT_BYTES ? '\n\u2026' : '')); } })
			.catch(() => { if(!cancelled) { setFailed(true); } });
		return () => { cancelled = true; };
	}, [url, kind, props.entry.size]);

	let icon = <div className={s.bigIcon}>{iconFor(props.entry, props.format)}</div>;

	if(failed || kind === null) {
		return <div className={s.preview}>{icon}</div>;
	}
	if(kind === 'image') {
		return <div className={s.preview}><img className={s.media} src={url} alt="" onError={() => setFailed(true)} /></div>;
	}
	if(kind === 'video') {
		return <div className={s.preview}><video className={s.media} src={url} controls preload="metadata" onError={() => setFailed(true)} /></div>;
	}
	if(kind === 'audio') {
		return <div className={s.preview}><audio src={url} controls preload="metadata" style={{ width: '90%' }} onError={() => setFailed(true)} /></div>;
	}
	return <div className={s.preview}>{text === null ? <Spinner size="tiny" /> : <pre className={s.text}>{text}</pre>}</div>;
}


/**
 * The right-hand pane: a preview and the properties of what is selected
 */
export function DetailsPane(props: {
	sessionId: string;
	slice: number;
	format: 'Windows' | 'Mac';
	selected: Entry[];
	/** Shown when nothing is selected */
	folderName: string;
	folderCount: number;
	onOpen: (entry: Entry) => void;
}) {
	let s = useStyles();
	let one = props.selected.length === 1 ? props.selected[0] : null;
	let [details, setDetails] = useState<EntryDetails | null>(null);
	let [contents, setContents] = useState<Contents | string | null>(null);

	useEffect(() => {
		setDetails(null);
		setContents(null);
		if(!one) {
			return;
		}
		let cancelled = false;
		call(props.sessionId, 'details', props.slice, one.path).then((d) => { if(!cancelled) { setDetails(d); } }, () => {});
		if(one.type === 'directory') {
			call(props.sessionId, 'measure', props.slice, [one.path]).then(
				(c) => { if(!cancelled) { setContents(c); } },
				(e) => { if(!cancelled) { setContents(errorMessage(e)); } }
			);
		}
		return () => { cancelled = true; };
	}, [one?.path, props.sessionId, props.slice]);

	if(props.selected.length === 0) {
		return (
			<div className={s.root}>
				<Subtitle2 className={s.name}>{props.folderName}</Subtitle2>
				<Text className={s.muted}>{plural(props.folderCount, 'item', 'items')}</Text>
				<Caption1 className={s.muted}>Select something to see a preview and its details.</Caption1>
			</div>
		);
	}

	if(!one) {
		let files = props.selected.filter((e) => e.type === 'file');
		let bytes = files.reduce((n, e) => n + e.size, 0);
		return (
			<div className={s.root}>
				<Subtitle2>{plural(props.selected.length, 'item', 'items')} selected</Subtitle2>
				<div className={s.grid}>
					<Row label="Files">{formatCount(files.length)}</Row>
					<Row label="Folders">{formatCount(props.selected.length - files.length)}</Row>
					<Row label="Size">{formatSize(bytes)}{files.length < props.selected.length ? ' (not counting folders)' : ''}</Row>
				</div>
			</div>
		);
	}

	let attrs = details?.attributes !== undefined ? ATTRIBUTES.filter(([bit]) => (details!.attributes! & bit) !== 0).map(([, n]) => n) : null;

	return (
		<div className={s.root}>
			<Preview sessionId={props.sessionId} slice={props.slice} entry={one} format={props.format} />
			<div>
				<Subtitle2 className={s.name}>{displayName(one, props.format)}</Subtitle2>
				<Caption1 className={s.kind}>{typeOf(one, props.format).label}</Caption1>
			</div>
			{one.type === 'file' && (
				<Button size="small" icon={<Open20Regular />} onClick={() => props.onOpen(one!)} style={{ alignSelf: 'flex-start' }}>Open</Button>
			)}
			<div className={s.grid}>
				{one.type === 'file' && <Row label="Size">{formatSize(one.size)}{one.size >= 1024 ? ' (' + formatCount(one.size) + ' bytes)' : ''}</Row>}
				{one.type === 'directory' && (
					<Row label="Contains">
						{contents === null && <Spinner size="extra-tiny" />}
						{typeof contents === 'string' && contents}
						{contents && typeof contents === 'object' && (
							plural(contents.files, 'file', 'files') + ', ' + plural(contents.folders, 'folder', 'folders') + ', ' + formatSize(contents.bytes)
						)}
					</Row>
				)}
				<Row label="Modified">{formatLongDate(one.mtime)}</Row>
				{details?.created !== undefined && <Row label="Created">{formatLongDate(details.created)}</Row>}
				{attrs && <Row label="Attributes">{attrs.length > 0 ? attrs.join(', ') : 'None'}</Row>}
				<Row label="Was at">{originalPath(one.path, props.format)}</Row>
			</div>
		</div>
	);
}
