// Downloads the rclone build TibReader ships with (the version it was tested with), checks it against
// a pinned SHA-256 and puts rclone.exe in gui/vendor/rclone/ for electron-builder to bundle.
// Run with: npm run fetch-rclone   (does nothing if the right version is already there)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.75.1';
const NAME = `rclone-v${VERSION}-windows-amd64`;
const URL = `https://downloads.rclone.org/v${VERSION}/${NAME}.zip`;
// From https://downloads.rclone.org/v1.75.1/SHA256SUMS (PGP-signed by the rclone project)
const SHA256 = '200eb602c126d82aa38b51e0f6b9ae837473ff99b51278d3f6f837574c494d6e';

// rclone is MIT licensed; the notice (as on https://rclone.org/licence/) ships with it
const MIT_NOTICE = `rclone ${VERSION} (https://rclone.org), bundled unmodified with TibReader.

Copyright (C) 2019 by Nick Craig-Wood https://www.craig-wood.com/nick/

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.resolve(here, '..', 'vendor', 'rclone');
const stamp = path.join(dest, 'VERSION');

if(fs.existsSync(path.join(dest, 'rclone.exe')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION) {
	console.log(`rclone ${VERSION} is already in ${dest}`);
	process.exit(0);
}

console.log(`Downloading ${URL}`);
const res = await fetch(URL);
if(!res.ok) {
	throw new Error(`Download failed: HTTP ${res.status}`);
}
const zip = Buffer.from(await res.arrayBuffer());

const actual = crypto.createHash('sha256').update(zip).digest('hex');
if(actual !== SHA256) {
	throw new Error(`Checksum mismatch for ${NAME}.zip: expected ${SHA256}, got ${actual}. Not using it.`);
}
console.log(`Checksum OK (${(zip.length / 1048576).toFixed(1)} MB)`);

// Windows 10 and later include tar.exe, which reads zip files
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tibreader-rclone-'));
try {
	const zipFile = path.join(tmp, NAME + '.zip');
	fs.writeFileSync(zipFile, zip);
	const r = spawnSync('tar', ['-xf', zipFile, '-C', tmp], { stdio: 'inherit' });
	if(r.status !== 0) {
		throw new Error('Could not unpack the zip (tar exited with ' + r.status + ')');
	}

	fs.mkdirSync(dest, { recursive: true });
	const from = path.join(tmp, NAME);
	// Only the program and its licence; the zip's READMEs are rclone's whole manual (7 MB)
	fs.copyFileSync(path.join(from, 'rclone.exe'), path.join(dest, 'rclone.exe'));
	fs.writeFileSync(path.join(dest, 'LICENSE.txt'), MIT_NOTICE);
	fs.writeFileSync(stamp, VERSION + '\n');
	console.log(`rclone ${VERSION} is ready in ${dest}`);
}
finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
