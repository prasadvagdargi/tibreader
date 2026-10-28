import type { ReactNode } from 'react';
import { makeStyles, tokens, Text } from '@fluentui/react-components';
import { Archive20Regular } from '@fluentui/react-icons';


const useStyles = makeStyles({
	bar: {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		height: '40px',
		flexShrink: 0,
		paddingLeft: '14px',
		// Room for Windows' minimize / maximize / close buttons
		paddingRight: '150px',
		backgroundColor: tokens.colorNeutralBackground2,
	},
	icon: {
		color: tokens.colorBrandForeground1,
		flexShrink: 0,
	},
	title: {
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	extra: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
});

/**
 * The top strip of the window: it drags the window around and shows what is open
 */
export function TitleBar(props: { title: string; children?: ReactNode }) {
	let s = useStyles();
	return (
		<header className={s.bar + ' app-drag'}>
			<Archive20Regular className={s.icon} />
			<Text weight="semibold" className={s.title}>{props.title}</Text>
			{props.children && <div className={s.extra + ' app-no-drag'}>{props.children}</div>}
		</header>
	);
}
