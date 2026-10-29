---
name: tib-backups
description: Inspect, measure and clean up Acronis True Image backups (.tib, .tib.metadata, .tibx) with the tibreader MCP tools. Use when the user asks what is in a backup, what takes up space, which files are duplicated, how backup points differ, whether a backup is intact, wants files restored from one, or wants to tidy up a folder or server (e.g. Proxmox storage) full of .tib files.
---

# Acronis backups with tibreader

The `tibreader` MCP server reads Acronis True Image backups without True Image. Backups are never
changed: every tool reads them, and the two that write (`extract_files`, `write_cleaned_copy_of_backup`)
only create new files.

## Basics

- `backup_file` is any file of a backup on the machine running the server: `NAME_full_b1_s1_v1.tib`
  (Windows; the other `_inc_`/`_v2` files are found automatically), `NAME.tib` (Mac) or `NAME.tibx`.
- A backup holds one or more **backup points** (versions). `backup_point` 1 is the oldest, -1 (default)
  the newest, -2 the one before.
- Paths inside a backup start at `/` and use `/`: Windows backups look like `/C/Users/me/Documents`.
  Lookups ignore case. Disk-image backups show their partitions as folders.
- Encrypted `.tibx`: pass `password`, or the server uses the `TIB_PASSWORD` environment variable.
- Sizes come as `bytes` plus a readable `size`; quote the readable one to the user.

## Workflows

**What is in this folder / server?** `find_backups_in_folder` on the folder. It groups files into backups,
largest first, and lists files that look like identical copies. Then `describe_backup` on the
interesting ones (dates, full or incremental, files or disk image, contents).

**Where does the space go?** `summarize_folder_sizes` (start at `/`, depth 1, then drill into the biggest
folder or raise `depth`), then `find_files` (sorted largest first; filter with `name_pattern`,
`extensions`, sizes, dates).

**Duplicates.** `find_duplicate_files` with `match_by: "content"` (exact). Narrow `folder_path` on very
large backups; if `stopped_early` is true, say so and offer a narrower folder or a bigger
`max_bytes_to_hash`. `name_and_size` is a fast first look only: say it may be wrong.

**What changed / is this backup redundant?** `compare_backup_points` between two points of one backup,
or with `newer_backup_file` between two backups. A backup is redundant only if another one holds
everything it has (no `removed` files) and is itself intact; check that before suggesting a deletion.

**Is it intact?** `verify_backup`. The full check reads the whole backup and can take a long time on
large ones: offer `quick: true` first, or one `backup_point`.

**Peek at a file.** `read_file_text` (text, or a hex preview for binary files).

## Cleaning up

Build a plan first, then act only on what the user confirms.

1. Survey: `find_backups_in_folder`, then sizes, duplicates and comparisons as above.
2. Present a cleanup plan as a table: what to remove or keep, why, and the space it frees. Separate
   facts (identical by SHA-256, verified, fully contained in another backup) from guesses
   (`identical_copies` without `confirm_identical_with_full_hash`, name-and-size matches).
3. Before any deletion of whole backup files, confirm with `confirm_identical_with_full_hash: true`
   or `compare_backup_points`, and `verify_backup` the copy being kept.
4. The tools never delete anything. Give the user the commands to run themselves (e.g. `rm` for files on
   a Linux or Proxmox host), never a wildcard that could match more than the planned files. Suggest
   moving files to a holding folder first if they are unsure.
5. To shrink a backup by leaving out files, `write_cleaned_copy_of_backup` writes a new single-file
   backup. Tell the user: the original stays until they delete it, only one backup point is copied (the
   history is not), and whether Acronis True Image itself accepts the new file is not known (this tool
   reads it). Check it with `verify_backup` and `compare_backup_points` afterwards.

Ask before calling `extract_files` or `write_cleaned_copy_of_backup`: say where files will be
written and roughly how much (from the sizes you already have), and check there is room.
