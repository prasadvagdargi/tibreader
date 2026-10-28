import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { makeStyles, mergeClasses, Spinner, tokens, Tree, TreeItem, TreeItemLayout } from '@fluentui/react-components';
import { Archive20Regular } from '@fluentui/react-icons';
import type { Entry } from '../../../shared/api';
import { call } from '../api';
import { displayName, iconFor } from '../fileTypes';


const useStyles = makeStyles({
	tree: {
		padding: '6px 4px 12px',
	},
	current: {
		backgroundColor: tokens.colorSubtleBackgroundSelected,
		fontWeight: tokens.fontWeightSemibold,
		':hover': { backgroundColor: tokens.colorSubtleBackgroundSelected },
	},
	label: {
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
});

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** '/', '/C', '/C/Users' for '/C/Users' */
export function ancestors(path: string): string[] {
	let parts = path.split('/').filter((p) => p.length > 0);
	let out = ['/'];
	for(let i = 1; i <= parts.length; i++) {
		out.push('/' + parts.slice(0, i).join('/'));
	}
	return out;
}

/** True if the event happened on this tree item itself, not on one nested inside it */
function ownEvent(e: MouseEvent | KeyboardEvent): boolean {
	return (e.target as Element).closest('[role="treeitem"]') === e.currentTarget;
}


/**
 * The folders of the backup, loaded as they are opened. Clicking a folder shows it; the arrow
 * opens or closes it.
 */
export function FolderTree(props: {
	sessionId: string;
	slice: number;
	format: 'Windows' | 'Mac';
	rootLabel: string;
	current: string;
	onNavigate: (path: string) => void;
}) {
	let s = useStyles();
	let [children, setChildren] = useState<Map<string, Entry[]>>(() => new Map());
	let [open, setOpen] = useState<Set<string>>(() => new Set(['/']));
	let loading = useRef(new Set<string>());
	let { sessionId, slice, current, onNavigate } = props;

	// Folder lists belong to one backup point
	useEffect(() => {
		setChildren(new Map());
		loading.current.clear();
	}, [slice]);

	let load = useCallback((path: string) => {
		if(loading.current.has(path)) {
			return;
		}
		loading.current.add(path);
		call(sessionId, 'list', slice, path).then(
			(list) => {
				let dirs = list.filter((e) => e.type === 'directory').sort((a, b) => collator.compare(a.name, b.name));
				setChildren((m) => new Map(m).set(path, dirs));
			},
			// A folder that can't be listed just shows no subfolders
			() => setChildren((m) => new Map(m).set(path, []))
		);
	}, [sessionId, slice]);

	// Keep the shown folder visible: open and load everything above it
	useEffect(() => {
		let anc = ancestors(current);
		setOpen((o) => {
			let n = new Set(o);
			for(let a of anc.slice(0, -1)) {
				n.add(a);
			}
			return n;
		});
		for(let a of anc) {
			load(a);
		}
	}, [current, load]);

	let toggle = (path: string, isOpen: boolean) => {
		setOpen((o) => {
			let n = new Set(o);
			if(isOpen) {
				n.add(path);
			}
			else {
				n.delete(path);
			}
			return n;
		});
		if(isOpen) {
			load(path);
		}
	};

	let renderItem = (path: string, label: string, icon: ReactElement): ReactElement => {
		let kids = children.get(path);
		let leaf = kids !== undefined && kids.length === 0;

		return (
			<TreeItem
				key={path}
				value={path}
				itemType={leaf ? 'leaf' : 'branch'}
				aria-current={path === current ? 'page' : undefined}
				onClick={(e) => { if(ownEvent(e) && !(e.target as Element).closest('.fui-TreeItemLayout__expandIcon')) { onNavigate(path); } }}
				onKeyDown={(e) => { if(e.key === 'Enter' && ownEvent(e)) { onNavigate(path); } }}
			>
				<TreeItemLayout iconBefore={icon} className={mergeClasses(path === current && s.current)}>
					<span className={s.label} title={label}>{label}</span>
				</TreeItemLayout>
				{!leaf && (
					<Tree>
						{kids
							? kids.map((k) => renderItem(k.path, displayName(k, props.format), iconFor(k, props.format)))
							: (
								<TreeItem value={path + '\u0000loading'} itemType="leaf">
									<TreeItemLayout><Spinner size="extra-tiny" label="Loading..." labelPosition="after" /></TreeItemLayout>
								</TreeItem>
							)}
					</Tree>
				)}
			</TreeItem>
		);
	};

	return (
		<Tree
			aria-label="Folders"
			className={s.tree}
			openItems={open}
			onOpenChange={(_e, data) => {
				let path = String(data.value);
				if(path.includes('\u0000')) {
					return;
				}
				// Clicking a folder's name shows it and never closes it; the arrow and keys open/close
				if(data.type === 'Click') {
					toggle(path, true);
				}
				else {
					toggle(path, data.open);
				}
			}}
		>
			{renderItem('/', props.rootLabel, <Archive20Regular style={{ color: tokens.colorBrandForeground1 }} />)}
		</Tree>
	);
}
