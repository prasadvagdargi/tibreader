/**
 * tibreader: read, verify, extract and mount Acronis True Image (.tib) backups.
 *
 * Importing this module registers both supported formats (Windows and Mac).
 */
import Archive from './archive';

// Each format registers itself with Archive/Volume when loaded
import './mac/index';
import './win/index';
// File systems inside disk images
import './ntfs/fs';

export { Archive };
export type { ArchiveFormat, ArchiveFile } from './archive';
export { detectFormat, detectFromBytes } from './detect';
export type { DetectedFormat, FormatKind } from './detect';
export { default as Slice } from './slice';
export type { SliceConfig, ProductInfo, SliceKind } from './slice';
export { default as Volume, VolumeVersion } from './volume';
export type { VolumeHeader } from './volume';
export type { FsEntry, SnapshotFS, EntryType } from './fs/types';
export { WindowsFS } from './win/fs';
export { MacFS } from './mac/fs';
export { DiskFS } from './disk/fs';
export type { DiskVolumeInfo } from './disk/fs';
export type { DiskImage } from './disk/image';
export type { Partition, PartitionTable } from './disk/partitions';
export { NtfsFS } from './ntfs/fs';
export { FormatError, NotSupportedError } from './errors';
export type { ErrorCode } from './errors';
export { setWarningHandler } from './log';
export type { WarningHandler } from './log';

// Getting files out
export { extract, extractItems, measure, safeFileName } from './fs/extract';
export type { ExtractOptions, ExtractResult, ExtractProgress, ConflictPolicy, ConflictChoice } from './fs/extract';

// Checking and describing backups
export { verifySnapshot, verifyHeaders } from './verify';
export type { VerifyOptions, VerifyResult, VerifyProgress, VerifyProblem } from './verify';
export { describeArchive } from './info';
export type { ArchiveDescription, SliceDescription, DescribeOptions } from './info';

// Mounting
export { WebDavServer } from './mount/webdav';
export type { WebDavOptions } from './mount/webdav';
export { RcloneMount, findRclone, findWinFsp, freeDriveLetters, normalizeDriveTarget } from './mount/rclone';

/**
 * Opens a backup given any of its files (.tib or .tib.metadata). Files are only ever read.
 * Call close() on the result when done.
 */
export function openArchive(fileName: string): Promise<Archive> {
	return Archive.Open(fileName);
}
