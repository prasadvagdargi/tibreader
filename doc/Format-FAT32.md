FAT32 volume notes
==================

What `src/fat/fs.ts` reads. FAT32 is publicly documented (Microsoft's "FAT: General Overview of On-Disk
Format"); these notes only record what the reader relies on. **Checked against a real volume**
(November 2026): the 72 MiB EFI system partition in a True Image 25.7 `.tibx` disk backup (Windows,
"MSDOS5.0", 512-byte sectors, 4 KiB clusters). All 165 files read in full; `bootmgfw.efi` and
`memtest.efi` are byte-identical to the copies on the same disk's NTFS volume.
Integers are little-endian.


Boot sector
-----------
`11` bytes per sector, `13` sectors per cluster, `14` reserved sectors, `16` number of FATs, `17` root
entries (0), `19` total sectors (16-bit, 0), `22` FAT size (16-bit, 0), `32` total sectors, `36` FAT size
in sectors, `44` root folder cluster, `71` label (11 bytes; "NO NAME" means none), `82` "FAT32   ",
`510` `55 AA`.

A volume counts as FAT32 when the BPB says so (root entries 0, 16-bit FAT size 0, 32-bit FAT size set),
not by cluster count: Windows formats small EFI partitions as FAT32 with fewer clusters than the
specification's FAT32 minimum (the real one has about 18,000).

Layout: reserved sectors, the FATs, then the data area starting at cluster 2.


FAT
---
One `uint32` per cluster; the low 28 bits count. `>= 0x0FFFFFF8` ends a chain, `0x0FFFFFF7` is a bad
cluster, `0` is free. A chain that reaches a free or bad cluster, or leaves the data area, is reported
as damaged. FAT copies after the first aren't read.


Folder entries (32 bytes)
-------------------------
```
0   11  8.3 name (space padded); first byte 0x00 ends the folder, 0xE5 deleted, 0x05 means a real 0xE5
11  1   attributes: 0x01 read-only, 0x02 hidden, 0x04 system, 0x08 volume label, 0x10 folder,
        0x0F = long-name entry
12  1   Windows case flags: 0x08 base name in lowercase, 0x10 extension in lowercase
14  2   created time, 16 created date
18  2   last access date
20  2   high 16 bits of the first cluster
22  2   modified time, 24 modified date
26  2   low 16 bits of the first cluster
28  4   size in bytes (0 for folders)
```
DOS dates: day bits 0-4, month 5-8, year since 1980 9-15. Times: seconds/2 bits 0-4, minutes 5-10,
hours 11-15. They are the local time of the computer that wrote them (no time zone); the reader shows
them in this computer's time zone.

Long names precede their 8.3 entry, last part first (sequence number with `0x40`). Each holds 13 UTF-16
units at offsets 1 (5), 14 (6) and 28 (2), ended by `0x0000` and padded with `0xFFFF`; byte 13 is a
checksum of the 8.3 name, and a long name whose checksum doesn't match is ignored (the 8.3 name is used).

The volume label is the root folder's entry with attribute `0x08`, else the boot sector's.

Not supported: FAT12/FAT16 (fixed root folder), exFAT, writing.
