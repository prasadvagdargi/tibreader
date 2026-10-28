import { useEffect, useState } from 'react';
import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';
import { tib } from './api';


/**
 * Light or dark, as main decides: the Windows setting (Settings > Personalization > Colors), or the
 * app's own Theme choice. Starts from the page's media query to avoid a flash before main answers.
 */
export function useSystemTheme(): { theme: Theme; dark: boolean } {
	let [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

	useEffect(() => {
		void tib.appInfo().then((a) => setDark(a.dark));
		return tib.onEvent((ev) => {
			if(ev.name === 'theme-changed') {
				setDark(ev.dark);
			}
		});
	}, []);

	let theme = dark ? webDarkTheme : webLightTheme;

	// The window's minimize/maximize/close buttons are drawn by Windows; match them to the title bar
	useEffect(() => {
		tib.setTitleBarColors(String(theme.colorNeutralBackground2), String(theme.colorNeutralForeground1));
	}, [theme]);

	return { theme, dark };
}
