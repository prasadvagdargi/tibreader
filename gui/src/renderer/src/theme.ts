import { useEffect, useState } from 'react';
import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';
import { tib } from './api';


/** Light or dark, following Windows (Settings > Personalization > Colors) */
export function useSystemTheme(): { theme: Theme; dark: boolean } {
	let [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

	useEffect(() => {
		let mq = window.matchMedia('(prefers-color-scheme: dark)');
		let onChange = (e: MediaQueryListEvent) => setDark(e.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	}, []);

	let theme = dark ? webDarkTheme : webLightTheme;

	// The window's minimize/maximize/close buttons are drawn by Windows; match them to the title bar
	useEffect(() => {
		tib.setTitleBarColors(String(theme.colorNeutralBackground2), String(theme.colorNeutralForeground1));
	}, [theme]);

	return { theme, dark };
}
