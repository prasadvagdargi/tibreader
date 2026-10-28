tibreader
=========

**Acronis True Image backup reader.** Read, verify, extract and mount Acronis True Image backup files
(`.tib` and `.tib.metadata`) without True Image. Backup files are only ever opened read-only.

The format is undocumented; everything here is reverse-engineered. See `doc/` for the format notes,
the work log and the to-do list.


Status
------

| Backup type | List files | Read / extract files | Verify | Tested on real files |
|---|---|---|---|---|
| Windows, file/folder backup (True Image 2015 and later) | Yes | Yes, with per-block MD5 checks | Yes | Yes: True Image 25.4 (2024), 55 GB |
| Windows, split over several `.tib` files | Yes | Yes | Yes | No sample yet (covered by generated test files) |
| Windows, incremental chain | Should work | Should work | Should work | No sample yet |
| Mac (all versions) | Should work | Should work | Should work | No (original samples are gone) |
| Windows sector-by-sector (disk image) | No: clear "not supported" error | | | |
| Encrypted backups | Windows: clear "not supported" error. Mac: not detected | | | |
| Windows True Image 2014 and older | Unknown | | | |


Requirements
------------
- Node.js 22 or newer


Install and build
-----------------
```bash
npm install
```
```bash
npm run build
```
```bash
npm test
```


Command line
------------
After building, run the tool with `node dist/cli.js`, or install the `tib` command with `npm install -g .`

```bash
tib info "D:/Backups/MyBackup_full_b1_s1_v1.tib"
```
```bash
tib ls "D:/Backups/MyBackup_full_b1_s1_v1.tib" /G/Pictures -l
```
```bash
tib extract "D:/Backups/MyBackup_full_b1_s1_v1.tib" ./restored /G/Pictures
```
```bash
tib verify "D:/Backups/MyBackup_full_b1_s1_v1.tib"
```
```bash
tib mount "D:/Backups/MyBackup_full_b1_s1_v1.tib" --drive R:
```

| Command | What it does |
|---|---|
| `info <backup>` | Files, backup points, product version, compression, encryption, contents summary |
| `ls <backup> [path]` | List a folder. `-l` details, `-R` everything below, `--json` machine-readable |
| `cat <backup> <path>` | Write one file to standard output |
| `extract <backup> <dest> [path]` | Copy a folder's contents (or one file) into `dest`, keeping modified times. Refuses to overwrite unless `--overwrite` |
| `verify <backup>` | Check every data block (Windows: against its stored MD5). `--quick` checks only the structure |
| `mount <backup> [--drive R:]` | Show the backup as a read-only drive (see below) |

`-s N` / `--slice N` picks the backup point: `1` is the oldest, `-1` (default) the newest.
Windows backups show each backed up drive as a top-level folder: `G:\Pictures` is `/G/Pictures`.
Exit codes: `0` success, `1` error or verification problems, `2` wrong usage.


Mounting as a drive
-------------------
### Windows (recommended): a real drive letter
Install [WinFsp](https://winfsp.dev) and [rclone](https://rclone.org) once (WinFsp asks for administrator
approval), then open a new terminal:
```bash
winget install WinFsp.WinFsp
```
```bash
winget install Rclone.Rclone
```
```bash
tib mount "D:/Backups/MyBackup_full_b1_s1_v1.tib" --drive R:
```
The backup appears as read-only drive `R:` in File Explorer, with no file size limit. Press Ctrl+C (or
close the terminal) to unmount. Tested with a 55 GB backup: a 925 MB file streams at ~27 MB/s and
random-offset reads match the original bytes. If `tib` is ever killed forcibly, also end `rclone.exe`
in Task Manager to remove the drive.

`--drive` also works on macOS and Linux with an empty folder instead of a letter (needs rclone and FUSE).
Set `TIB_RCLONE` if rclone isn't on the PATH.

### Without installing anything: WebDAV
`tib mount` without `--drive` starts a read-only WebDAV server on `http://127.0.0.1:8642/` (this
computer only; `--port` and `--host` change that). Every OS can open it with built-in tools. On
127.0.0.1 it only answers requests addressed to `127.0.0.1`, `localhost` or `[::1]`, so web pages
can't reach it through DNS rebinding. With `--drive`, the server also uses a random secret path.

**Windows**: map it as a drive (File Explorer > This PC > Map network drive), or:
```bash
net use Z: http://127.0.0.1:8642/ /persistent:no
```
Remove it when done with `net use Z: /delete`.

Windows' WebDAV client refuses files larger than 50 MB by default ("The file size exceeds the limit
allowed"). Use `--drive` above, `tib extract` for big files, or raise the limit to the maximum (4 GB)
from an administrator terminal and restart the WebClient service:
```bash
reg add HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters /v FileSizeLimitInBytes /t REG_DWORD /d 4294967295 /f
```
```bash
net stop webclient
```
```bash
net start webclient
```

### macOS and Linux
**macOS**: Finder > Go > Connect to Server > `http://127.0.0.1:8642/`

**Linux**: open `dav://127.0.0.1:8642/` in the file manager, or:
```bash
gio mount dav://127.0.0.1:8642/
```

**Native FUSE (Linux/macOS, optional)**: needs libfuse (Linux) or macFUSE (macOS) and an optional package:
```bash
npm install @cocalc/fuse-native
```
```bash
tib mount backup.tib --fuse ./mnt
```


Desktop app (Windows)
---------------------
`gui/` holds TibReader, a desktop app for people who'd rather not use a command line:
- Open a backup (or drop it on the window) and browse it like File Explorer, at any backup point.
- Copy to... a folder, Copy (Ctrl+C) and paste in Explorer, or drag files out.
- Restore a whole drive or folder, with a choice of what happens to files that are already there.
- Open a file (a read-only copy), or Edit a copy.
- Mount as a drive letter (rclone is bundled; the app offers to install WinFsp, which asks for
  administrator permission once). While mounted, copying and dragging come straight from the drive.
- Search, preview (images, video, audio, text), properties with Windows attributes, Verify, light/dark theme.

| Keys | Does |
|---|---|
| Enter, double-click | Open a folder, or a read-only copy of a file |
| Backspace, Alt+Up | Up one folder |
| Alt+Left / Alt+Right, mouse back/forward | Back / Forward |
| Ctrl+C | Copy, then paste in File Explorer |
| Ctrl+A, Shift/Ctrl+click, Ctrl+Space | Select |
| Ctrl+F | Search this folder and the folders in it |
| Alt+P | Show or hide the details pane |
| Ctrl+O | Open another backup |
| Typing a name | Jump to it |

The backup itself is never changed. Design notes: `doc/Plan-desktop-app.md`.

**Downloads** (from the GitHub releases page), all for 64-bit Windows 10 and 11:

| File | What it is |
|---|---|
| `TibReader-Setup-<version>.exe` | Installer (no administrator needed): Start menu entry, and double-clicking a `.tib` opens it |
| `TibReader-<version>-portable.exe` | One file, nothing installed; keeps its settings in a `TibReader Data` folder beside it (good for a USB stick). Starts slower: it unpacks itself first |
| `TibReader-<version>-win-x64.zip` | The same as a folder: unzip and run `TibReader.exe`; starts instantly; settings beside it too |

The files aren't code-signed yet, so Windows SmartScreen may say "Windows protected your PC": choose
**More info**, then **Run anyway**.

**Building**: `npm run dist` in `gui/` makes all three in `gui/release/` (it downloads the pinned rclone
first, checking its checksum). Pushing a `v<version>` tag does the same on GitHub and creates a draft
release. For mounting while running from source, run `npm run fetch-rclone` once (or have rclone installed).

To run it from source (after `npm install` and `npm run pretest` in the repository root):
```bash
cd gui
```
```bash
npm install
```
```bash
npm run dev
```
`npm run test:e2e` builds the app and drives it with Playwright on synthetic backups. With
`TIB_SAMPLE` set, it also opens that real backup (read-only). The mount tests need WinFsp and rclone,
and the packaged-app test needs `npm run dist` first; otherwise they're skipped.


Library usage
-------------
```ts
import { openArchive } from 'tibreader';

const archive = await openArchive('D:/Backups/MyBackup_full_b1_s1_v1.tib');
try {
	const slice = archive.getSlice();          // latest backup point; getSlice(1) is the oldest
	console.log(slice.creationTime, slice.config);

	const fs = await slice.openFileSystem();
	console.log(await fs.list('/'));           // one folder per backed up drive, e.g. "G"
	const bytes = await fs.read('/G/notes.txt', 0, 1024);
}
finally {
	await archive.close();
}
```

`openArchive` accepts any file of a backup: for Windows, any `NAME_full_b1_s1_v1.tib`-style file
(the other files of the chain must be in the same folder); for Mac, `NAME.tib` or `NAME.tib.metadata`.

Problems that don't stop reading (unknown flags, odd headers) are reported as warnings on stderr.
Use `setWarningHandler()` to collect or silence them. Errors are thrown as `FormatError` (damaged or
unknown data) or `NotSupportedError` (valid but unsupported, e.g. encrypted backups). Both carry a
`code` (`not-a-backup`, `unexpected-name`, `missing-part`, `damaged`, `encrypted`, `disk-image`,
`unsupported`) so programs can explain the problem without parsing the message.

Other helpers (all used by the CLI):

| Function | What it does |
|---|---|
| `extractItems(fs, paths, dest, opts)` | Copy a selection like a file manager (each item as `dest/<name>`); `extract()` copies one folder's contents |
| `opts` of both | `conflict` (`fail`, `overwrite`, `skip`, `rename` or a function), `signal` (cancel; unfinished files are removed, replaced files kept), `onProgress`, `onRenamed` |
| `measure(fs, paths)` | Files, folders and bytes below some paths |
| `verifySnapshot(fs, opts)` / `verifyHeaders(archive)` | Check every data block, with progress, per-file problems and cancel |
| `describeArchive(archive)` | Plain-data summary (what `tib info --json` prints) |
| `WebDavServer`, `RcloneMount`, `findRclone`, `findWinFsp`, `freeDriveLetters` | The pieces behind `tib mount` |


Development
-----------
```bash
npm test
```
runs the unit tests plus end-to-end tests on small synthetic backups that `test/helpers/windows-fixture.ts`
generates (normal, split over several files, corrupted, encrypted, sector-by-sector). To also test against
a real backup (only ever read), point `TIB_SAMPLE` at it, e.g. in PowerShell:
```bash
$env:TIB_SAMPLE = "D:\Backups\MyBackup_full_b1_s1_v1.tib"; npm test
```
CI runs the tests on Linux, macOS and Windows with Node 22 and 24 (`.github/workflows/ci.yml`).

Project notes live in `doc/`: `TODO.md` (open work), `WORKLOG.md` (what was done and why),
`Format-Windows.md` (format details).


Versions
--------

The objective is to support all versions of the file format. The Mac and Windows versions produce quite
different file formats (likely why True Image does not allow cross-OS archive viewing).

Judging by the backwards compatibility information at https://kb.acronis.com/tib, these variants exist
(numbers are True Image version years):
1. Windows `<= 2012`
2. Windows `>= 2013 and <= 2014`
3. Windows `>= 2015 to present` (supported; True Image 25.x confirmed)
4. Mac OS `all years`


Terminology
-----------

Following the True Image documentation (https://kb.acronis.com/content/1772):

1. `Archive`
	- A complete chain/group composed of all backup files over time for a single configuration
	- Composed of `Slice`s
2. `Slice`
	- A single point in time (one full or incremental backup run)
	- Composed of `Volume`s (usually just 1 unless the backup is split into smaller parts)
	- NOTE: In Mac backups, multiple slices may reference the same volume
3. `Volume`
	- A single `.tib` file


License
-------
MIT (see `LICENSE`).

Maintained by [prasadvagdargi](https://github.com/prasadvagdargi). Based on
[dennisss/acronis-tib](https://github.com/dennisss/acronis-tib) by Dennis Shtatnov (2018), whose
original history is kept in this repository.
