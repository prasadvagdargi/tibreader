import { useState } from 'react';
import {
	Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, makeStyles, Text, tokens,
} from '@fluentui/react-components';
import type { ConflictChoice, JobConflict } from '../../../shared/api';
import { baseName, dirName, formatDate, formatSize } from '../format';


const useStyles = makeStyles({
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	compare: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '10px',
	},
	card: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		padding: '10px 12px',
		borderRadius: tokens.borderRadiusMedium,
		backgroundColor: tokens.colorNeutralBackground3,
	},
	muted: {
		color: tokens.colorNeutralForeground3,
		wordBreak: 'break-all',
	},
	name: {
		wordBreak: 'break-all',
	},
});


/**
 * "This file is already there": Replace, Skip, Keep both or Stop, optionally for all of them
 */
export function ConflictDialog(props: {
	conflict: JobConflict | undefined;
	waiting: number;
	onAnswer: (conflict: JobConflict, choice: ConflictChoice, applyToAll: boolean) => void;
}) {
	let s = useStyles();
	let [all, setAll] = useState(false);
	let c = props.conflict;
	if(!c) {
		return null;
	}

	let answer = (choice: ConflictChoice) => {
		props.onAnswer(c!, choice, all);
		setAll(false);
	};

	return (
		<Dialog open modalType="alert">
			<DialogSurface style={{ maxWidth: '600px' }}>
				<DialogBody>
					<DialogTitle>This file is already there</DialogTitle>
					<DialogContent className={s.content}>
						<Text>
							<span className={s.name}><b>{baseName(c.dest)}</b></span> already exists in{' '}
							<span className={s.name}>{dirName(c.dest)}</span>.
						</Text>
						<div className={s.compare}>
							<div className={s.card}>
								<Caption1 className={s.muted}>From the backup</Caption1>
								<Text>{formatSize(c.entry.size)}</Text>
								<Caption1>Modified {formatDate(c.entry.mtime)}</Caption1>
							</div>
							<div className={s.card}>
								<Caption1 className={s.muted}>Already there</Caption1>
								{c.existing
									? (
										<>
											<Text>{formatSize(c.existing.size)}</Text>
											<Caption1>Modified {formatDate(c.existing.mtime)}</Caption1>
										</>
									)
									: <Text>Folder or unreadable file</Text>}
							</div>
						</div>
						<Checkbox
							checked={all}
							onChange={(_e, d) => setAll(!!d.checked)}
							label={'Do this for every file that\'s already there' + (props.waiting > 1 ? ' (' + props.waiting + ' waiting)' : '')}
						/>
					</DialogContent>
					<DialogActions position="start">
						<Button appearance="subtle" onClick={() => answer('abort')}>Stop copying</Button>
					</DialogActions>
					<DialogActions position="end">
						<Button appearance="primary" onClick={() => answer('overwrite')}>Replace</Button>
						<Button onClick={() => answer('rename')}>Keep both</Button>
						<Button onClick={() => answer('skip')}>Skip</Button>
					</DialogActions>
				</DialogBody>
			</DialogSurface>
		</Dialog>
	);
}
