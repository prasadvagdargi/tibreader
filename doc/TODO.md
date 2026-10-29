To-do list
==========

Tracks the work on https://github.com/prasadvagdargi/tibreader (until 2026-10-27 the `modernize-and-fixes`
branch of a fork of dennisss/acronis-tib; now merged into `master`). Each item comes from the October 2026 code review
(see `WORKLOG.md` for what was done and why). Tick items as they land and keep this file in each commit
that changes it.

Legend: `[x]` done, `[ ]` to do, `[~]` partly done / blocked (reason given)


Next steps (in priority order)
------------------------------
1. **Record index kind 0x0007** (file recorded without data, read as zeros): find out what it means,
   ideally by backing up a known file that triggers it. See `Format-Windows.md`.
2. **Alternate data streams on the real backup** (left over from Phase 0 of `Plan-tib-reader.md`): find a
   downloaded file (with `Zone.Identifier`), compare `tib cat` with the original, decode the RecordIndex tail.
3. **More real samples**: an incremental chain, a backup split into several files, an encrypted one, a
   sector-by-sector `.tib` and a `.tibx` (True Image for Windows), plus any Mac backup. Run
   `TIB_SAMPLE=<file> npm test` and `tib verify` on each, then fix what breaks and record findings in the
   format notes.
4. **Disk images, NTFS and `.tibx`**: Phases 1-3 of `Plan-tib-reader.md`. No longer blocked on samples:
   acronis-tib-reader documents these formats from real files, so work can start against synthetic
   fixtures.
5. **Native FUSE / `--drive` on Linux and macOS**: test `tib mount --fuse` (with `@cocalc/fuse-native`)
   and `tib mount --drive <folder>` (with rclone + FUSE).
6. **Windows attributes in mounts**: show hidden/system flags and creation times (needs a per-entry
   metadata read, so cache it).
7. **Synthetic Mac fixture** following `Format-Mac.md`, so the Mac parser has end-to-end tests.
8. **Desktop app** (Windows first): milestones in section 11, plan in `Plan-desktop-app.md`.


1. Bugs found in review
-----------------------
- [x] `Archive.Open` closed the volume the archive still uses (broke Mac file reads)
- [x] FUSE read checked `pos < pos + size` instead of `position < pos + size`
- [x] Windows slices split over several volumes failed with "Gap in slice numbering"
- [x] Sector-by-sector trailer read the 2nd offset with the wrong length; now fails with a clear error
- [x] `readFooter` closed the volume's reader instead of its own slice
- [x] `search()` returned an out-of-range index
- [x] `AssertKeys` ignored `allOptional` for trailing keys; unknown XML keys now warn instead of failing
- [x] 64-bit values silently truncated to 48 bits
- [x] Windows listing strings kept a trailing NUL and the "short name" included extra bytes
- [x] Windows listing couldn't tell folders from empty files (uses the `kind` field now)


2. Toolchain and packaging
--------------------------
- [x] npm instead of yarn; remove `yarn-error.log`
- [x] TypeScript 7, `strict`, Node 22+ (`engines`)
- [x] Drop `fs-extra`, `tslib`; upgrade `xml2js` to 0.6.2 (CVE-2023-0842)
- [x] Remove abandoned `fuse-bindings`
- [x] `.gitattributes` so line endings stay LF on every OS
- [x] `src/index.ts` public entry point that registers both formats
- [x] `tib` command-line tool (`info`, `ls`, `cat`, `extract`, `verify`, `mount`)
- [x] GitHub Actions CI on Linux, macOS and Windows (Node 22 and 24)


3. Safety and robustness
------------------------
- [x] Bounds checks on every reader; reads bigger than 256 MB refused
- [x] Decompressed size limit (256 MB per stream)
- [x] File handles opened read-only and reference counted; double close is harmless
- [x] Close every reader/volume on error paths (`WindowsArchive.OpenImpl`, `MacArchive.OpenImpl`, `readBoxHandle`, `readAll`)
- [x] `Archive.close()` also closes slice readers
- [x] Config XML problems become warnings, not fatal errors
- [x] Replace remaining `console.warn` calls with `log.warn`
- [x] Encrypted Windows backups fail with a clear `NotSupportedError`
- [x] Extraction sanitizes names (no `..`, no characters invalid on the target OS) and never writes outside the destination
- [x] Replace `assert` calls in the parsers with `FormatError`s


4. Windows format
-----------------
- [x] Read file contents (blob records via the per-file record index); every block checked against its MD5
- [x] Folder detection, real names, modified times from the listing
- [~] Attributes and creation time: available through `WindowsFS.entryMeta()`, not yet shown by mounts
- [x] Slice id and creation time (from the config record)
- [~] Sector-by-sector disk backups: clear "not supported" error only (no sample to reverse-engineer)
- [~] Backups split across several `.tib` files: loop fixed, untested (no sample)
- [~] Incremental chains: code path exists, untested (no sample)


5. Mac format
-------------
- [x] Pick which backup point (slice) to view (`archive.getSlice(n)`); default is the latest
- [~] Owners/permissions/xattrs from `StatUser`/`Attributes` boxes: documented, not applied (no sample)
- [~] Real-file testing impossible: sample bucket `gs://acronis-tib` now returns 403


6. Mounting
-----------
- [x] Shared read-only file-system view over a slice (both formats): `slice.openFileSystem()`
- [x] WebDAV server mount: works on Windows (map network drive), macOS and Linux with no native code
- [x] Windows' 50 MB WebDAV limit avoided: `tib mount --drive R:` mounts through rclone + WinFsp (tested on the 55 GB backup); registry fix still documented for `net use`
- [~] Optional native FUSE mount on Linux/macOS via `@cocalc/fuse-native` (loaded only if installed); untested, no Linux/macOS machine here
- [x] Unmount cleanly on Ctrl+C; no per-read logging; configurable mount point and port


7. Performance
-------------
- [x] No more quadratic buffer concatenation or 4 KB flush loop
- [x] Cache recently decompressed blocks (64 MB LRU per slice/volume), shared between concurrent reads


8. Tests
--------
- [x] Unit tests: readers, search, AssertKeys, compression, 64-bit reads, cache, paths, ranges
- [x] Synthetic Windows backups (single, split, corrupted, encrypted, sector-by-sector) built by `test/helpers/windows-fixture.ts`; Mac tree/read logic tested with a stub volume
- [ ] Synthetic Mac `.tib`/`.tib.metadata` builder (needs the Mac layout written up first)
- [x] Integration test against a real backup when `TIB_SAMPLE` points at one (skipped otherwise)
- [x] CLI tested end to end (exit codes, extract, verify on a corrupted backup)
- [x] WebDAV server tested over HTTP; extraction tested with tricky names


9. Documentation
----------------
- [x] Work log and this to-do list
- [x] README: status, install, CLI, mounting on each OS, library usage
- [x] Windows format notes (`Format-Windows.md`)
- [x] Mac format notes (`Format-Mac.md`, from the code; unverified)
- [x] Fix `/opt/archive` vs `/opt/acronis` mismatch in `samples/README.md`
- [x] `samples/extract_data.bat`: copies the finished backups like the Mac script does (untested: needs True Image)
- [x] Compared with acronis-tib-reader; plan in `Plan-tib-reader.md`


10. Formats from acronis-tib-reader
-----------------------------------
Details, sizes and order in `Plan-tib-reader.md`. Work on the `more-formats` branch (from `desktop-app`).
- [x] Phase 0: quick wins
  - [x] `detectFormat()`: `.tib` (Windows/Mac), `.tibx` (archive and data files), True Image 2010-2013,
        old file-backup containers v1/v2, tape; each refused with a message naming it
  - [x] True Image 2010-2013 files no longer reach the Mac parser
  - [x] `tib info` names the format even when the file can't be opened; `archive.format`, `archive.files()`,
        `slice.kind` ('files' / 'disk') for every format
  - [x] WebDAV folder page shows sizes and dates; README: browser downloads have no 50 MB limit
  - [x] `Format-Windows.md`: header ids, listing fields, trailer record count, 2016 sample, ADS lead
  - [~] Alternate data streams on the real backup: blocked, the 55 GB backup isn't connected to this machine
  - [~] The 4 bytes after raw-deflate records: same (needs the real backup)
- [x] Phase 1: sector-by-sector `.tib` as raw images (`src/sector/`, `src/disk/`, notes in `Format-Sector.md`)
  - [x] Trailer records, chunk-map locator search, chunk-map decoder (modern), inline chunk maps found by
        walking the blocks (2014-2016), with a fast path for stored deflate blocks
  - [x] Index of the walk cached in the user's cache folder (never next to the backup)
  - [x] `DiskFS`: `Volume.img` / `Disk.img` + `Partition N.img` (MBR with logical partitions, GPT)
  - [x] Several chunk maps in one backup point -> several volumes; split files; incremental points read
        unstored blocks from the previous point (an assumption)
  - [x] Settings from the metainfo XML; encrypted disk images refused; `verify` decompresses every block
  - [~] MD5 list after the data: not used (its location isn't known exactly)
  - [~] No real disk-image `.tib` checked yet
- [ ] Phase 2: NTFS reader (with `$ATTRIBUTE_LIST`, LZNT1, WOF/Xpress) and MBR/GPT partitions
- [ ] Phase 3: `.tibx` (pages, LSM trees, Zstd segments, split files, backup chain)
- [ ] Phase 4: encryption, only once real encrypted samples exist


11. Desktop app (Windows first)
-------------------------------
Plan in `Plan-desktop-app.md`; work on the `desktop-app` branch.
- [x] M1 library groundwork: extract cancel/progress/conflicts, `extractItems`, `measure`, `verifySnapshot`,
      `describeArchive`, error codes, WebDAV Host check + secret path, `findWinFsp`, `freeDriveLetters`, exports;
      CLI refactored onto them with unchanged output
- [x] M2 app skeleton: `gui/` (Electron + Fluent UI), engine utilityProcess per backup, typed IPC, Welcome,
      browse (tree, list, breadcrumb, backup point picker), Info panel, friendly errors
- [x] M3 getting files out: Copy to / Restore wizard, jobs flyout with cancel and conflicts, Open, Edit a copy,
      staging, Ctrl+C clipboard (PowerShell `Set-Clipboard -LiteralPath`, paths on stdin), drag-out
- [x] M4 mount: bundled rclone, WinFsp detection and install, drive letter picker, mounted paths for
      clipboard/drag/open, clean unmount on quit or crash
- [x] M5 polish: preview pane, search, Verify dialog, properties with attributes, shortcuts, theme choice,
      recent files, resizable folder pane
  - [ ] Real Windows file-type icons (`app.getFileIcon` needs a file on disk; Fluent icons for now)
  - [ ] PDF preview (needs Chromium's PDF viewer in a sandboxed frame)
- [x] M6 packaging: portable exe, zip, NSIS installer with `.tib` association; single instance; portable data
      folder; release workflow; README section
  - [ ] Try the installer by hand: install, double-click a `.tib`, uninstall (not done on the build machine,
        since it adds a Start menu entry and a file association)
  - [ ] Code signing (SmartScreen warns about unsigned downloads)
  - [ ] Drag-and-drop to Explorer by hand (Windows' own drag loop can't be automated)
  - [x] Try the app on the real 55 GB backup (`TIB_SAMPLE`; `gui/test/e2e/real-backup.spec.ts`)
