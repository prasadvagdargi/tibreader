import { useState } from 'react';
import { Button, Caption1, Link, makeStyles, Text, Title3, tokens } from '@fluentui/react-components';
import { ErrorCircle48Regular, FolderOpen20Regular, HardDrive48Regular, LockClosed48Regular } from '@fluentui/react-icons';
import type { ErrorCode } from '../../../shared/api';
import { friendlyError } from '../errors';
import { baseName } from '../format';
import { TitleBar } from './TitleBar';


const useStyles = makeStyles({
	root: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		backgroundColor: tokens.colorNeutralBackground2,
	},
	body: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '32px',
		backgroundColor: tokens.colorNeutralBackground1,
		borderTop: '1px solid ' + tokens.colorNeutralStroke2,
	},
	card: {
		maxWidth: '520px',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'flex-start',
		gap: '12px',
	},
	icon: {
		color: tokens.colorPaletteRedForeground1,
	},
	iconNeutral: {
		color: tokens.colorNeutralForeground2,
	},
	muted: {
		color: tokens.colorNeutralForeground3,
		wordBreak: 'break-all',
	},
	details: {
		fontFamily: tokens.fontFamilyMonospace,
		fontSize: tokens.fontSizeBase200,
		color: tokens.colorNeutralForeground2,
		backgroundColor: tokens.colorNeutralBackground3,
		borderRadius: tokens.borderRadiusMedium,
		padding: '8px 10px',
		wordBreak: 'break-word',
		whiteSpace: 'pre-wrap',
		width: '100%',
		boxSizing: 'border-box',
	},
	actions: {
		display: 'flex',
		gap: '8px',
		marginTop: '8px',
	},
});


export function ErrorView(props: {
	file: string;
	code: ErrorCode;
	message: string;
	onPick: () => void;
	onBack: () => void;
}) {
	let s = useStyles();
	let [showDetails, setShowDetails] = useState(false);
	let f = friendlyError(props.code);

	let icon = props.code === 'encrypted' ? <LockClosed48Regular className={s.iconNeutral} />
		: props.code === 'disk-image' ? <HardDrive48Regular className={s.iconNeutral} />
		: <ErrorCircle48Regular className={s.icon} />;

	return (
		<div className={s.root}>
			<TitleBar title="TibReader" />
			<div className={s.body}>
				<div className={s.card} role="alert">
					{icon}
					<Title3>{f.title}</Title3>
					<Text>{f.body}</Text>
					<Caption1 className={s.muted}>{baseName(props.file)}</Caption1>
					{showDetails
						? <div className={s.details}>{props.message}</div>
						: <Link onClick={() => setShowDetails(true)}>Show details</Link>}
					<div className={s.actions}>
						<Button appearance="primary" icon={<FolderOpen20Regular />} onClick={props.onPick}>Open another backup...</Button>
						<Button onClick={props.onBack}>Back to start</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
