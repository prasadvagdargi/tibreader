import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The app bundles the library straight from its TypeScript source (see doc/Plan-desktop-app.md)
const library = resolve('../src/index.ts');

/**
 * Strict Content-Security-Policy for the built app. Not used in development, where Vite's dev server
 * needs inline scripts for hot reload. Styles are inline because Fluent UI (Griffel) injects them.
 */
function contentSecurityPolicy(): Plugin {
	let policy = [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: tib-preview:",
		"media-src tib-preview:",
		"font-src 'self' data:",
		"connect-src 'self' tib-preview:",
		"frame-src tib-preview:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join('; ');

	return {
		name: 'tibreader-csp',
		apply: 'build',
		transformIndexHtml(html: string) {
			return html.replace('<head>', '<head>\n\t\t<meta http-equiv="Content-Security-Policy" content="' + policy + '">');
		},
	};
}

export default defineConfig({
	main: {
		resolve: {
			alias: { tibreader: library },
		},
		build: {
			// adler-32 and xml2js (the library's own dependencies) stay external and ship in node_modules
			externalizeDeps: true,
			rollupOptions: {
				// Only the optional FUSE mount needs this, and the app never loads it
				external: ['@cocalc/fuse-native'],
			},
		},
	},
	preload: {
		build: {
			externalizeDeps: true,
		},
	},
	renderer: {
		plugins: [react(), contentSecurityPolicy()],
	},
});
