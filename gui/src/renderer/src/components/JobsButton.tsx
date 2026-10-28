import {
	Button, Caption1, Link, makeStyles, Popover, PopoverSurface, PopoverTrigger, ProgressBar, Spinner, Subtitle2, Text, tokens,
} from '@fluentui/react-components';
import {
	CheckmarkCircle16Filled, Dismiss16Regular, DismissCircle16Filled, ErrorCircle16Filled, FolderOpen16Regular,
} from '@fluentui/react-icons';
import type { Job, Jobs } from '../jobs';
import { formatSize } from '../format';


const useStyles = makeStyles({
	trigger: {
		minWidth: 0,
		height: '24px',
		padding: '0 8px',
		fontWeight: tokens.fontWeightRegular,
	},
	surface: {
		width: '380px',
		maxHeight: '420px',
		overflowY: 'auto',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
	},
	head: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
	},
	job: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		padding: '8px 0',
		borderTop: '1px solid ' + tokens.colorNeutralStroke3,
	},
	jobHead: {
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
	},
	title: {
		flex: 1,
		minWidth: 0,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	muted: {
		color: tokens.colorNeutralForeground3,
	},
	actions: {
		display: 'flex',
		gap: '4px',
	},
	ok: { color: tokens.colorPaletteGreenForeground1 },
	bad: { color: tokens.colorPaletteRedForeground1 },
});

function percent(j: Job): number | undefined {
	let p = j.progress;
	if(!p) {
		return undefined;
	}
	if(p.totalBytes > 0) {
		return p.bytes / p.totalBytes;
	}
	return p.totalFiles > 0 ? p.files / p.totalFiles : undefined;
}

function remaining(j: Job): string {
	let p = j.progress;
	if(!p || !j.speed || j.speed <= 0 || p.totalBytes <= p.bytes) {
		return '';
	}
	let secs = (p.totalBytes - p.bytes) / j.speed;
	if(secs < 60) {
		return 'less than a minute left';
	}
	let mins = Math.round(secs / 60);
	return mins < 120 ? 'about ' + mins + ' min left' : 'about ' + Math.round(mins / 60) + ' h left';
}

function detail(j: Job): string {
	let p = j.progress;
	if(j.status === 'failed') {
		return j.error || 'Failed';
	}
	if(j.status === 'cancelled') {
		return 'Stopped';
	}
	if(!p) {
		return 'Starting...';
	}
	if(j.status === 'done') {
		return p.files + (p.files === 1 ? ' file' : ' files') + ', ' + formatSize(p.bytes);
	}
	let parts = [formatSize(p.bytes) + ' of ' + formatSize(p.totalBytes)];
	if(j.speed) {
		parts.push(formatSize(j.speed) + '/s');
	}
	let left = remaining(j);
	if(left) {
		parts.push(left);
	}
	return parts.join('  ·  ');
}


/**
 * The status bar button for copies in progress, with a list of recent ones
 */
export function JobsButton(props: { jobs: Jobs }) {
	let s = useStyles();
	let { jobs, cancel, dismiss, clearFinished } = props.jobs;
	let visible = jobs.filter((j) => j.kind !== 'open' || j.status !== 'done');
	if(visible.length === 0) {
		return null;
	}

	let running = visible.filter((j) => j.status === 'running');
	let label: string;
	if(running.length > 0) {
		let p = percent(running[0]);
		label = (running.length > 1 ? running.length + ' copies' : 'Copying') + (p !== undefined ? ' · ' + Math.floor(p * 100) + '%' : '...');
	}
	else {
		let failed = visible.some((j) => j.status === 'failed');
		label = failed ? 'A copy failed' : 'Copies done';
	}

	return (
		<Popover positioning="above-end" withArrow>
			<PopoverTrigger disableButtonEnhancement>
				<Button
					appearance="subtle"
					size="small"
					className={s.trigger}
					icon={running.length > 0 ? <Spinner size="extra-tiny" /> : <CheckmarkCircle16Filled className={s.ok} />}
				>
					{label}
				</Button>
			</PopoverTrigger>
			<PopoverSurface className={s.surface} aria-label="Copies">
				<div className={s.head}>
					<Subtitle2>Copies</Subtitle2>
					{visible.some((j) => j.status !== 'running') && <Link onClick={clearFinished}>Clear finished</Link>}
				</div>
				{visible.map((j) => {
					let p = percent(j);
					return (
						<div key={j.id} className={s.job}>
							<div className={s.jobHead}>
								{j.status === 'done' && <CheckmarkCircle16Filled className={s.ok} />}
								{j.status === 'failed' && <ErrorCircle16Filled className={s.bad} />}
								{j.status === 'cancelled' && <DismissCircle16Filled className={s.muted} />}
								<Text className={s.title} title={j.title}>{j.title}</Text>
								<div className={s.actions}>
									{j.status === 'running' && <Button size="small" onClick={() => cancel(j.id)}>Cancel</Button>}
									{j.status === 'done' && j.firstItem && (
										<Button size="small" appearance="subtle" icon={<FolderOpen16Regular />} onClick={() => void window.tib.showInFolder(j.firstItem!)}>
											Show
										</Button>
									)}
									{j.status !== 'running' && (
										<Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove from list" onClick={() => dismiss(j.id)} />
									)}
								</div>
							</div>
							{j.status === 'running' && <ProgressBar value={p} max={1} thickness="medium" />}
							<Caption1 className={j.status === 'failed' ? s.bad : s.muted}>{detail(j)}</Caption1>
						</div>
					);
				})}
			</PopoverSurface>
		</Popover>
	);
}
