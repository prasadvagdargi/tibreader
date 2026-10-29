// Downloads the rclone builds TibReader ships with (the version it was tested with), checks each against
// a pinned SHA-256 and puts it in gui/vendor/rclone/<os>-<arch>/ for electron-builder to bundle
// (electron-builder.yml picks the folder matching the build with ${os}-${arch}).
// Run with: npm run fetch-rclone [win|mac|linux]   (default: this computer's OS; skips what is already there)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.75.1';

// From https://downloads.rclone.org/v1.75.1/SHA256SUMS (PGP-signed by the rclone project)
const BUILDS = {
	'win-x64': { name: 'windows-amd64', sha256: '200eb602c126d82aa38b51e0f6b9ae837473ff99b51278d3f6f837574c494d6e', program: 'rclone.exe' },
	'mac-x64': { name: 'osx-amd64', sha256: '29253d0288b8fbbac46baad6e5f6add6cb01d462c79f10805bbd4631c4cdf82c', program: 'rclone' },
	'mac-arm64': { name: 'osx-arm64', sha256: 'c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f', program: 'rclone' },
	'linux-x64': { name: 'linux-amd64', sha256: '982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab', program: 'rclone' },
};

// The builds each OS's packages need (macOS: Intel and Apple Silicon)
const FOR_OS = { win: [ 'win-x64' ], mac: [ 'mac-x64', 'mac-arm64' ], linux: [ 'linux-x64' ] };

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
const thisOs = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const targetOs = process.argv[2] || thisOs;
if(!FOR_OS[targetOs]) {
	throw new Error('Unknown OS "' + targetOs + '" (use win, mac or linux)');
}

for(const key of FOR_OS[targetOs]) {
	await fetchBuild(key, BUILDS[key]);
}

async function fetchBuild(key, build) {
	const dest = path.resolve(here, '..', 'vendor', 'rclone', key);
	const stamp = path.join(dest, 'VERSION');
	if(fs.existsSync(path.join(dest, build.program)) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION) {
		console.log(`rclone ${VERSION} (${key}) is already in ${dest}`);
		return;
	}

	const zipName = `rclone-v${VERSION}-${build.name}`;
	const url = `https://downloads.rclone.org/v${VERSION}/${zipName}.zip`;
	console.log(`Downloading ${url}`);
	const res = await fetch(url);
	if(!res.ok) {
		throw new Error(`Download failed: HTTP ${res.status}`);
	}
	const zip = Buffer.from(await res.arrayBuffer());

	const actual = crypto.createHash('sha256').update(zip).digest('hex');
	if(actual !== build.sha256) {
		throw new Error(`Checksum mismatch for ${zipName}.zip: expected ${build.sha256}, got ${actual}. Not using it.`);
	}
	console.log(`Checksum OK (${(zip.length / 1048576).toFixed(1)} MB)`);

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tibreader-rclone-'));
	try {
		const zipFile = path.join(tmp, zipName + '.zip');
		fs.writeFileSync(zipFile, zip);
		// Windows 10+ and macOS have a tar that reads zip files; Linux has unzip
		const r = process.platform === 'linux'
			? spawnSync('unzip', [ '-q', zipFile, '-d', tmp ], { stdio: 'inherit' })
			: spawnSync('tar', [ '-xf', zipFile, '-C', tmp ], { stdio: 'inherit' });
		if(r.status !== 0) {
			throw new Error('Could not unpack the zip (exit code ' + r.status + ')');
		}

		fs.mkdirSync(dest, { recursive: true });
		// Only the program and its licence; the zip's READMEs are rclone's whole manual (7 MB)
		const program = path.join(dest, build.program);
		fs.copyFileSync(path.join(tmp, zipName, build.program), program);
		fs.chmodSync(program, 0o755);
		fs.writeFileSync(path.join(dest, 'LICENSE.txt'), MIT_NOTICE);
		fs.writeFileSync(stamp, VERSION + '\n');
		console.log(`rclone ${VERSION} (${key}) is ready in ${dest}`);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
