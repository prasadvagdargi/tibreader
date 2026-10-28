import { useEffect, useState } from 'react';
import {
	Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, makeStyles,
	MessageBar, MessageBarBody, Radio, RadioGroup, Spinner, Text, tokens,
} from '@fluentui/react-components';
import { FolderOpen20Regular } from '@fluentui/react-icons';
import type { ConflictPolicy, Contents, Entry } from '../../../shared/api';
import { call, errorMessage, tib } from '../api';
import { displayName } from '../fileTypes';
import { formatDate, formatSize, plural } from '../format';


const useStyles = makeStyles({
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: '16px',
	},
	what: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		padding: '10px 12px',
		borderRadius: tokens.borderRadiusMedium,
		backgroundColor: tokens.colorNeutralBackground3,
	},
	muted: {
		color: tokens.colorNeutralForeground3,
	},
	row: {
		display: 'flex',
		gap: '8px',
	},
	grow: {
		flex: 1,
	},
	path: {
		wordBreak: 'break-all',
	},
});

/** Where a restored item ends up, roughly as Windows would name it */
function targetOf(dest: string, source: Entry, format: 'Windows' | 'Mac'): string {
	if(source.path === '/') {
		return dest;
	}
	let name = format === 'Mac' ? source.name.replace(/[<>:"\\|?*\u0000-\u001f/]/g, '_') : source.name;
	return dest.replace(/[\\/]+$/, '') + '\\' + name;
}


/**
 * Restore (clone) a whole drive or folder from the backup into a folder of your choice
 */
export function RestoreDialog(props: {
	open: boolean;
	source: Entry;
	sessionId: string;
	slice: number;
	sliceCreated: string;
	format: 'Windows' | 'Mac';
	backupName: string;
	onClose: () => void;
	onStart: (dest: string, policy: ConflictPolicy) => void;
}) {
	let s = useStyles();
	let [contents, setContents] = useState<Contents | string | null>(null);
	let [dest, setDest] = useState<string | null>(null);
	let [free, setFree] = useState<number | null>(null);
	let [policy, setPolicy] = useState<ConflictPolicy>('ask');

	let { open, source, sessionId, slice } = props;

	useEffect(() => {
		if(!open) {
			return;
		}
		setContents(null);
		call(sessionId, 'measure', slice, [source.path]).then(setContents, (e) => setContents(errorMessage(e)));
	}, [open, source.path, sessionId, slice]);

	useEffect(() => {
		setFree(null);
		if(dest) {
			void tib.freeSpace(dest).then(setFree);
		}
	}, [dest]);

	let browse = async () => {
		let folder = await tib.pickFolder('restore');
		if(folder) {
			setDest(folder);
		}
	};

	let bytes = contents && typeof contents === 'object' ? contents.bytes : null;
	let tooBig = bytes !== null && free !== null && bytes > free;
	let label = source.path === '/' ? 'Everything in ' + props.backupName : displayName(source, props.format);

	return (
		<Dialog open={open} onOpenChange={(_e, d) => { if(!d.open) { props.onClose(); } }}>
			<DialogSurface>
				<DialogBody>
					<DialogTitle>Restore files</DialogTitle>
					<DialogContent className={s.content}>
						<div className={s.what}>
							<Text weight="semibold">{label}</Text>
							<Text className={s.muted}>
								{contents === null && <Spinner size="extra-tiny" label="Counting files..." labelPosition="after" />}
								{typeof contents === 'string' && contents}
								{contents && typeof contents === 'object' && (
									plural(contents.files, 'file', 'files') + ', ' + formatSize(contents.bytes)
								)}
							</Text>
							<Text className={s.muted}>As backed up {formatDate(Date.parse(props.sliceCreated))}</Text>
						</div>

						<Field label="Restore to" hint={dest ? 'Files go to ' + targetOf(dest, source, props.format) : 'Pick an empty folder, or a drive with enough space.'}>
							<div className={s.row}>
								<Input className={s.grow} readOnly value={dest || ''} placeholder="No folder chosen" />
								<Button icon={<FolderOpen20Regular />} onClick={() => void browse()}>Browse...</Button>
							</div>
						</Field>

						{dest && free !== null && (
							tooBig
								? (
									<MessageBar intent="error">
										<MessageBarBody>Not enough space: this needs {formatSize(bytes!)}, but only {formatSize(free)} is free there.</MessageBarBody>
									</MessageBar>
								)
								: <Text className={s.muted}>{formatSize(free)} free there.</Text>
						)}

						<Field label="If a file is already there">
							<RadioGroup value={policy} onChange={(_e, d) => setPolicy(d.value as ConflictPolicy)}>
								<Radio value="ask" label="Ask me" />
								<Radio value="rename" label="Keep both (the restored one gets a new name)" />
								<Radio value="skip" label="Skip it" />
								<Radio value="overwrite" label="Replace it" />
							</RadioGroup>
						</Field>
					</DialogContent>
					<DialogActions>
						<Button appearance="primary" disabled={!dest || tooBig} onClick={() => dest && props.onStart(dest, policy)}>Restore</Button>
						<Button onClick={props.onClose}>Cancel</Button>
					</DialogActions>
				</DialogBody>
			</DialogSurface>
		</Dialog>
	);
}
