import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built app (run "npm run build" first; "npm run test:e2e" does both)
export default defineConfig({
	testDir: 'test/e2e',
	timeout: 60_000,
	workers: 1,
	reporter: [['list']],
	outputDir: 'test-results',
});
