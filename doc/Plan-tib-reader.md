Plan: what to take from tib-reader
==================================

Written 2026-10-27 after reading all of [acronis-tib-reader](https://github.com/TreadingTheTiber/acronis-tib-reader)
(Python, MIT, v0.3.0, commit `e786c68`), cloned next to this project at `../tib-reader`. None of its code
was run here: its claims are taken from its docs and code, and checked against our own findings where the
two projects cover the same format.

**Status 2026-10-29:** Phases 0-3 done; Phase 4 done as experimental, for `.tibx` only (`.tib` encryption
is too loosely documented to implement). Write support was added on top. All tested on generated files
only; see `TODO.md` (sections 10 and 12) and `WORKLOG.md`. The code was written from acronis-tib-reader's
notes, not copied from it.


Summary
-------
tib-reader reads three kinds of backup:

| tib-reader calls it | What it is | This project today |
|---|---|---|
| "FS-mode hybrid `.tib`" | Windows file/folder backup | **Supported, and our reader is more exact** (see below) |
| Sector-mode `.tib` | Disk/partition image, True Image 2014-2019 | Stops with "not supported" |
| `.tibx` | Disk image, True Image 2020 and later (current default for disk backups) | Not even recognized ("Not a .tib file") |

Its author checked the disk formats against real backups (a 1 TB and an 8 GB `.tib`, a 54 GB `.tibx`). To
show the files inside a disk image it also has an NTFS reader, including NTFS compression (LZNT1) and
Windows "Compact OS" compression (WOF/Xpress).

Where this project is ahead: tests (synthetic backups, CI on three OSes; tib-reader's CI runs one test
file), strict read-only handling (tib-reader writes `.idx`, `.segidx` and `.fs.idx` files next to the
backup), reading backups split over several files (tib-reader can't read across them), Windows mounting
without drivers (WebDAV), safe extraction, typed errors.

**Plan in one line:** keep our architecture and test approach, and port tib-reader's format knowledge for
disk images, NTFS and `.tibx`, in that order, each one tested against synthetic fixtures first.


1. The format we share: Windows file/folder backups
---------------------------------------------------
tib-reader's "FS-mode hybrid" is the format in `Format-Windows.md` (same trailer `2C 8A E1 94`, same record
type bytes). Mapping its names to ours:

| tib-reader | Ours | Note |
|---|---|---|
| `0x6D` "file-content chunk" | 109 Blob | same |
| `0x6E` "end-of-file marker" | 110 BlobSuffix | same |
| `0x66` "metadata batch" with a "44-byte preamble" | 102 FileMetaStart, 1 Attributes, 108 RecordIndex, 5 Times | it reads the whole run as one blob; the "preamble" is our 102 and 1 records |
| "metadata blob", magic `01 02 00 10 01 00 00 00` | 108 RecordIndex | its per-extent layout is shifted; ours was checked on 4,211 real blocks |
| `0x65` record + "5 framing bytes `c0 83 c7 05 67`" | 101 Config, then the 4-byte check value and the 103 type byte | |
| "directory tree" | 103 Listing | it calls our modified time `file_id` and our FileMetaStart offsets `ts1`/`ts2` |

It reads files by walking the whole backup in order and matches files to names **by file size**. We
jump straight to a file through Listing -> FileMetaStart -> RecordIndex and check every block's MD5.
Nothing to adopt there.

Worth taking:
- **Second real sample.** Its sample (`share_backup_example.tib`) comes from True Image 2016 and has the
  same layout, so the format looks stable from 2016 to 2024 (not tested here).
- **Listing fields.** The `uint32` after the modified time is shared by siblings (likely a hash of the
  parent folder). The second size is the allocated size (rounded up to clusters).
- **Trailer.** The 16 bytes before the trailer magic are `uint64` record count + `uint64` metadata
  offset (we only read the offset).
- **Alternate data streams (ADS).** It finds stream names such as `:encryptable:$DATA` after the security
  descriptor at the end of the RecordIndex, plus a per-extent stream id. We ignore that area. Files
  downloaded from the internet carry a `Zone.Identifier` stream, so this is common. We need to confirm on
  the real backup that a file with an ADS reads correctly and that ADS blocks never get mixed into the
  main data. **This is the most important check for the format we already support.**
- **True Image 2016 quirk.** In 5 of ~100 sampled files, a block decompresses to one byte less than
  expected (the writer's own Adler-32 matches the short data). Our zero fill handles the length; `verify`
  may report an MD5 mismatch on such files.

Volume header (all variants): tib-reader says bytes 8-15 are a `uint64` archive id and 16-19 a `uint32`
volume id (ids from True Image's catalog database, not random), identical in every file of a split
backup. We read them as three 4-byte "keys" and compare only the first four bytes. Our split fixture
gives each file a different "volume key", so one of the two models is wrong; a real split backup settles it.


2. Formats we can't read yet
----------------------------

### 2a. Disk and partition images (`.tib`, sector-by-sector)
From tib-reader's `docs/FORMAT.md` and `docs/FORMAT_LEGACY.md` (code: `chunkmap*.py`, `reader.py`,
`indexer.py`, `metadata.py`, about 2,000 lines):
- Same 32-byte header, 48-byte footer and slice trailer as file backups; trailer magic `2B 8A E1 94`.
  The trailer body is 2 bytes, a length byte, then the metadata offset (matches our notes).
- Data is a run of blocks: `[cluster bitmap][zlib stream of the clusters that are present]`.
  - Modern (True Image 2018+): 16-byte bitmap, 128 clusters of 4 KiB = 512 KiB per block.
  - Legacy (True Image 2014-2016): 8-byte bitmap, 64 clusters = 256 KiB per block.
  - Clear bits are unused clusters and read as zeros.
- About 4% of blocks are stored out of order (parallel compression), so reads need the **chunk map**:
  - Modern: one zlib stream after the data, found through tag `0x9B` of the metadata-blob TLV. Decoding:
    inflate, transpose the N x 12 byte matrix, then zigzag-delta decode 12-byte records
    `{uint64 offset, uint32 length}`; length 0 means the block isn't stored.
  - Legacy: the same encoding split over several records between the blocks, each with a small TLV
    header (tag 2 bytes per sector, 3 sectors per cluster, 4 clusters per block, 6 record count). Finding
    them takes one full read of the file (about 4 minutes for 8 GB), so the result must be cached.
- Checks: zlib's Adler-32 on every block, plus an MD5 per stored block of `bitmap + decompressed data`
  in a list after the data.
- Split backups: everything after the data lives only in the last file. Our `ConcatenatedReader` model
  already fits; tib-reader only redirects the user to the last file.
- Also mapped: Windows dynamic-disk (LDM) copies, the metainfo XML, a dedup filter (not needed for
  reading), the encryption scheme (AES-CBC; PBKDF2, SHA-256 stretching or scrypt; spec only, no sample),
  and the fact that cloud backups are the same `.tib` cut into 128 MB pieces.

### 2b. NTFS (to turn a disk image into files)
`ntfs.py`, `lznt1.py`, `xpress.py` (about 2,000 lines): boot sector, MFT records with fixups, resident and
non-resident attributes, run lists (with sparse runs), folder indexes, LZNT1 and WOF/Xpress (4K/8K/16K).
Gaps to close while porting:
- No `$ATTRIBUTE_LIST` support: very fragmented files (large videos, VM disks) and very large folders
  come out incomplete **without an error**.
- Name matching folds ASCII only (should use the volume's `$UpCase` table).
- The MFT is found by scanning instead of from the boot sector (left over from its early guesswork).
- No WOF/LZX (rare).

### 2c. `.tibx` (True Image 2020+)
From `tibread/tibx/` (about 4,400 lines including an encryption skeleton) and `docs/legacy/ARCHIVE3_*.md`:
- 4 KiB pages. Each starts with `41 <type> 00 00` and a big-endian CRC-32C of the page (CRC field zeroed).
  Types: 1 ARCH header, 2 ARCI, 3 LEAF, 4 LDIR, 5 dedup filter, `FF` data.
- The ARCH header holds a 19-entry TLV directory: host name, agent version, disk GUID, volume table, and
  one superblock per LSM tree (`data_map`, `segment_map`, `slices`, ...).
- Tree pages: LDIR (inner) and LEAF pages, cell area compressed as a chain of LZ4 blocks (each block uses
  the previous output as its dictionary); cells are either fixed-size groups of up to 24 with an
  alive-bitmap, or leb128-length records.
- `data_map`: 31-byte key `(volume id, offset, length, kind, extent id)` -> 10-byte value
  `(segment id, index in segment)`. `segment_map`: segment id -> 32-byte value (page count LE,
  first page BE, slice id, SHA-1).
- Data segments: `SG\0\1` header (big-endian lengths, key id, compression), Zstd frame spilling over
  following data pages. Compression `0x0000` stored, `0x0300`-`0x0303` Zstd. Key id != 0 means
  encrypted.
- Split backups: `NAME.tibx` is a small pointer file; `NAME-0001.tibx`, ... each hold a window of one
  global page space (its start page is a big-endian `uint64` at body offset `0x210` of the ARCH header at
  the slice's end).
- Backup chain (full / incremental / differential) is in the `slices` tree.
- Partitions: found by matching each data stream's boot-sector size against the MBR. GPT isn't parsed (a
  GPT disk only shows up as a "GPT protective" MBR entry), and most current Windows PCs boot from GPT
  disks, so our port needs its own GPT support.

### 2d. Variants it only detects
Magic `0x8F5C36C6` (file backup v1) and `0x44686EB4` (v2), tape footer `0x179631B4`, and True Image
2010-2013 files (header length `0x20`, version 1, `0x1000` at offset `0x1C`). **That last one collides with
our Mac detection:** we route every version-1 header to the Mac parser, which then fails with a confusing
error.


3. Plan
-------
Sizes are rough: S = under a day, M = 2-3 days, L = about a week. Each phase ends with tests passing on all
three CI systems and updated `README.md`, `TODO.md`, `WORKLOG.md` and format notes.

### Phase 0: quick wins (S, no new samples needed)
- [ ] Recognize every known variant up front and fail with a `NotSupportedError` that names it: `.tibx`
      (master and `-NNNN` slice files), file backup v1/v2 magics, tape footer, True Image 2010-2013.
      Route version 1 to the Mac parser only when the header length is `0x24`.
      Where: `src/volume.ts`, new `src/detect.ts`; tests with 64-byte synthetic headers in `test/unit.test.ts`.
- [ ] `tib info` prints the detected format even when it can't be read.
- [ ] `Format-Windows.md`: header ids (marked unverified), listing fields (parent hash, allocated size),
      trailer record count, the True Image 2016 observation, the ADS lead.
- [ ] README: on Windows, open `http://127.0.0.1:8642/` in a web browser to download files of any size
      (the 50 MB limit is in Windows' WebDAV client only); add sizes and dates to that folder page
      (`src/mount/webdav.ts`, `directoryPage`).
- [ ] On the real backup (read-only): find files with alternate data streams and compare `tib cat` with
      the original; decode the area after the security descriptor in their RecordIndex. Fix and add a
      fixture case if needed.
- [ ] Optional: find what the 4 bytes after each raw-deflate record are (try CRC-32 and Adler-32 of the
      compressed and uncompressed bytes against the real backup); if found, `verify` can check metadata too.

### Phase 1: disk images in `.tib`, raw (M)
- [ ] Format sniffing before `Volume.Open`, so a slice's trailer kind (file vs sector) picks the reader;
      keep `Archive`/`Slice`/`SnapshotFS` as the common API.
- [ ] `src/sector/`: trailer body, metadata-blob TLV parser (including the legacy 7-byte `(tag, 0x05)`
      records), chunk-map locator by parsing tag `0x9B` (tib-reader's 13-byte signature search only as
      a fallback), chunk-map decoder, block reader with bitmap/popcount and the existing LRU cache.
- [ ] Legacy (2014-2016) inline chunk maps; the one-time scan result cached in the user's cache folder
      (`%LOCALAPPDATA%\acronis-tib` / `~/.cache/acronis-tib`), keyed by size, time and header, never next
      to the backup. `--no-cache` to skip.
- [ ] Show the partition as one read-only file (e.g. `/partition.img`), so `extract`, `cat`, WebDAV and
      FUSE work unchanged and tools such as 7-Zip or `mount -o loop,ro` can open it.
- [ ] `tib verify` for disk images: Adler-32 of every block and the MD5 list.
- [ ] `test/helpers/sector-fixture.ts`: tiny modern and legacy images with out-of-order blocks, partial
      bitmaps, unstored blocks and a split into several files.
- [ ] Store the chunk map in typed arrays (1 TB image = 5.7 million records).

### Phase 2: NTFS reader (L)
- [ ] `src/ntfs/`: port of `ntfs.py`, `lznt1.py`, `xpress.py`, plus `$ATTRIBUTE_LIST`, `$UpCase` name
      matching, MFT location from the boot sector, ADS as `name:stream` (hidden by default), hard links.
- [ ] `SnapshotFS` over NTFS, so a disk image shows its files in `ls`, `extract` and mounts.
- [ ] MBR/GPT partition table reader: one top-level folder per partition (like drive letters today).
- [ ] Tests: a few small NTFS images built with `mkntfs` (Linux CI) or committed as compressed fixtures,
      covering resident, fragmented, sparse, LZNT1, WOF and attribute-list files.

### Phase 3: `.tibx` (L)
- [ ] `src/tibx/`: page reader with CRC-32C (small table implementation; Node only has CRC-32), ARCH
      header and TLV directory, superblocks, LDIR/LEAF pages, LZ4 block decoder (small, no dependency),
      cells, `data_map`, `segment_map`, Zstd segments via `node:zlib` (needs Node 22.15+: raise `engines`).
- [ ] Split `.tibx` (pointer + `-NNNN` slices, holes for pruned slices give clear errors).
- [ ] Backup points from the `slices` tree, exposed through `archive.getSlice(n)`.
- [ ] Partitions through the Phase 2 MBR/GPT reader and NTFS.
- [ ] `tib verify`: CRC-32C of every page. Encrypted segments: `NotSupportedError`.
- [ ] Synthetic `.tibx` fixture writer for each structure.

### Phase 4: encryption (only once real encrypted samples exist)
- [ ] `.tib` and `.tibx` decryption (AES-CBC and the three KDFs are all in `node:crypto`), password
      prompt in the CLI. Don't ship decryption that was never checked against a real file.

### Possible order change
Phases 1 and 3 both need Phase 2 to show files. If recent backups matter more than 2014-2019 ones, do
Phase 2, then 3, then 1. Phase 1 is first here because it reuses our header/trailer code and is the
smallest step to "something readable".


4. Risks and open questions
---------------------------
- **Samples.** Everything in phases 1-3 rests on one or two real files per format on tib-reader's side
  and none on ours. Synthetic fixtures only test our understanding. A disk backup of a small USB stick
  made with any current True Image would give a real `.tibx`; old `.tib` disk images are harder to get.
- **tib-reader's docs contradict each other in places.** Examples: `FORMAT.md` says a chunk-map record
  covers 64 KB, the code uses 128 clusters x 4 KiB = 512 KiB; `.tibx` detection is described both as
  `QARCH` at offset 7 and as the page envelope plus `ARCH` at offset 8 (the newer code comment says the
  first was a coincidence); its user guide mentions LZ4 data segments, the code only handles stored and
  Zstd. Prefer the code paths that were run against real files and re-check each point in our fixtures.
- **Silent wrong data is the worst outcome** for a backup reader. Every new reader should check what it
  can (Adler-32, MD5, CRC-32C, sizes) and fail loudly otherwise.
- **License.** tib-reader is MIT ("Copyright (c) 2026 the tibread contributors"). Ported files need a
  header note and the notice added to `LICENSE` (or a `NOTICE` file).
- **Dependencies.** Node 22.15+ for Zstd. LZ4 and CRC-32C are small enough to write here; no native modules.
- **Upstream.** tib-reader's file-backup support pairs files to names by size. Our Listing and
  RecordIndex knowledge would make it exact. Telling its author is a public action, so it's the
  maintainer's call.


5. Things not to copy
---------------------
- Index files written next to the backup (breaks "only ever read" and fails on read-only media).
- Signature scanning where a real parser exists (chunk-map locator, metadata batches).
- Matching files to names by size.
- Optional dependencies that the code needs (`zstandard`, `lz4` aren't declared in its `pyproject.toml`).
- `tools/tibwinmount.py` (imports modules that no longer exist).
