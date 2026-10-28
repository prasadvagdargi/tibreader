Plan: TibReader desktop app (Windows first)
===========================================

Approved 2026-10-27. Work happens on the `desktop-app` branch; progress is ticked in `TODO.md` (section 11)
and each step is recorded in `WORKLOG.md`.

## Context
tibreader is a TypeScript/Node 22 library plus a `tib` CLI that reads Acronis True Image `.tib` backups
(Windows file/folder backups fully work and are tested on a real 55 GB backup; Mac backups "should work").
Everything is command line today, which is hard for normal users. The goal is a clean, portable Windows app
where someone can open a backup, browse it like File Explorer, and get files out easily: copy/paste and drag
to Explorer, copy a folder or a whole backed-up drive somewhere ("clone"), open or edit a copy, and mount
the backup as a drive letter. Backups stay read-only (the library never writes `.tib` files): "move" and
"edit" mean working on copies. Other OSes come later; the stack is chosen so that stays cheap.

Decisions made with the maintainer:
- **Electron + Fluent UI React v9** (Windows 11 look, light/dark from the system).
- **Read-only backups**: copy out, edit copies.
- **Mounting**: bundle `rclone.exe`; if WinFsp (driver, needs admin once) is missing, offer one-click install.
  Copy/paste must work without mounting.
- **Packaging**: portable single `.exe`, portable zip, and an NSIS installer (Start menu + `.tib` association).

## Architecture
```
gui/                      own package.json; root library stays dependency-free
  electron.vite.config.ts  main / preload / engine / renderer builds
  electron-builder.yml     nsis + portable + zip (x64), extraResources rclone, .tib association
  scripts/fetch-rclone.mjs downloads pinned rclone (v1.75.1, the tested version), checks SHA256 -> vendor/ (gitignored)
  src/shared/api.ts        typed IPC contract (requests, events, DTOs) shared by all processes
  src/main/                windows, menus, native dialogs, clipboard, shell, startDrag, settings, single instance
  src/engine/              utilityProcess: sessions (open archives), jobs, WebDAV server, rclone mount
  src/preload/             contextBridge -> window.tib (typed)
  src/renderer/            React + Fluent UI app
```
- **Three processes.**
  - *Main*: OS integration only (async dialogs, clipboard, `shell.openPath`, `webContents.startDrag`,
    single-instance lock, file association/argv, settings).
  - *Engine* (`utilityProcess.fork`, **one per open backup**): imports the library and owns that archive,
    one cached `SnapshotFS` per slice (`openFileSystem()` rebuilds the tree each call), its jobs, `WebDavServer`
    and `RcloneMount`. One process per backup means a crash or a long verify in one backup doesn't affect
    another. Main keeps a `sessionId -> process` map. The entry is imported with electron-vite's `?modulePath` suffix.
  - *Renderer*: UI only (sandbox on, contextIsolation on, no nodeIntegration, strict CSP).
- **Why the engine runs in its own process**:
  - Decompression and MD5 are synchronous and would freeze the UI.
  - The mounted drive is served by whichever process runs the WebDAV server. Windows drag-out
    (`startDrag` runs a modal DoDragDrop loop on main) and Explorer pastes read from that drive, so a
    server inside main could deadlock. This is the same issue noted in `src/mount/rclone.ts`.
- **Library linking**: the engine imports the library from source (Vite alias `tibreader` -> `../src/index.ts`)
  and bundles it, so the packaged app needs no `node_modules` and avoids `file:..` symlink packaging problems.
  The optional `@cocalc/fuse-native` require is marked external.
- **Bundled rclone**: the engine sets `process.env.TIB_RCLONE` to `resources/rclone/rclone.exe`. That is
  the existing lookup in `findRclone()` (`src/mount/rclone.ts`).
- **Engine crash safety**: the engine reports rclone's PID to main, and main kills it if the engine dies.
  A PID file in app data lets the next start clean up orphaned mounts. It kills only if that PID is still
  `rclone.exe` from our resources folder, so a reused PID is never touched.

## Library changes (`src/`, with tests in `test/`)
Reuse first; the CLI keeps identical output (`test/cli.test.ts` guards it).
1. `src/fs/extract.ts`:
   - `ExtractOptions` gains `signal?: AbortSignal`, `onProgress?(p: {files, bytes, path})` (throttled by the caller),
     `conflict?: 'fail'|'overwrite'|'skip'|'rename' | ((entry, dest) => Promise<'overwrite'|'skip'|'rename'|'abort'>)`
     (`overwrite: true` stays an alias), and `onRenamed?(original, safe)` (Mac names made Windows-safe by `safeFileName`).
   - On cancel or error it deletes the partly written file.
   - New `extractItems(snapshot, paths[], destDir, opts)` writes each selected item as `destDir/<name>`.
     Plain `extract()` puts a folder's *contents* into `destDir`, which is wrong for "copy this folder".
   - New `measure(snapshot, paths[]) -> {files, directories, bytes}` gives progress totals. It moves
     `countContents` out of `src/cli.ts`.
2. New `src/verify.ts`: `verifySnapshot(snapshot, {signal, onProgress, onProblem}) -> {files, bytes, problems[], unstored}`
   plus header checks. It moves the loop out of `cmdVerify` in `src/cli.ts` (uses `WindowsFS.verifyFile`, else reads every block).
3. New `src/info.ts`: `describeArchive(archive)`, the structure `cmdInfo` builds today (format, volumes, slices,
   config, counts). The CLI's `--json` and the app's Info panel both use it.
4. `src/mount/rclone.ts`:
   - `findWinFsp(): Promise<string|null>` checks `%ProgramFiles(x86)%\WinFsp\bin\winfsp-x64.dll`, with the registry
     `HKLM\SOFTWARE\WOW6432Node\WinFsp\InstallDir` as fallback.
   - `RcloneMount.mount()` throws a clear `NotSupportedError` when WinFsp is missing, which helps the CLI too.
   - `freeDriveLetters(): Promise<string[]>` (async checks only).
   - `RcloneMount` exposes `pid`.
5. `src/mount/webdav.ts` hardening. Today any Host header is accepted, so a web page could read an open
   backup through DNS rebinding. Add `WebDavServer(fs, {basePath?})`:
   - Reject requests whose `Host` isn't `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (when bound to loopback).
   - Serve only under a random secret `basePath` (e.g. `/<32 hex>/`); rclone gets that URL.
   - The CLI turns on the Host check too, with tests in `test/extract-webdav.test.ts`.
   - The app starts the server lazily, on the first preview or mount.
6. `src/errors.ts`: optional `code` on `FormatError`/`NotSupportedError` (`'encrypted'`, `'disk-image'`,
   `'missing-part'` from `src/win/archive.ts`, `'unexpected-name'` for renamed files, `'damaged'` default), set at
   the existing throw sites in `src/win/slice.ts` / `src/win/archive.ts`, so the app never parses message text.
7. `src/index.ts`: export `extract`, `extractItems`, `measure`, `safeFileName`, `verifySnapshot`, `describeArchive`,
   `WebDavServer`, `RcloneMount`, `findRclone`, `findWinFsp`, `freeDriveLetters`, `normalizeDriveTarget`.

## IPC contract (`gui/src/shared/api.ts`)
- **Requests**:
  - Sessions: `openBackup(file) -> {sessionId, info}`, `closeBackup(id)`, `setSlice(id, n)`.
  - Browsing: `list(id, path) -> FsEntryDTO[]`, `stat`, `entryMeta(id, path)` (attributes, created).
  - Search: `search(id, query) -> jobId` (streams results).
  - Jobs:
    - `startCopy(id, paths[], dest, policy) -> jobId`
    - `startRestore(id, path, dest, policy) -> jobId`
    - `stage(id, paths[]) -> {jobId, files}` (temp copies for clipboard/drag/open)
    - `startVerify(id) -> jobId`
    - `cancelJob(jobId)`, `answerConflict(jobId, choice, applyToAll)`
  - Mounting: `mount(id, letter) -> {letter}`, `unmount(id)`, `mountStatus() -> {rclone, winfsp, freeLetters, mounts[]}`.
  - `previewUrl(id, path)`.
- **Events**: `job:progress {jobId, files, bytes, totalFiles, totalBytes, speed, current}`, `job:conflict`,
  `job:done {result|error}`, `search:results`, `mount:changed`, `warning` (from `setWarningHandler`).
- **Main-only**: `pickBackupFile`, `pickFolder`, `copyToClipboard(paths)`, `startDrag(paths)`, `openPath`,
  `showInFolder`, `installWinFsp`, `getSettings/setSettings`, `recent`.
- **Previews**: a custom `tib-preview://` protocol in main, registered as privileged with `stream`, `secure` and
  `supportFetchAPI` so video can seek. It forwards Range requests via `net.fetch` to the engine's loopback
  `WebDavServer` (already supports ranged GET; uses the secret base path), so images, video and PDFs stream
  with no temp files.
- **Errors**: shaped `{kind: 'format'|'notSupported'|'io'|'conflict', message}` so the UI can explain them in plain words.

## Copy, paste, drag, open: how it works on Windows
- **When the backup is mounted**, the files already exist at `R:\G\...`, so clipboard, drag and open use those
  paths directly. This is instant at any size and goes through the engine process, so nothing deadlocks.
- **When it isn't mounted**, the app stages the selection into `%TEMP%\TibReader\<session>\` with a progress
  toast, then:
  - **Clipboard** (Ctrl+C, then paste in Explorer): spawn the built-in Windows PowerShell 5.1
    (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <fixed script>`).
    The fixed script reads the paths as JSON from **stdin** and calls `Set-Clipboard -LiteralPath $paths`, which sets
    a real multi-file CF_HDROP.
    - Names come from the backup and are untrusted, so they are never put on the command line.
    - Checked on this machine: 5.1 has `-LiteralPath`; PowerShell 7 dropped it.
    - Electron's own clipboard can't write file lists.
  - **Drag out**: the renderer's `dragstart` calls `preventDefault()` and asks main to drag.
    - If the paths are mounted or already staged, main calls `webContents.startDrag({files, icon})` right away.
    - Otherwise small selections (< ~200 MB) are staged first, and the drag starts while the mouse button is still
      held. Larger ones show "Use Copy to... or mount the backup for big drags".
    - Prototype this early in M3: it's the least certain piece.
  - **Open**: stage and `shell.openPath` (read-only copy). Staged files are marked read-only and deleted on exit
    or next start.
- **Edit a copy**: ask for a folder (default `Documents\TibReader`), extract there, open it, then show a toast:
  "You're editing a copy. The backup is unchanged."

## UI (Fluent 2, follows the system light/dark theme)
- **Welcome**:
  - A large drop zone ("Drop a .tib file here") with an **Open backup...** button.
  - Recent backups (name, folder, last opened; a missing file is flagged).
- **Backup window**, styled like File Explorer:
  - Custom title bar (`titleBarOverlay`): backup name and a **backup point** picker (date, full/incremental).
  - Command bar: Back/Forward/Up, breadcrumb, search (Ctrl+F); primary **Copy to...**; **Open**;
    **Mount as drive** toggle with a letter menu and a "Mounted as R:" chip (Open in Explorer / Unmount);
    an overflow menu with Restore drive..., Verify, Backup info, Settings.
  - Left: folder tree with backed-up drives at the top, loaded lazily.
  - Center: virtualized details list built from Fluent `Table` primitives with `@tanstack/react-virtual`
    (Fluent's DataGrid isn't virtualized). Columns: Name / Date modified / Type / Size.
    It supports sorting, multi-select, keyboard use (Enter, Backspace, Alt+arrows, Ctrl+A/C, Space to preview)
    and a right-click menu: Open, Edit a copy, Copy, Copy to..., Restore..., Show in mounted drive, Properties.
  - Right (toggle): preview (image/text/PDF/video) and properties (size, dates, attributes from `entryMeta`).
  - Status bar: item count, selection size, and a jobs button. The jobs flyout shows progress, speed, ETA,
    Cancel and Open destination.
- **Dialogs**:
  - Copy to (native folder picker plus a conflict policy).
  - Restore wizard ("clone"): pick a drive or folder, a destination and options, see a summary, then watch progress.
  - Conflict prompt: Replace / Skip / Keep both, with "do this for all".
  - Verify: progress, failed files, and Save report.
  - Mount: letter picker, rclone/WinFsp status, and **Install WinFsp** (`winget install -e --id WinFsp.WinFsp`
    with UAC; falls back to opening winfsp.dev).
  - Settings: theme, default folder, conflict policy, preferred drive letter.
- **Friendly errors**: encrypted backup, disk image (sector-by-sector), a missing part of a split backup
  ("put all parts in the same folder"), a damaged backup (suggest Verify).
- **App behavior**: single instance. Double-clicking a `.tib` (installer association) or dropping one on the
  window opens it in a new tab or window.
- **Settings and data location**: `%APPDATA%\TibReader` for the installer. Next to the exe for the portable
  builds: electron-builder's `PORTABLE_EXECUTABLE_DIR`, or a `portable` marker file in the zip.
  The path is set with `app.setPath('userData')` before `ready`.

## Packaging and release
- `gui/electron-builder.yml`:
  - appId `io.github.prasadvagdargi.tibreader`, productName `TibReader`.
  - win targets `nsis`, `portable`, `zip` (x64).
  - `extraResources` with `vendor/rclone/rclone.exe` and its license.
  - `fileAssociations` for `.tib` (nsis).
  - nsis set to per-user, not one-click, with a choosable folder.
- Electron: latest stable that ships Node >= 22 (the library's `engines`).
- New `.github/workflows/release.yml`: on a `v*` tag, on windows-latest, it runs `npm ci` (root and gui),
  the root tests, `fetch-rclone`, then `electron-builder --win`, and uploads all three artifacts to a GitHub Release.
- `ci.yml` gains a gui job that typechecks, builds and runs the e2e tests on Windows.
- Unsigned for now; README notes the SmartScreen "More info > Run anyway" step.
- `.gitignore`: add `gui/vendor/` and `gui/release/`. electron-vite's `out/` is already ignored.
- Docs: a README section "Desktop app"; `doc/TODO.md` gets a GUI section; `doc/WORKLOG.md` gets an entry.

## Milestones (each one shippable)
1. **Library groundwork**: extract options, `extractItems`, `measure`, `verifySnapshot`, `describeArchive`,
   `findWinFsp`, `freeDriveLetters`, WebDAV Host check and secret path, error codes, and the exports. The CLI is refactored onto them, and tests pass.
2. **App skeleton**: the `gui/` scaffold, the engine utilityProcess, the typed IPC, Welcome screen, open and
   browse (tree, list, breadcrumb, backup point picker), Info panel, and friendly errors.
3. **Getting files out**: Copy to... / Restore wizard with the jobs flyout, cancel and conflicts; Open and
   Edit a copy; staging, Ctrl+C clipboard and drag-out.
4. **Mount**: bundled rclone, WinFsp detection and install, letter picker; clipboard, drag and open use the
   mounted paths; clean unmount on quit or crash.
5. **Polish**: preview pane, search, Verify dialog, properties with attributes, keyboard shortcuts,
   Settings, recent files, and real file-type icons (`app.getFileIcon`).
6. **Packaging**: all three targets, `.tib` association, single instance, portable data folder, release
   workflow, docs.

## Verification
- `npm test` (root): new unit tests for extract cancel/progress/conflict/rename, `extractItems`, `measure`,
  `verifySnapshot` (corrupted fixture reports the bad file) and `describeArchive`; CLI output unchanged.
- GUI end to end with Playwright's `_electron.launch` (in `gui/test/e2e`) on synthetic backups. The backups
  come from `writeWindowsBackup()` / `standardEntries()` in `test/helpers/windows-fixture.ts`; the e2e tests import
  the compiled `build/test/helpers/windows-fixture.js` after `tsc -p tsconfig.test.json`. Variants: normal, split,
  corrupted, encrypted, sector-by-sector, no-data file. Checks:
  - open, browse, check the names and sizes shown
  - Copy to a temp folder and compare bytes and mtimes
  - cancel midway: no partial file left
  - conflict "Keep both"
  - Verify on the corrupted fixture lists the bad file
  - encrypted and disk image show the friendly error
- **Manual on this machine with the real 55 GB backup (`TIB_SAMPLE`, only read)**:
  - browse
  - copy a 925 MB file via Ctrl+C / paste in Explorer
  - drag a small file out to Explorer
  - mount as R:, open in Explorer, unmount
  - kill the app from Task Manager and confirm the next start removes the stale drive
  - Restore a whole drive folder and compare it with the original
- **Packaging**: run the portable exe from a different folder or USB stick (settings land beside it);
  install with NSIS and double-click a `.tib`; uninstall cleanly.

## Risks
- **WinFsp needs admin once**: mounting is optional and copy/paste works without it.
- **SmartScreen on unsigned builds**: documented; code signing later.
- **Portable single exe starts slowly**: it unpacks on every launch. The zip build starts instantly.
- **Huge folders** (100k+ entries): virtualized list; listings come from the engine's in-memory tree.
- **Long paths (> 260 characters) on restore**: Node handles them; the summary warns that Explorer may not.
- **Staging doubles disk use for big copies**: large clipboard copies suggest Copy to... or mounting instead.
- **Restoring into a folder that isn't empty**: the wizard warns and the conflict policy applies. Nothing is
  ever deleted at the destination.
- **Untrusted names from backups**: they go through `safeFileName`, and are never interpolated into shell
  commands (clipboard uses stdin; `shell.openPath` takes the path directly).
- **Loopback server exposure**: Host check plus a secret base path (library change 5). The server binds only
  to 127.0.0.1 and runs only while needed.
