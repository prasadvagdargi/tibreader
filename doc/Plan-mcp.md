Plan: MCP server, Claude Code plugin and skill
==============================================

Requested 2026-10-29. Built on the `mcp-server-agz54p` branch; see `TODO.md` section 13 for what is done.
Main use: organizing and cleaning up `.tib` files kept on a Proxmox server.

Goal: let Claude (and other MCP clients) browse backups, see sizes, find duplicates, plan cleanups and
understand a backup's structure. Backups stay read-only; anything that writes makes a new file.

Server (`src/mcp/`, started with `tib mcp`)
-------------------------------------------
- Hand-written stdio JSON-RPC (newline-delimited), no new dependency: `initialize` (echo a supported
  protocol version), `ping`, `tools/list`, `tools/call`; notifications ignored; -32601 / -32602 / -32700.
- stdout carries only protocol messages; warnings already go to stderr (`console.warn` in `src/log.ts`).
- Open archives cached by resolved path + password (reopened if the file's mtime changes); each backup
  point's full file list walked once and cached; everything closed when stdin ends.
- Every tool takes `backup_file`, optional `backup_point` (default -1, newest), optional `password`
  (or `TIB_PASSWORD`). Results are compact JSON text; bytes plus a human-readable total.
- Move `formatSize` from `src/cli.ts` to a shared module so the server can use it.

Tools
-----
- `find_backups_in_folder` (added while building): `.tib`/`.tibx`/`.tib.metadata` files in a folder on
  this computer, grouped into backups (`NAME_full_b1_...` by name and `b` number), plus files that look
  identical (same size and first/last MiB; optional full SHA-256). Doesn't open the backups.
- No tool deletes files: the skill has Claude write a plan and give the user the commands to run.
- `describe_backup`: `describeArchive()` output.
- `list_folder`: `folder_path`, `recursive`, `max_entries` (reports truncation).
- `summarize_folder_sizes`: totals per child folder/file below `folder_path` to `depth`, largest
  first, plus bytes by file extension.
- `find_files`: `name_pattern` (glob, case-insensitive), `extensions`, size and modified-date ranges,
  `sort_by` size/modified/path, `max_results` (largest files = sort by size).
- `find_duplicate_files`: `match_by` content (size groups, then hash of the first 64 KiB, then full
  SHA-256; `max_bytes_to_hash` limit with `stopped_early`) or name_and_size (no reading); wasted bytes.
- `read_file_text`: `offset`, `max_bytes` (default 64 KiB); UTF-8/UTF-16 BOM; binary -> hex preview.
- `compare_backup_points`: added / removed / changed (size or mtime) between two points, or two files.
- `verify_backup`: `quick` or full (`verifySnapshot`).
- `extract_files`: `paths_in_backup`, `destination_folder`, `if_file_exists` fail/skip/rename/overwrite.
- `write_cleaned_copy_of_backup`: `paths_to_leave_out` via `OverlayFS.remove` + `writeSnapshotBackup`
  into a new file (True Image acceptance unknown, as for `tib edit`).

Plugin and skill
----------------
- `.claude-plugin/marketplace.json` + `plugin.json` at the repo root; MCP server runs `node` on a small
  launcher that builds `dist/` on first use (avoids `npx` spawn problems on Windows).
- `skills/tib-backups/SKILL.md`: when to use the tools, workflows (overview -> sizes -> duplicates ->
  cleanup plan), never modify originals, confirm before writing files.
- README section: Claude Code plugin install, `claude mcp add tibreader -- node <repo>/dist/cli.js mcp`,
  Claude Desktop config.

Tests and release
-----------------
- `test/mcp.test.ts`: spawn `tib mcp`, run the protocol and each tool against backups made with
  `writeFileBackup()` (including duplicate files and two backups to compare).
- `npm test`, update TODO/WORKLOG, commit, push, PR to `master`, wait for CI, fix failures, merge.
