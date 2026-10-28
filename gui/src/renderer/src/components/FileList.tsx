import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { makeStyles, mergeClasses, ProgressBar, Text, tokens } from '@fluentui/react-components';
import { ArrowSortDown16Regular, ArrowSortUp16Regular } from '@fluentui/react-icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Entry } from '../../../shared/api';
import { displayName, iconFor, typeOf } from '../fileTypes';
import { formatDate, formatSize } from '../format';


export type SortKey = 'name' | 'mtime' | 'type' | 'size';

const ROW_HEIGHT = 32;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const useStyles = makeStyles({
	root: {
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minWidth: 0,
	},
	scroll: {
		flex: 1,
		overflow: 'auto',
		outline: 'none',
	},
	header: {
		position: 'sticky',
		top: 0,
		zIndex: 1,
		display: 'grid',
		height: '34px',
		alignItems: 'stretch',
		backgroundColor: tokens.colorNeutralBackground1,
		borderBottom: '1px solid ' + tokens.colorNeutralStroke2,
		padding: '0 8px',
	},
	headerCell: {
		display: 'flex',
		alignItems: 'center',
		gap: '4px',
		padding: '0 8px',
		border: 'none',
		background: 'none',
		color: tokens.colorNeutralForeground2,
		fontFamily: 'inherit',
		fontSize: tokens.fontSizeBase200,
		cursor: 'pointer',
		textAlign: 'left',
		borderRadius: tokens.borderRadiusSmall,
		':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
	},
	right: {
		justifyContent: 'flex-end',
		textAlign: 'right',
	},
	body: {
		position: 'relative',
		margin: '2px 8px 8px',
	},
	row: {
		position: 'absolute',
		top: 0,
		left: 0,
		width: '100%',
		height: ROW_HEIGHT + 'px',
		display: 'grid',
		alignItems: 'center',
		borderRadius: tokens.borderRadiusMedium,
		cursor: 'default',
		userSelect: 'none',
		':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
	},
	selected: {
		backgroundColor: tokens.colorSubtleBackgroundSelected,
		':hover': { backgroundColor: tokens.colorSubtleBackgroundSelected },
	},
	selectedFocused: {
		backgroundColor: tokens.colorBrandBackground2,
		':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
	},
	focused: {
		outline: '1px solid ' + tokens.colorStrokeFocus2,
		outlineOffset: '-1px',
	},
	cell: {
		padding: '0 8px',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		color: tokens.colorNeutralForeground2,
		fontSize: tokens.fontSizeBase200,
	},
	nameCell: {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		color: tokens.colorNeutralForeground1,
		fontSize: tokens.fontSizeBase300,
	},
	name: {
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	empty: {
		padding: '48px 16px',
		textAlign: 'center',
		color: tokens.colorNeutralForeground3,
	},
	progress: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		zIndex: 2,
	},
});


function sortEntries(entries: Entry[], key: SortKey, desc: boolean, format: 'Windows' | 'Mac'): Entry[] {
	let dir = desc ? -1 : 1;
	return [...entries].sort((a, b) => {
		// Folders always come first, like File Explorer
		if(a.type !== b.type) {
			return a.type === 'directory' ? -1 : 1;
		}
		let c = 0;
		if(key === 'mtime') {
			c = a.mtime - b.mtime;
		}
		else if(key === 'size') {
			c = a.size - b.size;
		}
		else if(key === 'type') {
			c = collator.compare(typeOf(a, format).label, typeOf(b, format).label);
		}
		return (c !== 0 ? c * dir : 0) || collator.compare(a.name, b.name) * (key === 'name' ? dir : 1);
	});
}

/** Width of an element, kept up to date */
function useWidth(ref: RefObject<HTMLElement | null>): number {
	let [w, setW] = useState(0);
	useLayoutEffect(() => {
		let el = ref.current;
		if(!el) {
			return;
		}
		let ro = new ResizeObserver(() => setW(el!.clientWidth));
		ro.observe(el);
		setW(el.clientWidth);
		return () => ro.disconnect();
	}, [ref]);
	return w;
}


export interface FileListProps {
	entries: Entry[];
	format: 'Windows' | 'Mac';
	loading: boolean;
	selected: ReadonlySet<string>;
	onSelect: (paths: Set<string>) => void;
	/** Double-click or Enter */
	onOpen: (entry: Entry) => void;
	onUp: () => void;
	/** Entry to focus when the list changes (e.g. the folder we came up from) */
	focusPath?: string;
	emptyText?: string;
}

/**
 * The files and folders of one folder, in a details view like File Explorer's. Only the visible rows
 * are drawn, so folders with hundreds of thousands of entries stay fast.
 */
export function FileList(p: FileListProps) {
	let s = useStyles();
	let [sortKey, setSortKey] = useState<SortKey>('name');
	let [desc, setDesc] = useState(false);
	let [focus, setFocus] = useState<string | null>(null);
	let [hasFocus, setHasFocus] = useState(false);
	let anchor = useRef<string | null>(null);
	let scrollRef = useRef<HTMLDivElement>(null);
	let typeahead = useRef({ text: '', time: 0 });

	let width = useWidth(scrollRef);
	let showType = width === 0 || width > 640;
	let columns = showType ? 'minmax(200px, 1fr) 168px 150px 96px' : 'minmax(160px, 1fr) 150px 88px';

	let rows = useMemo(() => sortEntries(p.entries, sortKey, desc, p.format), [p.entries, sortKey, desc, p.format]);
	let index = useMemo(() => new Map(rows.map((e, i) => [e.path, i])), [rows]);
	let focusIndex = focus !== null ? (index.get(focus) ?? -1) : -1;

	let virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
	});

	// A new folder: focus the given entry (or the first) and scroll to it
	useEffect(() => {
		let target = p.focusPath && p.entries.some((e) => e.path === p.focusPath) ? p.focusPath : null;
		setFocus(target);
		anchor.current = target;
		if(target === null) {
			scrollRef.current?.scrollTo({ top: 0 });
		}
		else {
			p.onSelect(new Set([target]));
		}
	}, [p.entries]);

	// Keep the focused row on screen (keyboard moves, sorting)
	useEffect(() => {
		if(focusIndex >= 0) {
			virtualizer.scrollToIndex(focusIndex, { align: 'auto' });
		}
	}, [focus, rows]);

	let selectRange = (from: number, to: number, add: boolean) => {
		let n = add ? new Set(p.selected) : new Set<string>();
		let [a, b] = from <= to ? [from, to] : [to, from];
		for(let i = a; i <= b; i++) {
			n.add(rows[i].path);
		}
		p.onSelect(n);
	};

	let moveTo = (i: number, shift: boolean, ctrl: boolean) => {
		if(rows.length === 0) {
			return;
		}
		i = Math.max(0, Math.min(rows.length - 1, i));
		let path = rows[i].path;
		setFocus(path);

		if(shift) {
			let a = anchor.current !== null ? (index.get(anchor.current) ?? i) : i;
			selectRange(a, i, ctrl);
		}
		else if(!ctrl) {
			anchor.current = path;
			p.onSelect(new Set([path]));
		}
	};

	let onKeyDown = (e: KeyboardEvent) => {
		let page = Math.max(1, Math.floor((scrollRef.current?.clientHeight || 300) / ROW_HEIGHT) - 1);
		let cur = focusIndex;

		switch(e.key) {
			case 'ArrowDown': moveTo(cur < 0 ? 0 : cur + 1, e.shiftKey, e.ctrlKey); break;
			case 'ArrowUp': moveTo(cur < 0 ? 0 : cur - 1, e.shiftKey, e.ctrlKey); break;
			case 'PageDown': moveTo(cur + page, e.shiftKey, e.ctrlKey); break;
			case 'PageUp': moveTo(cur - page, e.shiftKey, e.ctrlKey); break;
			case 'Home': moveTo(0, e.shiftKey, e.ctrlKey); break;
			case 'End': moveTo(rows.length - 1, e.shiftKey, e.ctrlKey); break;
			case 'Enter':
				if(cur >= 0) {
					p.onOpen(rows[cur]);
				}
				break;
			case 'Backspace':
				p.onUp();
				break;
			case 'Escape':
				p.onSelect(new Set());
				break;
			case ' ':
				if(e.ctrlKey && cur >= 0) {
					let n = new Set(p.selected);
					let path = rows[cur].path;
					if(n.has(path)) {
						n.delete(path);
					}
					else {
						n.add(path);
					}
					anchor.current = path;
					p.onSelect(n);
					break;
				}
				return;
			default:
				if((e.key === 'a' || e.key === 'A') && e.ctrlKey) {
					p.onSelect(new Set(rows.map((r) => r.path)));
					break;
				}
				// Typing jumps to the next name that starts with what was typed
				if(e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
					let now = Date.now();
					let t = typeahead.current;
					t.text = now - t.time > 800 ? e.key : t.text + e.key;
					t.time = now;
					let needle = t.text.toLowerCase();
					let start = t.text.length === 1 ? cur + 1 : Math.max(cur, 0);
					for(let k = 0; k < rows.length; k++) {
						let i = (start + k) % rows.length;
						if(displayName(rows[i], p.format).toLowerCase().startsWith(needle)) {
							moveTo(i, false, false);
							break;
						}
					}
					break;
				}
				return;
		}
		e.preventDefault();
	};

	let onRowClick = (e: MouseEvent, i: number) => {
		scrollRef.current?.focus();
		let path = rows[i].path;
		setFocus(path);

		if(e.shiftKey) {
			let a = anchor.current !== null ? (index.get(anchor.current) ?? i) : i;
			selectRange(a, i, e.ctrlKey);
			return;
		}
		if(e.ctrlKey) {
			let n = new Set(p.selected);
			if(n.has(path)) {
				n.delete(path);
			}
			else {
				n.add(path);
			}
			p.onSelect(n);
		}
		else {
			p.onSelect(new Set([path]));
		}
		anchor.current = path;
	};

	let sortBy = (key: SortKey) => {
		if(key === sortKey) {
			setDesc(!desc);
		}
		else {
			setSortKey(key);
			setDesc(false);
		}
	};

	let header = (key: SortKey, label: string, alignRight = false) => (
		<button
			role="columnheader"
			aria-sort={sortKey === key ? (desc ? 'descending' : 'ascending') : 'none'}
			className={mergeClasses(s.headerCell, alignRight && s.right)}
			onClick={() => sortBy(key)}
			tabIndex={-1}
		>
			{label}
			{sortKey === key && (desc ? <ArrowSortDown16Regular /> : <ArrowSortUp16Regular />)}
		</button>
	);

	return (
		<div className={s.root}>
			{p.loading && <ProgressBar className={s.progress} thickness="medium" />}
			<div
				ref={scrollRef}
				className={s.scroll}
				role="grid"
				aria-label="Files and folders"
				aria-multiselectable="true"
				aria-rowcount={rows.length + 1}
				aria-activedescendant={focusIndex >= 0 ? 'row-' + focusIndex : undefined}
				tabIndex={0}
				onKeyDown={onKeyDown}
				onFocus={() => setHasFocus(true)}
				onBlur={() => setHasFocus(false)}
				onMouseDown={(e) => {
					// Clicking empty space clears the selection
					if(e.target === e.currentTarget || (e.target as Element).getAttribute('data-body') === '1') {
						p.onSelect(new Set());
					}
				}}
			>
				<div className={s.header} role="row" style={{ gridTemplateColumns: columns }}>
					{header('name', 'Name')}
					{header('mtime', 'Date modified')}
					{showType && header('type', 'Type')}
					{header('size', 'Size', true)}
				</div>

				{rows.length === 0 && !p.loading && (
					<Text as="p" className={s.empty}>{p.emptyText || 'This folder is empty.'}</Text>
				)}

				<div className={s.body} data-body="1" style={{ height: virtualizer.getTotalSize() }}>
					{virtualizer.getVirtualItems().map((v) => {
						let e = rows[v.index];
						let isSel = p.selected.has(e.path);
						let isFocus = v.index === focusIndex;
						return (
							<div
								key={e.path}
								id={'row-' + v.index}
								role="row"
								aria-rowindex={v.index + 2}
								aria-selected={isSel}
								className={mergeClasses(
									s.row,
									isSel && (hasFocus ? s.selectedFocused : s.selected),
									isFocus && hasFocus && s.focused,
								)}
								style={{ transform: 'translateY(' + v.start + 'px)', gridTemplateColumns: columns }}
								onMouseDown={(ev) => { if(ev.button === 0) { onRowClick(ev, v.index); } }}
								onDoubleClick={() => p.onOpen(e)}
							>
								<div role="gridcell" className={mergeClasses(s.cell, s.nameCell)}>
									{iconFor(e, p.format)}
									<span className={s.name} title={e.name}>{displayName(e, p.format)}</span>
								</div>
								<div role="gridcell" className={s.cell}>{formatDate(e.mtime)}</div>
								{showType && <div role="gridcell" className={s.cell}>{typeOf(e, p.format).label}</div>}
								<div role="gridcell" className={mergeClasses(s.cell, s.right)} style={{ textAlign: 'right' }}>
									{e.type === 'file' ? formatSize(e.size) : ''}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
