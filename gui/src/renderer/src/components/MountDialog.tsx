import { useCallback, useEffect, useState } from 'react';
import {
	Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Dropdown, Field, makeStyles,
	MessageBar, MessageBarBody, MessageBarTitle, Option, Spinner, Text, tokens,
} from '@fluentui/react-components';
import type { MountInfo, MountStatus } from '../../../shared/api';
import { call, errorMessage, tib } from '../api';
import { formatDate } from '../format';


const useStyles = makeStyles({
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: '14px',
	},
	muted: {
		color: tokens.colorNeutralForeground3,
	},
	letter: {
		minWidth: '120px',
		maxWidth: '160px',
	},
});

const LETTER_KEY = 'tibreader.driveLetter';

function preferredLetter(): string | null {
	try {
		return window.localStorage.getItem(LETTER_KEY);
	}
	catch(e) {
		return null;
	}
}

function rememberLetter(letter: string) {
	try {
		window.localStorage.setItem(LETTER_KEY, letter);
	}
	catch(e) {
		// Not important
	}
}

function pickLetter(free: string[]): string {
	let pref = preferredLetter();
	if(pref && free.includes(pref)) {
		return pref;
	}
	return free.includes('R:') ? 'R:' : free[0] || '';
}


/**
 * Mount a backup point as a read-only drive letter (rclone + WinFsp), offering to install WinFsp
 */
export function MountDialog(props: {
	open: boolean;
	sessionId: string;
	slice: number;
	sliceCreated: string;
	onClose: () => void;
	onMounted: (info: MountInfo) => void;
}) {
	let s = useStyles();
	let [status, setStatus] = useState<MountStatus | null>(null);
	let [letter, setLetter] = useState('');
	let [phase, setPhase] = useState<'idle' | 'checking' | 'installing' | 'mounting'>('checking');
	let [problem, setProblem] = useState<string | null>(null);
	let [sentToWebsite, setSentToWebsite] = useState(false);

	let refresh = useCallback(async () => {
		setPhase('checking');
		try {
			let st = await call(props.sessionId, 'mountStatus');
			setStatus(st);
			setLetter((cur) => (cur && st.freeLetters.includes(cur) ? cur : pickLetter(st.freeLetters)));
		}
		catch(e) {
			setProblem(errorMessage(e));
		}
		setPhase('idle');
	}, [props.sessionId]);

	useEffect(() => {
		if(props.open) {
			setProblem(null);
			void refresh();
		}
	}, [props.open, refresh]);

	let install = async () => {
		setProblem(null);
		setPhase('installing');
		let r = await tib.installWinFsp();
		if(!r.ok) {
			setProblem(r.error.message);
			setPhase('idle');
			return;
		}
		if(r.value === 'website') {
			setSentToWebsite(true);
			setPhase('idle');
			return;
		}
		await refresh();
	};

	let mount = async () => {
		setProblem(null);
		setPhase('mounting');
		try {
			let info = await call(props.sessionId, 'mount', props.slice, letter);
			rememberLetter(letter);
			props.onMounted(info);
		}
		catch(e) {
			setProblem(errorMessage(e));
		}
		setPhase('idle');
	};

	let ready = status !== null && status.rclone && status.winfsp && status.freeLetters.length > 0;
	// Checking doesn't count: something in a dialog must stay focusable when it opens, or Fluent's focus
	// trap treats the dialog as inactive and hides it from screen readers (aria-hidden)
	let busy = phase === 'installing' || phase === 'mounting';

	return (
		<Dialog open={props.open} onOpenChange={(_e, d) => { if(!d.open && !busy) { props.onClose(); } }}>
			<DialogSurface style={{ maxWidth: '520px' }}>
				<DialogBody>
					<DialogTitle>Mount as a drive</DialogTitle>
					<DialogContent className={s.content}>
						<Text>
							See this backup in File Explorer as a read-only drive letter. Any app can open files from it,
							and copying from it has no size limit.
						</Text>

						{phase === 'checking' && <Spinner size="tiny" label="Checking..." labelPosition="after" />}

						{status && !status.winfsp && phase !== 'checking' && (
							<MessageBar intent="warning" layout="multiline">
								<MessageBarBody>
									<MessageBarTitle>WinFsp is needed</MessageBarTitle>
									{sentToWebsite
										? 'Install WinFsp from the page that just opened, then choose Check again.'
										: 'Drive letters need WinFsp, a free driver. Installing it asks for administrator permission once.'}
								</MessageBarBody>
							</MessageBar>
						)}

						{status && !status.rclone && (
							<MessageBar intent="error">
								<MessageBarBody>This copy of TibReader is missing rclone, which mounting needs. Download TibReader again.</MessageBarBody>
							</MessageBar>
						)}

						{status && status.freeLetters.length === 0 && (
							<MessageBar intent="error">
								<MessageBarBody>Every drive letter is in use. Disconnect a drive, then try again.</MessageBarBody>
							</MessageBar>
						)}

						{ready && (
							<Field label="Drive letter" hint={'Shows the backup as it was on ' + formatDate(Date.parse(props.sliceCreated)) + '. The drive goes away when you close this backup.'}>
								<Dropdown
									className={s.letter}
									value={letter}
									selectedOptions={[letter]}
									onOptionSelect={(_e, d) => d.optionValue && setLetter(d.optionValue)}
									disabled={busy}
								>
									{status!.freeLetters.map((l) => <Option key={l} value={l}>{l}</Option>)}
								</Dropdown>
							</Field>
						)}

						{phase === 'installing' && <Spinner size="tiny" label="Installing WinFsp... Windows will ask for permission." labelPosition="after" />}
						{phase === 'mounting' && <Spinner size="tiny" label={'Mounting as ' + letter + '...'} labelPosition="after" />}

						{problem && (
							<MessageBar intent="error" layout="multiline">
								<MessageBarBody>{problem}</MessageBarBody>
							</MessageBar>
						)}
					</DialogContent>
					<DialogActions>
						{status && !status.winfsp && !sentToWebsite && (
							<Button appearance="primary" disabled={busy} onClick={() => void install()}>Install WinFsp</Button>
						)}
						{status && !status.winfsp && sentToWebsite && (
							<Button appearance="primary" disabled={busy} onClick={() => void refresh()}>Check again</Button>
						)}
						{(!status || status.winfsp) && (
							<Button appearance="primary" disabled={!ready || busy || phase === 'checking' || !letter} onClick={() => void mount()}>Mount</Button>
						)}
						<Button disabled={busy} onClick={props.onClose}>Cancel</Button>
					</DialogActions>
				</DialogBody>
			</DialogSurface>
		</Dialog>
	);
}
