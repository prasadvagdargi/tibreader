/**
 * tibreader: read, verify, extract and mount Acronis True Image (.tib) backups.
 *
 * Importing this module registers both supported formats (Windows and Mac).
 */
import Archive from './archive';

// Each format registers itself with Archive/Volume when loaded
import './mac/index';
import './win/index';

export { Archive };
export { default as Slice } from './slice';
export type { SliceConfig, ProductInfo } from './slice';
export { default as Volume, VolumeVersion } from './volume';
export type { VolumeHeader } from './volume';
export type { FsEntry, SnapshotFS, EntryType } from './fs/types';
export { WindowsFS } from './win/fs';
export { MacFS } from './mac/fs';
export { FormatError, NotSupportedError } from './errors';
export { setWarningHandler } from './log';
export type { WarningHandler } from './log';

/**
 * Opens a backup given any of its files (.tib or .tib.metadata). Files are only ever read.
 * Call close() on the result when done.
 */
export function openArchive(fileName: string): Promise<Archive> {
	return Archive.Open(fileName);
}
