import type { ReactElement } from 'react';
import { tokens } from '@fluentui/react-components';
import {
	AppGeneric20Regular, Code20Regular, Document20Regular, DocumentPdf20Regular, DocumentText20Regular,
	Folder20Filled, FolderZip20Regular, HardDrive20Regular, Image20Regular, MusicNote220Regular,
	SlideText20Regular, Table20Regular, Video20Regular, WindowConsole20Regular,
} from '@fluentui/react-icons';
import type { Entry } from '../../shared/api';


type Kind = 'drive' | 'folder' | 'text' | 'pdf' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'sheet' | 'slides' | 'app' | 'script' | 'other';

interface TypeInfo {
	kind: Kind;
	label: string;
}

const KNOWN: Record<string, TypeInfo> = {};

function add(kind: Kind, label: string, exts: string) {
	for(let e of exts.split(' ')) {
		KNOWN[e] = { kind, label };
	}
}

add('text', 'Text Document', 'txt log md ini cfg csv');
add('text', 'Microsoft Word Document', 'doc docx rtf odt');
add('pdf', 'PDF Document', 'pdf');
add('image', 'Image', 'jpg jpeg png gif bmp tif tiff webp heic heif raw cr2 nef arw dng svg ico');
add('video', 'Video', 'mp4 mov avi mkv wmv m4v mpg mpeg webm 3gp mts');
add('audio', 'Audio', 'mp3 wav flac m4a aac ogg wma opus aiff');
add('archive', 'Compressed File', 'zip 7z rar gz tgz bz2 xz tar cab iso');
add('code', 'Source Code', 'js ts tsx jsx py c cpp h hpp cs java go rs rb php html htm css json xml yml yaml sql');
add('sheet', 'Spreadsheet', 'xls xlsx ods numbers');
add('slides', 'Presentation', 'ppt pptx odp key');
add('app', 'Application', 'exe msi dll sys app dmg');
add('script', 'Script', 'bat cmd ps1 sh');

/** The extension of a name, lower case, or '' */
export function extensionOf(name: string): string {
	let i = name.lastIndexOf('.');
	return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Whether an entry is a backed-up drive: Windows backups show each drive as a top-level folder
 */
export function isDrive(entry: Entry, format: 'Windows' | 'Mac'): boolean {
	return format === 'Windows' && entry.type === 'directory' && /^\/[^/]+$/.test(entry.path);
}

/** How a top-level drive folder is shown: "Local Disk (C:)" */
export function driveLabel(name: string): string {
	return /^[A-Za-z]$/.test(name) ? 'Drive (' + name.toUpperCase() + ':)' : name;
}

export function typeOf(entry: Entry, format: 'Windows' | 'Mac'): TypeInfo {
	if(isDrive(entry, format)) {
		return { kind: 'drive', label: 'Backed-up drive' };
	}
	if(entry.type === 'directory') {
		return { kind: 'folder', label: 'File folder' };
	}
	let ext = extensionOf(entry.name);
	return KNOWN[ext] || { kind: 'other', label: ext ? ext.toUpperCase() + ' File' : 'File' };
}

export function displayName(entry: Entry, format: 'Windows' | 'Mac'): string {
	return isDrive(entry, format) ? driveLabel(entry.name) : entry.name;
}

const COLORS: Partial<Record<Kind, string>> = {
	folder: '#e8a93a',
	pdf: tokens.colorPaletteRedForeground1,
	image: tokens.colorPaletteTealForeground2,
	video: tokens.colorPalettePurpleForeground2,
	audio: tokens.colorPaletteBerryForeground1,
	archive: tokens.colorPaletteMarigoldForeground1,
	sheet: tokens.colorPaletteGreenForeground1,
	slides: tokens.colorPaletteDarkOrangeForeground1,
	text: tokens.colorPaletteBlueForeground2,
};

export function iconFor(entry: Entry, format: 'Windows' | 'Mac'): ReactElement {
	let kind = typeOf(entry, format).kind;
	let style = { color: COLORS[kind] || tokens.colorNeutralForeground3, flexShrink: 0 };

	switch(kind) {
		case 'drive': return <HardDrive20Regular style={{ ...style, color: tokens.colorNeutralForeground2 }} />;
		case 'folder': return <Folder20Filled style={style} />;
		case 'text': return <DocumentText20Regular style={style} />;
		case 'pdf': return <DocumentPdf20Regular style={style} />;
		case 'image': return <Image20Regular style={style} />;
		case 'video': return <Video20Regular style={style} />;
		case 'audio': return <MusicNote220Regular style={style} />;
		case 'archive': return <FolderZip20Regular style={style} />;
		case 'code': return <Code20Regular style={style} />;
		case 'sheet': return <Table20Regular style={style} />;
		case 'slides': return <SlideText20Regular style={style} />;
		case 'app': return <AppGeneric20Regular style={style} />;
		case 'script': return <WindowConsole20Regular style={style} />;
		default: return <Document20Regular style={style} />;
	}
}
