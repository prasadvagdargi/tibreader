import Archive from './archive';
import Slice, { SliceConfig } from './slice';
import { VolumeVersion } from './volume';
import { SnapshotFS } from './fs/types';
import { measure } from './fs/extract';


export interface ArchiveDescription {
	name: string;
	format: 'Windows' | 'Mac';
	volumes: Array<{ file: string; size: number; headerChecksumOk: boolean }>;
	slices: SliceDescription[];
}

export interface SliceDescription {
	/** 1 is the oldest */
	number: number;
	/** Hex */
	id: string;
	/** ISO 8601 */
	created: string;
	incremental: boolean;
	config: SliceConfig;
	/** Only when asked for: what the backup point holds */
	contents?: { files: number; folders: number; bytes: number };
}

export interface DescribeOptions {
	/** Count each backup point's files, folders and bytes (default true; reads every backup point's file list) */
	contents?: boolean;
	/** Returns the file system of a slice, e.g. from a cache (default: slice.openFileSystem()) */
	openFileSystem?: (slice: Slice) => Promise<SnapshotFS>;
}

/**
 * Plain-data summary of a backup (what 'tib info --json' prints): its files, backup points and settings
 */
export async function describeArchive(archive: Archive, opts: DescribeOptions = {}): Promise<ArchiveDescription> {
	let format: 'Windows' | 'Mac' = archive.volumes[0].header.version === VolumeVersion.Windows ? 'Windows' : 'Mac';
	let openFs = opts.openFileSystem || ((s: Slice) => s.openFileSystem());

	let volumes = await Promise.all(archive.volumes.map(async (v) => ({
		file: v.fileName,
		size: await v.reader.length(),
		headerChecksumOk: v.header.checkSumValid
	})));

	let slices: SliceDescription[] = [];
	for(let i = 0; i < archive.slices.length; i++) {
		let s = archive.slices[i];
		let d: SliceDescription = {
			number: i + 1,
			id: s.id.toString('hex'),
			created: s.creationTime.toISOString(),
			incremental: s.parent !== null,
			config: s.config,
		};

		if(opts.contents !== false) {
			let m = await measure(await openFs(s));
			d.contents = { files: m.files, folders: m.directories, bytes: m.bytes };
		}

		slices.push(d);
	}

	return { name: archive.name, format, volumes, slices };
}
