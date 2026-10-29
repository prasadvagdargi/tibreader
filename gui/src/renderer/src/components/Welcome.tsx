import { useCallback, useEffect, useState } from 'react';
import {
	Badge, Button, Caption1, makeStyles, mergeClasses, Spinner, Subtitle2, Text, Title2, tokens, Tooltip,
} from '@fluentui/react-components';
import {
	Archive48Regular, ArrowUpload24Regular, Dismiss20Regular, FolderOpen20Regular, History20Regular, ShieldCheckmark20Regular,
} from '@fluentui/react-icons';
import type { AppInfo, RecentBackup } from '../../../shared/api';
import { tib } from '../api';
import { baseName, dirName, formatRelative } from '../format';
import { TitleBar } from './TitleBar';


const useStyles = makeStyles({
	root: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		backgroundColor: tokens.colorNeutralBackground2,
	},
	scroll: {
		flex: 1,
		overflowY: 'auto',
		backgroundColor: tokens.colorNeutralBackground1,
		borderTop: '1px solid ' + tokens.colorNeutralStroke2,
	},
	column: {
		maxWidth: '760px',
		margin: '0 auto',
		padding: '48px 32px 32px',
		display: 'flex',
		flexDirection: 'column',
		gap: '28px',
	},
	hero: {
		display: 'flex',
		alignItems: 'center',
		gap: '20px',
	},
	heroIcon: {
		color: tokens.colorBrandForeground1,
		flexShrink: 0,
	},
	heroText: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	muted: {
		color: tokens.colorNeutralForeground3,
	},
	drop: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '12px',
		minHeight: '200px',
		borderRadius: tokens.borderRadiusXLarge,
		border: '2px dashed ' + tokens.colorNeutralStroke1,
		backgroundColor: tokens.colorNeutralBackground2,
		transitionProperty: 'background-color, border-color',
		transitionDuration: tokens.durationFast,
	},
	dropActive: {
		border: '2px dashed ' + tokens.colorBrandStroke1,
		backgroundColor: tokens.colorBrandBackground2,
	},
	dropIcon: {
		color: tokens.colorBrandForeground1,
	},
	sectionTitle: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		marginBottom: '8px',
	},
	list: {
		display: 'flex',
		flexDirection: 'column',
		border: '1px solid ' + tokens.colorNeutralStroke2,
		borderRadius: tokens.borderRadiusLarge,
		overflow: 'hidden',
	},
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: '12px',
		padding: '10px 8px 10px 14px',
		cursor: 'pointer',
		borderBottom: '1px solid ' + tokens.colorNeutralStroke3,
		backgroundColor: tokens.colorNeutralBackground1,
		':last-child': { borderBottom: 'none' },
		':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
		':focus-visible': { outline: '2px solid ' + tokens.colorStrokeFocus2, outlineOffset: '-2px' },
	},
	rowMissing: {
		cursor: 'default',
		opacity: 0.6,
		':hover': { backgroundColor: tokens.colorNeutralBackground1 },
	},
	rowText: {
		display: 'flex',
		flexDirection: 'column',
		minWidth: 0,
		flex: 1,
	},
	ellipsis: {
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	footer: {
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
		color: tokens.colorNeutralForeground3,
	},
	error: {
		color: tokens.colorPaletteRedForeground1,
	},
});


export function Welcome(props: { onOpen: (file: string) => void; dragging: boolean; dropError: string | null }) {
	let s = useStyles();
	let [recent, setRecent] = useState<RecentBackup[] | null>(null);
	let [app, setApp] = useState<AppInfo | null>(null);

	let refresh = useCallback(() => {
		void tib.recent().then(setRecent);
	}, []);

	useEffect(() => {
		refresh();
		void tib.appInfo().then(setApp);
	}, [refresh]);

	let pick = async () => {
		let file = await tib.pickBackup();
		if(file) {
			props.onOpen(file);
		}
	};

	let forget = async (file: string) => {
		await tib.forgetRecent(file);
		refresh();
	};

	return (
		<div className={s.root}>
			<TitleBar title="TibReader" />
			<div className={s.scroll}>
				<div className={s.column}>
					<div className={s.hero}>
						<Archive48Regular className={s.heroIcon} />
						<div className={s.heroText}>
							<Title2>Open an Acronis backup</Title2>
							<Text className={s.muted}>Browse a True Image backup (.tib or .tibx) and copy your files out.</Text>
						</div>
					</div>

					<div className={mergeClasses(s.drop, props.dragging && s.dropActive)}>
						<ArrowUpload24Regular className={s.dropIcon} />
						<Subtitle2>Drop a .tib or .tibx file here</Subtitle2>
						<Text className={s.muted}>or</Text>
						<Button appearance="primary" size="large" icon={<FolderOpen20Regular />} onClick={pick}>
							Open backup...
						</Button>
						{props.dropError && <Caption1 className={s.error}>{props.dropError}</Caption1>}
					</div>

					<section>
						<div className={s.sectionTitle}>
							<History20Regular />
							<Subtitle2>Recent backups</Subtitle2>
						</div>
						{recent === null && <Spinner size="tiny" />}
						{recent && recent.length === 0 && (
							<Text className={s.muted}>Backups you open show up here.</Text>
						)}
						{recent && recent.length > 0 && (
							<div className={s.list} role="list">
								{recent.map((r) => (
									<div
										key={r.file}
										role="listitem"
										tabIndex={r.exists ? 0 : -1}
										className={mergeClasses(s.row, !r.exists && s.rowMissing)}
										onClick={() => r.exists && props.onOpen(r.file)}
										onKeyDown={(e) => { if(e.key === 'Enter' && r.exists) { props.onOpen(r.file); } }}
										title={r.file}
									>
										<Archive48Regular style={{ width: 28, height: 28, flexShrink: 0, color: tokens.colorBrandForeground2 }} />
										<div className={s.rowText}>
											<Text weight="semibold" className={s.ellipsis}>{r.name}</Text>
											<Caption1 className={mergeClasses(s.muted, s.ellipsis)}>
												{dirName(r.file)} {'·'} {baseName(r.file)}
											</Caption1>
										</div>
										{!r.exists && <Badge appearance="tint" color="warning">Not found</Badge>}
										<Caption1 className={s.muted}>{formatRelative(r.lastOpened)}</Caption1>
										<Tooltip content="Remove from this list" relationship="label">
											<Button
												appearance="subtle"
												size="small"
												icon={<Dismiss20Regular />}
												onClick={(e) => { e.stopPropagation(); void forget(r.file); }}
											/>
										</Tooltip>
									</div>
								))}
							</div>
						)}
					</section>

					<div className={s.footer}>
						<ShieldCheckmark20Regular />
						<Caption1>
							Backups are only ever read; TibReader never changes them.
							{app && ' TibReader ' + app.version + (app.portable ? ' (portable)' : '')}
						</Caption1>
					</div>
				</div>
			</div>
		</div>
	);
}
