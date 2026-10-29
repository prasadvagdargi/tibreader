Windows .tib format notes (True Image 2015 and later)
=====================================================

Reverse-engineered findings. Offsets are byte offsets; all integers are little-endian.
"Verified" means checked against a real True Image 25.4 file-level backup (October 2026).


Volume file layout
------------------
```
[32-byte header] [slice data ...] [zero padding] [48-byte footer]
```
- Header: magic `CE 24 B9 A2`, header length `0x20`, version `0` (Windows), 12 bytes of ids (see below),
  sequence number (starts at 1), Adler-32 of the header, block size `32`. Verified.
- The 12 id bytes: acronis-tib-reader reads them as a `uint64` archive id (offset 8) and a `uint32`
  volume id (offset 16), both ids from True Image's catalog database and identical in every file of a
  split backup. This reader treats them as three 4-byte keys and only requires the first 4 bytes to match
  across files. Not checked here: needs a real split backup.
- Version 1 with a 32-byte header and `0x1000` at offset `0x1C` is a True Image 2010-2013 file (not the
  Mac format, which has a 36-byte header). Recognized and refused with a clear message.
- Footer: last 32 bytes are the header byte-reversed. 8 bytes before that is the slice size (bytes of
  slice data counted from after the header, summed over every volume of the slice). Verified.
- The file length is a multiple of the block size (32). Verified.


Slice trailer
-------------
The last 4 bytes of the slice data identify its kind:
- `2C 8A E1 94`: file-level backup. The 8 bytes before them are the offset of the metadata
  (config records, then the listing). Verified. According to acronis-tib-reader the 8 bytes before that
  are the number of listing entries.
- `2B 8A E1 94`: sector-by-sector disk backup. Not supported yet (no sample). From the original
  author's notes: the 4 bytes before the magic are the trailer size; the trailer starts with 2 zero
  bytes, then length-prefixed integers (1-byte length, then the value): a metadata offset, 7 unknown
  bytes, the full uncompressed partition size, 2 unknown bytes, and a second metadata offset.


Records
-------
Slice data is a sequence of records. Each starts with a 1-byte type followed by a compressed stream.

| Type | Name | Compression | Notes |
|------|------|-------------|-------|
| 109 | Blob | zlib | File data, up to 256 KiB (262,144 bytes) decompressed. Trailing zeros of a file are not stored. Verified |
| 110 | BlobSuffix | zlib | Empty; follows the last blob of each file. Verified |
| 102 | FileMetaStart | raw deflate + 4 bytes | 5 zero bytes; first record of every entry's metadata. Verified |
| 1 | Attributes | raw deflate + 4 bytes | uint32 Windows file attributes (`0x10` folder, `0x20` archive, `0x02` hidden, `0x04` system, `0x01` read-only). Verified |
| 2 | Security | raw deflate + 4 bytes | Windows security descriptor (self-relative). Folders only, it seems |
| 108 | RecordIndex | zlib | Where a file's blocks are; see below. Files only. Verified |
| 5 | Times | raw deflate + 4 bytes | Two uint64 timestamps in ms since 1970; the second is the modified time shown in the listing. Verified |
| 101 | Config | raw deflate + 4 bytes | Key/value XML (product info, task id, computer id, compression, encryption). Verified |
| 103 | Listing | raw deflate + 4 bytes | Every file and folder in the slice. Verified |
| 104 | EndTrailer | none | Marks the end of the metadata |

The 4 bytes after raw deflate streams look like a checksum (not Adler-32 of the data; still unknown).

The metadata of an entry is: `102`, `1`, then `2` (folders) or `108` (files), then `5`.
File data blobs are written before the metadata that points at them.


Config (type 101)
-----------------
```
0    68  unknown
68   8   backup creation time, ms since 1970. Verified (2 s before the file's last write)
76   16  unknown
92   8   metadata offset (same as the slice trailer). Verified
100  17  unknown
117  8   total size of all files in the slice. Verified
125  8   unknown
133  8   metadata offset again. Verified
141  8   unknown
149  16  id (most likely of the slice)
165  4   number of attributes
169  ... attributes: uint32 key length + UTF-16 key, uint32 value length + UTF-16 XML value (BOM first)
end  1   one extra byte
```
Attribute keys seen: `metainfo` (product, task id, computer id, compression, encryption),
`product_info`, `task_id`. Unencrypted backups have `encryption value="none"`.


RecordIndex (type 108)
----------------------
```
0   2   01 02
2   2   uint16 kind: 0x1000 normally (bytes "01 02 00 10 01 00 00 00"); 0x0007 see below
4   4   uint32 1
8   8   total file size
16  4   number of handles N
20  32*N handles:
        8  offset of this block inside the file
        8  offset of the Blob record, from the start of the archive (after the header)
        16 MD5 hash of the decompressed block. Verified
...     a security descriptor follows (same layout as record type 2)
```
Blocks are normally 256 KiB of the file. A block's slot ends where the next block starts (or at the
total size); if its decompressed data is shorter, the rest of the slot is zeros (e.g. a 1 MiB journal
file stored as one 4,591-byte block). Verified.

Times (type 5): first value appears to be the creation time, second the modified time.

**Alternate data streams (not checked yet).** acronis-tib-reader found stream names such as
`:encryptable:$DATA` after the security descriptor: `uint32` stream id, `uint32 0`, `uint32` name length
in bytes, then the UTF-16 name. Files downloaded from the internet carry a `Zone.Identifier` stream, so
real backups have many. To check on a real backup: does such a file read back identical to the
original, and where is the stream's own data? (The kind 0x0007 tail below has the same
`uint32 1, uint32 0, uint32 n` shape.)

**Other True Image versions.** acronis-tib-reader read a True Image 2016 file backup with the same
record types and layout, so the format looks unchanged from 2016 to 2024. It also saw blocks that
decompress to one byte less than their slot (the zlib checksum matches the short data), a writer quirk.

**Kind 0x0007 (no stored data).** Seen once in 8,506 files: a 16,383-byte Android app cache file
(`pe_dropped.dat`). Its index has 0 handles, then the security descriptor, then `uint32 1`, `uint32 0`,
`uint32 16383` and 8 zero bytes (apparently one range covering the whole file). No data records exist
for it anywhere: its metadata directly follows the previous file's. The reader treats it as zeros (like
unstored tails) and warns. Whether the original was really all zeros (e.g. a preallocated file) or True
Image couldn't read it is unknown; a second example would help.


Listing (type 103)
------------------
```
uint32  number of entries
entries:
  uint32  path length in UTF-16 units, including the trailing NUL
  utf16   full path, e.g. "G:/Android/data", NUL-terminated
  uint32  size of the rest of this entry in 2-byte units
  uint32  name length (no NUL)
  utf16   name
  uint32  length of the "names" block in UTF-16 units
  utf16   name again with NUL, then 0x0002 and zero padding (purpose unknown)
  uint64  modified time, ms since 1970 (0 for the drive root)
  uint32  unknown hash; acronis-tib-reader saw siblings share it (probably a hash of the parent folder)
  uint64  size in bytes
  uint64  size again; acronis-tib-reader calls it the allocated size (rounded up to clusters)
  uint64  offset of the entry's FileMetaStart record (from the start of the archive)
  uint32  kind: 0x83 drive root, 0x80 folder, 0 file. Verified on all 9,212 entries
  uint64  offset of the FileMetaStart record again
  uint32  1
  uint32  unknown, same for every entry (volume id?)
  18      zero bytes
```
