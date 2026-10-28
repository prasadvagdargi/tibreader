Work log
========

Step-by-step notes on the `modernize-and-fixes` branch, newest last. The open items live in `TODO.md`.


2026-10-27: review
------------------
- Read the whole code base (~2,700 lines of TypeScript, untouched since November 2018).
- Found 8 bugs, a missing entry point/CLI, no tests, an abandoned native FUSE dependency,
  Node 10-era tooling and unsafe handling of untrusted files. Full list is in `TODO.md`.


2026-10-27: decisions
---------------------
- **Test data.** The original sample bucket (`gs://acronis-tib/samples`) returns 403 for every file.
  The only real backup available is a 55 GB Windows file-level backup (True Image 25.4) on the
  maintainer's machine. It is opened **read-only** and never copied, moved or committed.
  Tests that need it run only when the `TIB_SAMPLE` environment variable points at it.
- **Mounting.** `fuse-bindings` is abandoned and needs native compilation. Windows mounting is a
  requirement, so the mount is rebuilt as:
  1. a built-in read-only WebDAV server (pure JavaScript; Windows maps it as a drive, macOS and Linux
     mount it natively), and
  2. an optional native FUSE mount on Linux/macOS through `@cocalc/fuse-native`, loaded only if the user
     installs it, because it has no OS restriction and would try (and fail) to compile on Windows.
- **Unknown format areas** (sector-by-sector, encryption, Mac owners/permissions) fail with clear
  `NotSupportedError`s and are documented rather than guessed.
- **Git.** Work happens on `modernize-and-fixes`, in small commits pushed to `origin` as they land.
  Commits use the GitHub noreply address because the account's email is private (GitHub rejected
  the first push with GH007).


2026-10-27: steps done
----------------------
1. Fixed the five worst bugs (commit "Fix five bugs found in review").
2. Installed Node 24.22.1 LTS (portable, user folder, checksum verified).
3. Rewrote the readers, decompression and search (commit "Rewrite low-level readers...").
   - zlib's one-shot API reports exactly how many compressed bytes it used, even with data after the
     stream, so stream ends are found without the old flush loop.
4. Moved to npm, TypeScript 7 strict, Node 22+ (commit "Move to npm, TypeScript 7...").
   The old FUSE code was removed in this step and comes back as the new mount.
5. Opened the real Windows backup with the parser: it opens in ~75 ms, reads the config and all
   9,212 listing entries. Reverse-engineered how file data is linked (see `Format-Windows.md`).
6. Windows file reading, shared file-system view, block cache, resource cleanup.
   Checked against the real backup (read-only):
   - 8,538 files and 675 folders; total size matches the listing exactly (56,672,748,844 bytes)
   - 4,211 blocks from 40 files spread across all sizes match their stored MD5s (~48 MB/s)
   - random-offset reads equal sequential reads; reads past the end are clamped
   - an extracted 25 MB zip passes its own CRC checks for all 66 entries; extracted JPEGs decode
   - backup time read from the config record (2024-06-22 00:30:07 UTC) matches the file's write time
   Extracted copies were written to a temporary folder and deleted afterwards.
7. `tib` CLI, safe extraction, WebDAV mount and optional FUSE mount. Checked on the real backup:
   - `info`, `ls -l`, `verify --quick` work; wrong usage exits 2, errors exit 1
   - extracting `/G/Movies` (546 files) gives exact sizes and modified times; a second run refuses to
     overwrite; `cat` output equals the extracted file
   - WebDAV: OPTIONS, PROPFIND, ranged GET, 416 for bad ranges, 403 for writes, 400 for `..` paths
   - **Windows drive**: `net use T: http://127.0.0.1:8642/` started the WebClient service and mapped
     the backup; Windows listed folders with correct dates and copied a file identical to `cat`
   - Windows' WebDAV client refuses files over 50 MB by default (`FileSizeLimitInBytes` = 50000000 on
     this machine; a 108 MB copy failed). Documented the registry fix and the WinFsp + rclone route;
     both need admin rights so they weren't applied.
   - Files were first advertised as read-only; Windows kept that flag on copies, so they're now shown
     with the normal archive attribute (the server still refuses all writes).
   - Drive roots have no stored time; they now show the backup time instead of 1970.
8. Tests and CI (53 tests, built-in `node:test`, no extra dependencies):
   - `test/helpers/windows-fixture.ts` writes valid synthetic Windows backups from scratch (header
     checksum, blocks with MD5 index, metadata records, config, listing, trailer, footer, optional
     split into volumes). Covers the multi-volume bug, missing volumes, corrupted blocks, encrypted and
     sector-by-sector refusals, and non-backup files.
   - Every test that opens files deletes its temp folder afterwards; on Windows that fails if a file
     handle leaked, so the suite doubles as a leak check.
   - Mac logic is tested with a stub volume (tree building; reads at every offset across blocks,
     the case the old FUSE bug broke).
   - CLI tested by running it (exit codes, extract/overwrite, verify catching a corrupted block).
   - `TIB_SAMPLE=<file>` runs an extra test against a real backup; passes on the 55 GB sample.
   - GitHub Actions: Linux, macOS, Windows x Node 22, 24.
9. Cleanup: parser `assert`s now throw `FormatError` through a `check()` helper; Mac format notes
   written up from the code (`Format-Mac.md`, unverified); samples README fixed (`/opt/acronis`,
   dead sample bucket noted); `samples/extract_data.bat` now saves each backup like the Mac script.
10. Windows drive without the 50 MB limit. With the maintainer's approval, installed WinFsp 2.1 (admin
    prompt) and rclone 1.75.1 with winget (both installer hashes verified by winget).
    - `rclone mount :webdav: R: --webdav-url http://127.0.0.1:8642/ --read-only` over `tib mount` gave
      a real drive: the 108 MB file Windows' WebDAV client refused, and the 925 MB largest file, streamed
      byte-identical to direct reads (~22-27 MB/s); seeks at 5 offsets matched; writes are refused
      ("The media is write protected"); killing rclone removes the drive.
    - Built in as `tib mount <backup> --drive R:` (`src/mount/rclone.ts`): WebDAV on a free loopback
      port, rclone as a child process, unmount on Ctrl+C. rclone is found on PATH, in winget's links or
      package folder (winget only adds it to the user PATH, which running programs don't see), or via
      `TIB_RCLONE`.
    - Lesson: the process serving the drive must never touch it with synchronous file calls; that
      blocks the WebDAV server and deadlocks. Readiness checks use async calls.
    - If `tib` is killed forcibly, rclone keeps the (dead) drive until it's ended too; documented.
11. Full `tib verify` of the whole 55 GB backup: 8,537 of 8,538 files passed every MD5 check (21.5 min,
    ~42 MB/s). The one failure was a new record index kind (0x0007) that stores no data blocks; it is
    now read as zeros with a warning, and `verify` reports it in its summary instead of failing.
12. Moved to its own repository, at the maintainer's request:
    - Created https://github.com/prasadvagdargi/tibreader (public, not a fork) and pushed `master` with
      the full history: the 13 original commits (authorship kept) and this work, fast-forwarded from
      `modernize-and-fixes`.
    - Package renamed to `tibreader`; repository/homepage/author point to the new repo; Dennis Shtatnov
      stays credited in `LICENSE`, `package.json` contributors and the README.
    - The old fork was renamed to `acronis-tib-reader-old-fork`, its description points to the new
      repo, and it is archived (read-only; can be unarchived).
    - The pull request to dennisss/acronis-tib (#4) had already been closed by its author, unmerged.
    - Local remotes: `origin` = tibreader, `old-fork` = the archived fork; `upstream` removed.


2026-10-27: comparison with acronis-tib-reader
----------------------------------------------
- Cloned https://github.com/TreadingTheTiber/acronis-tib-reader (Python, MIT, v0.3.0, commit `e786c68`)
  to `../tib-reader` and read its code and docs. Nothing from it was run.
- Its "FS-mode hybrid `.tib`" is our Windows file/folder format. It walks the backup in order and matches
  files to names by size; our Listing -> RecordIndex route is exact. Its True Image 2016 sample suggests
  the format hasn't changed since 2016.
- It reads two formats we can't: sector-by-sector `.tib` (modern and 2014-2016 legacy chunk maps) and
  `.tibx` (True Image 2020+), plus NTFS inside disk images. All documented from real files.
- Found that True Image 2010-2013 headers (version 1, length `0x20`) would be sent to our Mac parser.
- Plan, risks and what not to copy: `Plan-tib-reader.md`; items added to `TODO.md`.


2026-10-27: desktop app plan
----------------------------
- Goal from the maintainer: a clean, portable GUI so anyone can open a backup, browse it, and copy,
  paste, drag, restore ("clone") or open/edit copies of files. Windows first; other OSes later.
- Decisions:
  - Electron + Fluent UI React v9, in a new `gui/` folder, so the library stays dependency-free and the
    app calls it directly (no CLI parsing).
  - Backups stay read-only; "move" and "edit" mean working on copies.
  - rclone is bundled; WinFsp (a driver that needs admin once) gets a one-click install offer.
  - Three packages: portable exe, zip, NSIS installer.
- Findings that shaped the plan:
  - Decompression and MD5 checks are synchronous, so the library runs in a separate Electron
    `utilityProcess` (one per open backup), never in the UI or main process. This also avoids the
    same-process deadlock noted in `src/mount/rclone.ts` when Explorer reads a mounted drive during a drag.
  - `WebDavServer` accepted any `Host` header, so a web page could read an open backup through DNS
    rebinding. The plan adds a Host check and a secret base path (helps the CLI too).
  - Electron can't put a list of files on the Windows clipboard. Windows PowerShell 5.1's
    `Set-Clipboard -LiteralPath` can (checked here; PowerShell 7 dropped it). Paths go in through stdin
    because names from a backup are untrusted.
- Full plan: `Plan-desktop-app.md`; milestones in `TODO.md` section 11. Work on the `desktop-app` branch,
  committed and pushed after each step.


2026-10-27: desktop app, M1 (library groundwork)
------------------------------------------------
1. `extract()` gained `conflict` (fail/overwrite/skip/rename or a function), `signal` (cancel),
   `onProgress` and `onRenamed`; the result also counts `skipped`.
   - A cancelled or failed file is removed.
   - An overwrite writes next to the original and renames over it at the end, so cancelling keeps
     the original.
   - "rename" picks `name (2).ext` like Explorer.
2. New `extractItems()`, which copies a selection like a file manager (folders included), and `measure()`.
3. `verifySnapshot()`/`verifyHeaders()` (`src/verify.ts`) and `describeArchive()` (`src/info.ts`), moved
   out of the CLI. `tib info`/`verify` output is unchanged (CLI tests pass).
4. Errors carry a `code`: not-a-backup, unexpected-name, missing-part, damaged, encrypted, disk-image, unsupported.
5. `WebDavServer` checks the Host header on loopback (blocks DNS rebinding) and can serve below a
   secret `basePath`; `tib mount --drive` uses one.
6. `findWinFsp()`, `freeDriveLetters()`, `RcloneMount.pid` and `onUnexpectedExit`. `--drive` now says
   clearly when WinFsp is missing.
7. Tests: 77 pass (21 new, in `test/library.test.ts` and `test/extract-webdav.test.ts`).
   - Checked by hand on this machine: a synthetic backup mounted as Z: through the secret path, its
     files read back correctly, and the drive went away on unmount.


2026-10-28: desktop app, M2 (app skeleton)
------------------------------------------
1. Dependencies pinned to exact versions at least two weeks old (supply-chain caution):
   - Electron 44.7.1 (45.1.0 was a day old), electron-vite 5.0.0 (6.0.0 was too new), Vite 7.3.7
     (electron-vite 5 supports up to 7), React 19.3.0, Fluent UI 9.74.9, Playwright 1.64.0.
   - npm 11 holds back install scripts by default. esbuild's script stays unapproved, since its binary
     comes from `@esbuild/win32-x64` anyway.
   - Electron 44 no longer downloads its binary on install. `node node_modules/electron/install.js` does it
     (checked against the checksums shipped in the package); CI runs it too.
   - The install isn't stuck when it seems to be: Fluent's icons are ~60,000 files and take several
     minutes on Windows.
2. Processes:
   - main (`gui/src/main`): windows, dialogs, single instance, settings.
   - one engine `utilityProcess` per open backup (`gui/src/engine`); it bundles the library from `../src`.
   - sandboxed renderer with a typed preload bridge (`gui/src/preload`, contract in `gui/src/shared/api.ts`).
   - Results cross processes as `{ok, value}` / `{ok, error: {code, message}}`, so error codes survive IPC.
   - Main checks that a window owns a session before using it.
   - Navigation, new windows and webviews are blocked.
   - A strict CSP is injected into the built page.
3. UI (Fluent 2, follows the Windows light/dark setting):
   - Start screen: drop zone, Open button, recent backups.
   - Backup window: title bar with the backup point picker, command bar, Back/Forward/Up, breadcrumb,
     lazy folder tree, a virtualized details list with Explorer-style selection, keyboard and typeahead,
     a status bar and the Info panel.
   - Friendly errors by code (encrypted, disk image, missing part, renamed, not a backup, damaged...).
4. Tests: `npm run test:e2e` (Playwright `_electron`) opens synthetic backups from the library's test helpers.
   It browses, selects, goes Up, opens Info, and shows the encrypted-backup error.
   - Screenshots land in `gui/test-results/`.
   - CI gets a Windows job for the app (typecheck + e2e).
