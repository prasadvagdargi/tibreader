import { useEffect, useRef, useState } from 'react';
import {
	Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, makeStyles,
	MessageBar, MessageBarBody, MessageBarTitle, ProgressBar, Text, tokens,
} from '@fluentui/react-components';
import type { BackupFormat, JobProgress, VerifyReport } from '../../../shared/api';
import { call, errorCode, errorMessage, tib } from '../api';
import { formatCount, formatDate, formatSize, plural } from '../format';
import { originalPath } from './DetailsPane';


const useStyles = makeStyles({
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	muted: {
		color: tokens.colorNeutralForeground3,
	},
	current: {
		color: tokens.colorNeutralForeground3,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	problems: {
		maxHeight: '220px',
		overflowY: 'auto',
		border: '1px solid ' + tokens.colorNeutralStroke2,
		borderRadius: tokens.borderRadiusMedium,
		padding: '6px 10px',
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
	},
	path: {
		wordBreak: 'break-all',
	},
});


/**
 * Reads every block of a backup point to check it isn't damaged (Windows backups: against each
 * block's stored MD5)
 */
export function VerifyDialog(props: {
	sessionId: string;
	slice: number;
	sliceCreated: string;
	format: BackupFormat;
	onClose: () => void;
}) {
	let s = useStyles();
	let [progress, setProgress] = useState<JobProgress | null>(null);
	let [report, setReport] = useState<VerifyReport | null>(null);
	let [state, setState] = useState<'running' | 'done' | 'cancelled' | 'failed'>('running');
	let [error, setError] = useState('');
	let [copied, setCopied] = useState(false);
	let jobId = useRef('');

	useEffect(() => {
		// A new id each time: React may run this twice (development), and the first run's job is cancelled
		let id = crypto.randomUUID();
		jobId.current = id;
		let off = tib.onEvent((ev) => {
			if(ev.name === 'job-progress' && ev.sessionId === props.sessionId && ev.progress.jobId === id) {
				setProgress(ev.progress);
			}
		});
		call(props.sessionId, 'verify', id, props.slice).then(
			(r) => { setReport(r); setState('done'); },
			(e) => {
				if(errorCode(e) === 'cancelled') {
					setState('cancelled');
				}
				else {
					setError(errorMessage(e));
					setState('failed');
				}
			}
		);
		return () => {
			off();
			// Closing the dialog stops checking
			void call(props.sessionId, 'cancel', id).catch(() => {});
		};
	}, [props.sessionId, props.slice]);

	let cancel = () => {
		void call(props.sessionId, 'cancel', jobId.current).catch(() => {});
	};

	let copyList = async () => {
		if(!report) {
			return;
		}
		let lines = report.problems.map((p) => (p.path.startsWith('/') ? originalPath(p.path, props.format) : p.path) + ': ' + p.message);
		await navigator.clipboard.writeText(lines.join('\r\n'));
		setCopied(true);
	};

	let fraction = progress && progress.totalBytes > 0 ? progress.bytes / progress.totalBytes
		: progress && progress.totalFiles > 0 ? progress.files / progress.totalFiles : undefined;

	return (
		<Dialog open modalType={state === 'running' ? 'alert' : 'modal'} onOpenChange={(_e, d) => { if(!d.open && state !== 'running') { props.onClose(); } }}>
			<DialogSurface style={{ maxWidth: '560px' }}>
				<DialogBody>
					<DialogTitle>Verify backup</DialogTitle>
					<DialogContent className={s.content}>
						<Text className={s.muted}>Backup point from {formatDate(Date.parse(props.sliceCreated))}</Text>

						{state === 'running' && (
							<>
								<ProgressBar value={fraction} max={1} thickness="large" />
								<Text>
									{progress
										? 'Checked ' + formatCount(progress.files) + ' of ' + plural(progress.totalFiles, 'file', 'files') + '  ·  ' +
											formatSize(progress.bytes) + ' of ' + formatSize(progress.totalBytes)
										: 'Starting...'}
								</Text>
								{progress?.path && <Caption1 className={s.current} title={progress.path}>{originalPath(progress.path, props.format)}</Caption1>}
							</>
						)}

						{state === 'done' && report && report.problems.length === 0 && (
							<MessageBar intent="success" layout="multiline">
								<MessageBarBody>
									<MessageBarTitle>No problems found</MessageBarTitle>
									Every block of {plural(report.files, 'file', 'files')} ({formatSize(report.bytes)}) checked out.
									{report.unstored > 0 && ' ' + plural(report.unstored, 'file was', 'files were') + ' backed up without their data and read as zeros (True Image does this for some files).'}
								</MessageBarBody>
							</MessageBar>
						)}

						{state === 'done' && report && report.problems.length > 0 && (
							<>
								<MessageBar intent="error" layout="multiline">
									<MessageBarBody>
										<MessageBarTitle>{plural(report.problems.length, 'problem', 'problems')} found</MessageBarTitle>
										These files are damaged in the backup. Everything else ({plural(report.files - report.problems.length, 'file', 'files')}) checked out.
									</MessageBarBody>
								</MessageBar>
								<div className={s.problems}>
									{report.problems.map((p, i) => (
										<div key={i}>
											<Text weight="semibold" className={s.path}>{p.path.startsWith('/') ? originalPath(p.path, props.format) : p.path}</Text>
											<Caption1 as="p" className={s.muted} style={{ margin: 0 }}>{p.message}</Caption1>
										</div>
									))}
								</div>
							</>
						)}

						{state === 'cancelled' && <Text>Stopped. {progress ? plural(progress.files, 'file was', 'files were') + ' checked before that, with no problems.' : ''}</Text>}

						{state === 'failed' && (
							<MessageBar intent="error"><MessageBarBody>Checking stopped: {error}</MessageBarBody></MessageBar>
						)}
					</DialogContent>
					<DialogActions>
						{state === 'running' && <Button onClick={cancel}>Stop</Button>}
						{state === 'done' && report && report.problems.length > 0 && (
							<Button onClick={() => void copyList()}>{copied ? 'Copied' : 'Copy list'}</Button>
						)}
						{state !== 'running' && <Button appearance="primary" onClick={props.onClose}>Close</Button>}
					</DialogActions>
				</DialogBody>
			</DialogSurface>
		</Dialog>
	);
}
