Sector-by-sector (disk image) .tib format notes
===============================================

What `src/sector/` implements. **None of this has been checked against a real file here**: it comes from
acronis-tib-reader (`docs/FORMAT.md`, `docs/FORMAT_LEGACY.md`, `docs/legacy/FORMAT_DISK_CHUNKMAP.md`,
code in `tibread/chunkmap*.py`), whose author checked it against a 1 TB True Image 2018+ backup and an
8 GB True Image 2014 backup. Tests use synthetic files from `test/helpers/sector-fixture.ts`.
All integers are little-endian. "Archive offset" means an offset in the archive's data (all slices'
data concatenated, headers and footers left out), as for file backups.


File layout
-----------
Same 32-byte header, 48-byte footer and split-file rules as file backups (`Format-Windows.md`).
The slice data ends with a trailer:
```
[blocks ...] [chunk map, other streams (modern)] [metadata area] [trailer body] [uint32 body size] [2B 8A E1 94]
```

Trailer body: tag/length records (`src/sector/tlv.ts`): `uint16 tag`, a length byte (top bit set: two
bytes, big-endian, 15 bits), the value.

| Tag | Meaning |
|-----|---------|
| `0x0000` | archive offset of the metadata area (5 bytes in 2014, 6 in 2018+) |
| `0x0001` | 2 bytes, unknown |
| `0x8000` | partition size in bytes |
| `0x8001` | same again |
| `0x8007` | metadata offset + 48 (unknown purpose) |


Blocks
------
```
[cluster bitmap] [zlib stream of the clusters whose bit is set, back to back]
```
| | Bitmap | Clusters per block | Block |
|---|---|---|---|
| True Image 2018+ ("modern") | 16 bytes | 128 x 4 KiB | 512 KiB |
| True Image 2014-2016 ("legacy") | 8 bytes | 64 x 4 KiB | 256 KiB |

Bit `i` (LSB first) is set if cluster `i` of the block was backed up; clear bits read as zeros (unused
space). Most blocks use deflate "stored" (uncompressed) blocks inside the zlib stream, so their end can
be found from 5-byte headers without decompressing (`src/sector/deflate.ts`).

About 4% of blocks are written out of order (True Image compresses in parallel), so blocks are found
through the chunk map, never by position.


Chunk map
---------
One entry per block of the image, in image order: where the block is and how many bytes it takes
(bitmap + zlib stream). Length 0 means not stored (zeros; for incremental backup points, see below).

Encoding (`src/sector/chunkmap.ts`):
1. Header: `[uint8 L] [L bytes of tag/length records]`: tag 2 bytes per sector, 3 sectors per cluster,
   4 clusters per block, 6 number of records. Tags `0xC7`/`0xDF` mean 20-byte records (whole-disk and
   "hybrid" maps; the extra 8 bytes are ignored here and this case gives a warning).
2. A zlib stream of N records of 12 bytes, stored column by column (byte 0 of every record, then byte 1...).
3. Each record: `uint64` offset delta, `uint32` length. The delta is zigzag-coded (bit 0 = sign, the rest
   = magnitude, negative = `-magnitude`) and relative to the end of the previous record's block.

Where it is:
- **Modern:** after the blocks, as one region. The metadata area holds the 13 bytes
  `06 <6-byte archive offset> 01 00 03 <3-byte region size>` (acronis-tib-reader found them inside a
  record with tag `0x9B`). The rest of the metadata area isn't understood, so the reader searches for
  this pattern and checks the values make sense. Several matches with different offsets are read as
  several images ("Volume 1", "Volume 2"; one per partition, presumably).
- **Legacy:** split into records between the blocks, each `[uint8 L] [L bytes of records] [zlib]`
  with the same encoding; each one covers the next run of image blocks and decodes on its own. Finding
  them means walking every block once (minutes for big files), so the result is cached in the user's
  cache folder (`src/cachedir.ts`; `TIB_CACHE_DIR` overrides it, `TIB_NO_CACHE=1` turns it off),
  never next to the backup.


Other parts
-----------
- **Settings (metainfo XML):** modern files keep it in one of the streams after the chunk map (bare
  zlib, or `[uint8 L][L bytes][zlib]`); legacy files embed a zlib stream of it in the metadata area. The
  reader takes product, task id, computer id, compression and encryption from it.
- **Checks:** zlib's Adler-32 on every block, and the decompressed size must match the bitmap. An MD5
  per stored block (of bitmap + data) is also stored after the data; its exact location isn't known, so
  it isn't used yet.
- **Not used:** the bitmap mirror, Windows dynamic-disk (LDM) copies, the dedup filter.


Assumptions not backed by any real file
---------------------------------------
- **Incremental backup points:** a block that isn't stored is read from the previous backup point.
  acronis-tib-reader had no incremental sample; this is the simplest model that fits.
- **Offsets are archive offsets** (from the start of the first backup point's data), like file backups.
  For single files this is the same as acronis-tib-reader's "offset after the header".
- **Several chunk maps in one backup point** are separate partitions.
- **Encrypted disk images** are recognized from the metainfo XML only.
