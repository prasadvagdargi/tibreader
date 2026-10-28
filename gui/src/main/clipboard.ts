import { spawn } from 'node:child_process';
import path from 'node:path';


/**
 * Fixed PowerShell script: reads a base64 UTF-8 JSON list of paths from stdin and puts them on the
 * clipboard as files (CF_HDROP), so Paste in File Explorer copies them.
 *
 * Paths never appear in the command line or the script: names come from backups and are untrusted.
 * base64 keeps stdin ASCII, so non-English names survive PowerShell's console code page.
 * Windows PowerShell 5.1 (built into Windows) has Set-Clipboard -LiteralPath; PowerShell 7 doesn't.
 */
const SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$ProgressPreference = 'SilentlyContinue'",
	'$b64 = [Console]::In.ReadToEnd().Trim()',
	'$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))',
	'$paths = $json | ConvertFrom-Json',
	'Set-Clipboard -LiteralPath $paths',
].join('; ');

function powershell(): string {
	return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function setClipboardFiles(paths: string[]): Promise<void> {
	if(process.platform !== 'win32') {
		return Promise.reject(new Error('Copying files to the clipboard is only available on Windows'));
	}

	return new Promise((resolve, reject) => {
		let encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
		let child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
			windowsHide: true,
			stdio: ['pipe', 'ignore', 'pipe'],
		});

		let stderr = '';
		child.stderr!.on('data', (d) => { stderr += d.toString(); });
		child.on('error', reject);
		child.on('close', (code) => {
			if(code === 0) {
				resolve();
			}
			else {
				reject(new Error('Could not put the files on the clipboard' + (stderr.trim() ? ': ' + stderr.trim().split('\n')[0] : '')));
			}
		});

		child.stdin!.end(Buffer.from(JSON.stringify(paths), 'utf8').toString('base64'));
	});
}
