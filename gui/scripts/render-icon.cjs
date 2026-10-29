// Renders build/icon.svg to build/icon.png (512x512) with Electron, so no image tools are needed.
// macOS packaging needs at least 512x512; electron-builder makes the smaller Windows/Linux sizes from it.
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// The smallest size macOS packaging accepts; larger windows can be cut to the screen's height
const SIZE = 512;
const build = path.resolve(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(build, 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: SIZE,
		height: SIZE,
		useContentSize: true,
		show: false,
		frame: false,
		transparent: true,
		webPreferences: { offscreen: true },
	});
	// The SVG is scaled to fill the window, whatever its own width and height say
	const html = '<html><body style="margin:0;background:transparent">' +
		'<style>html,body{width:' + SIZE + 'px;height:' + SIZE + 'px;overflow:hidden}' +
		'svg{width:' + SIZE + 'px;height:' + SIZE + 'px;display:block}</style>' + svg + '</body></html>';
	await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
	await new Promise((r) => setTimeout(r, 300));
	const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
	const captured = image.getSize();
	if(captured.width !== captured.height || captured.width < SIZE) {
		console.error('Captured ' + captured.width + 'x' + captured.height + ' instead of ' + SIZE + 'x' + SIZE + '; not writing a distorted icon');
		app.exit(1);
		return;
	}
	fs.writeFileSync(path.join(build, 'icon.png'), image.resize({ width: SIZE, height: SIZE }).toPNG());
	console.log('Wrote ' + path.join(build, 'icon.png'));
	app.quit();
});
