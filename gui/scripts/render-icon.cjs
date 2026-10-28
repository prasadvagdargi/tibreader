// Renders build/icon.svg to build/icon.png (256x256) with Electron, so no image tools are needed.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const build = path.resolve(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(build, 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: 256,
		height: 256,
		show: false,
		frame: false,
		transparent: true,
		webPreferences: { offscreen: true },
	});
	const html = '<html><body style="margin:0;background:transparent">' + svg + '</body></html>';
	await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
	await new Promise((r) => setTimeout(r, 300));
	const image = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
	fs.writeFileSync(path.join(build, 'icon.png'), image.resize({ width: 256, height: 256 }).toPNG());
	console.log('Wrote ' + path.join(build, 'icon.png'));
	app.quit();
});
