#!/usr/bin/env node
/**
 * Starts the tibreader MCP server for the Claude Code plugin. A plugin is installed from the source
 * repository, so the first start installs the dependencies and builds dist/ (again whenever the sources
 * are newer than the build). Build output goes to stderr: stdout carries only MCP messages.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const built = path.join(root, 'dist', 'mcp', 'server.js');

function newestSourceTime(dir) {
	let newest = 0;
	for(let item of fs.readdirSync(dir, { withFileTypes: true })) {
		let full = path.join(dir, item.name);
		newest = Math.max(newest, item.isDirectory() ? newestSourceTime(full) : fs.statSync(full).mtimeMs);
	}
	return newest;
}

function run(command) {
	process.stderr.write('tibreader: ' + command + '\n');
	execSync(command, { cwd: root, stdio: [ 'ignore', 2, 2 ] });
}

if(!fs.existsSync(path.join(root, 'node_modules', '.package-lock.json'))) {
	run('npm ci --no-audit --no-fund');
}
if(!fs.existsSync(built) || fs.statSync(built).mtimeMs < newestSourceTime(path.join(root, 'src'))) {
	run('npm run build');
}

require(path.join(root, 'dist', 'cli.js')).main([ 'mcp' ]).then((code) => {
	process.exitCode = code;
});
