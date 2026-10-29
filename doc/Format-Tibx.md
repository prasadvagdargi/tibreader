.tibx format notes (True Image 2020 and later)
==============================================

What `src/tibx/` implements. **Not checked against a real file here**: it comes from acronis-tib-reader
(`tibread/tibx/*.py`, `docs/legacy/ARCHIVE3_*.md`), whose author read a 54 GB True Image 2025 `.tibx`
with it. Tests use synthetic archives from `test/helpers/tibx-fixture.ts`. Unless said otherwise,
integers are **big-endian**.


Files
-----
- Single file: `NAME.tibx`.
- Split: a small `NAME.tibx` (just an archive header) plus data files `NAME-0001.tibx`, `NAME-0002.tibx`...
  Together the data files form one *global* page space; each holds a window of it, and its own archive
  header (at its end) says where its window starts (offset `0x210`). Every page reference in the archive
  is global. A missing data file gives `missing-part` errors only for reads that need it.
- The reader accepts any of these files.


Pages
-----
Everything is 4 KiB pages:
```
0  0x41
1  type: 01 archive header, 02 archive index, 03 tree leaf, 04 tree directory, 05 dedup filter, FF data
2  00 00
4  CRC-32C of the whole page with these 4 bytes zeroed
8  body (4088 bytes)
```
Every page the reader reads is checked (`src/tibx/crc32c.ts`). acronis-tib-reader notes that True Image
can repair single-bit errors with the CRC; this reader only reports them.


Archive header
--------------
ARCH pages; the one with the highest sequence among the last 64 pages of a file wins (a single-file
archive also has an older one at page 0). Continued on further ARCH pages up to the header size.
Body offsets: `0x000` "ARCH", `0x004` header size, `0x008` version (8 seen), `0x188` sequence,
`0x210` first global page of this file, `0x400` a directory of 19 slots (`uint32` length, value, padded
to 4 bytes; versions below 7/8 leave some out).

| Slot | Content |
|---|---|
| 1 | `data_map` tree superblock |
| 2 | `segment_map` tree superblock |
| 5 | `slices` (backup points) tree superblock |
| 9 | NUL-separated strings: 0 type, 3 disk GUID, 4 computer name, 5 product (e.g. "ACPHO 27.3.1.40173 Win"), 10 install GUID |
| 18 | volume table: 12-byte `{uint32 index, uint64 disk offset}` (not used yet) |
| 0, 3, 4, 6, 7, 8 | other trees (dedup, links, ...; not needed for reading) |


LSM trees
---------
Superblock ("L-SB"): `0x04` version byte, number of tree slots - 2; `0x10` key length; `0x14` value
length; from `0x18` up to ten 32-byte slots {`uint64` root page *byte offset*, `uint64` size,
`uint32` items, 4 reserved, `uint64` max}; an all-ones root marks an emptied slot. `0x158` mem-tree
encoding (0 raw, 1 LZ4; `0x80` encrypted), `0x15A` `uint16` entry count, `0x15C` `uint32` payload
length, payload from `0x178`: entries not yet written to an on-disk tree.

Tree pages (body offsets): `0x00` "LEAF"/"LDIR", `0x05` encoding (0 raw, 1 chained LZ4, `0x80`
encrypted), `0x06` `uint16` cell count, `0x08` decoded size, `0x0C` stored size, cells from `0x34`.
Chained LZ4: blocks of `{uint32 stored, uint32 decoded, LZ4 block}`, each using the previous output as
its dictionary.

Cells: directory pages hold `[key][uint64 child byte offset]`; leaf pages of fixed-size trees hold
groups of up to 24 cells behind a 4-byte header (byte 0: count; bytes 3, 2, 1: bitmap of live cells);
a deleted cell has no value. Trees with variable sizes use `[leb128 key length][leb128 value length]`.

**Merging (assumption):** the mem-tree is taken as newest, then the on-disk trees in slot order; the
first occurrence of a key wins and deletions hide older entries.


Trees used
----------
- `segment_map`: `uint64` segment id -> `uint32` page count (**little-endian**), `uint32` first page,
  `uint32` backup point id, SHA-1 (not checked).
- `data_map`: key `{uint64 stream id, uint64 offset, uint24 length, uint32 kind (2), uint64 extent id}`,
  value `{uint64 segment id, uint16 index in segment}` (`0xFFFF`: the extent is the whole segment).
- `slices`: `uint32` backup point id -> 132 bytes: `0x00` UUID, `0x10` start time (ms since 1970),
  `0x18` end time, `0x20` parent UUID (zeros for a full backup), `0x44` flags (`0x04` differential,
  `0x08` edited, `0x73` incremental bits, otherwise full).


Segments
--------
On data pages: `0x08` "SG\0\1", `0x0C` decoded size, `0x10` stored size, `0x14` key id (0 = not
encrypted), `0x18` `uint16` compression (0 stored, `0x03xx` Zstandard), data from `0x2C`, continued on
the following data pages after their envelopes. Decompressed with Node's built-in Zstandard (Node 22.15+).


How backup points are shown
---------------------------
Each stream id of `data_map` is an image (`Volume N.img`, or `Volume.img` if there is one), shown through
`DiskFS` like sector-by-sector backups (volume folders for NTFS, partitions for disks). Streams under
1 MiB that don't start with a boot sector or partition table are True Image's own metadata and hidden.

Assumptions (no real sample to check):
- **Incremental and differential backup points:** a point sees the extents whose segment belongs to it
  or to its ancestors (via parent UUIDs); where extents overlap, the newer point wins.
- **Extents sharing a segment** (index != `0xFFFF`) are stored back to back in index order.
- **Whole-disk backups:** whether the partition table is in a stream of its own isn't known; partitions
  are found when a stream starts with one.
- **Encryption:** see below.


Encryption (experimental)
-------------------------
From acronis-tib-reader's decompilation notes (`docs/legacy/ARCHIVE3_ENCRYPTION.md`, marked "confirmed
via decompilation" there), implemented in `src/tibx/encryption.ts`, **never tested against a backup
encrypted by True Image**:
- Header slot 7 is the key tree (variable-size cells). A password user is the record `[0x01][user name]`:
  `0x01`, algorithm (1-3 AES-128/192/256-CBC, 5-7 AES-128/192/256-GCM), PBKDF2 iterations as a power of two
  (10-24), 0, 16-byte salt, then the data key encrypted with AES-256-CBC (zero IV, PKCS#7) under
  PBKDF2-HMAC-SHA256(password, salt, 32 bytes). Certificate users (`[0x02]...`, RSA-OAEP) aren't supported.
- Encrypted segments have "SE\0\0" instead of "SG\0\1" and a non-zero key id; their stored bytes are
  the IV (16 bytes; GCM: then a 16-byte tag) and the ciphertext of the compressed data.
- The format has no password check, so the reader tries each password user and confirms by decrypting
  and decompressing the first segment. Wrong password: `FormatError` with code `wrong-password`.
- Encrypted tree pages (encoding bit `0x80`) aren't supported; their layout isn't documented.
- Use: `openArchive(file, { password })`, `tib --password ...` or `TIB_PASSWORD`. A warning says it's
  experimental each time.

Sector-by-sector and file `.tib` encryption stays unsupported: acronis-tib-reader's notes leave the
framing (`0xE0` frames, 16 KiB CBC windows, where the IVs are) unconfirmed, so any implementation would
be a guess.
