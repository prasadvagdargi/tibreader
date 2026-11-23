import fs from 'node:fs';
import path from 'node:path';

/**
 * Version from the package's package.json (searched upwards, so it works from dist/ and test builds)
 */
export function packageVersion(): string {
	let dir = __dirname;
	for(let i = 0; i < 4; i++) {
		let file = path.join(dir, 'package.json');
		if(fs.existsSync(file)) {
			let pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
			if(pkg.name === 'tibreader') {
				return pkg.version;
			}
		}
		dir = path.dirname(dir);
	}

	return 'unknown';
}
