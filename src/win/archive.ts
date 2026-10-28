import fs from 'node:fs';
import path from 'node:path';
import Archive from '../archive';
import Volume, { VolumeVersion } from '../volume';
import { Windows2015Volume } from './volume';
import WindowsSlice from './slice';
import { FormatError } from '../errors';


const WINDOWS_FILE_REGEX = /^(.*)_(full|inc|diff|[a-z]+)_b([0-9]+)_s([0-9]+)_v([0-9]+)\.tib$/i;

interface WinFilenameDesc {
	name: string;
	type: string; /**< 'full', 'inc', ... */
	backupNum: number;
	sliceNum: number;
	volumeNum: number;
}

export function parseWinFilename(fname: string): WinFilenameDesc|null {
	let m = WINDOWS_FILE_REGEX.exec(fname);
	if(!m) {
		return null;
	}

	return {
		name: m[1],
		type: m[2].toLowerCase(),
		backupNum: parseInt(m[3], 10),
		sliceNum: parseInt(m[4], 10),
		volumeNum: parseInt(m[5], 10)
	};
}

export default class WindowsArchive extends Archive {

	static async OpenImpl(initialVolume: Volume) {
		if(!(initialVolume instanceof Windows2015Volume)) {
			throw new Error('Called with wrong volume type');
		}

		// TODO: This could be more robust to renamed files, as the volume headers have enough checksummed data to rebuild the slice/backup indexes

		let desc = parseWinFilename(path.basename(initialVolume.fileName));
		if(!desc) {
			throw new FormatError('Unexpected file name (expected NAME_full_b1_s1_v1.tib style): ' + initialVolume.fileName, 'unexpected-name');
		}

		let dir = path.dirname(initialVolume.fileName);

		let parts: Array<{ desc: WinFilenameDesc; volume: Windows2015Volume }> = [
			{ volume: initialVolume, desc }
		];

		let slices: WindowsSlice[] = [];

		try {
			// Find the other volumes of this archive by file name
			let allFiles = await fs.promises.readdir(dir);
			for(let fname of allFiles) {

				if(fname === path.basename(initialVolume.fileName)) {
					continue;
				}

				let d = parseWinFilename(fname);

				// NOTE: Acronis allows different archives to have the same 'name' by incrementing the backupNum
				if(!d || d.name !== desc.name || d.backupNum !== desc.backupNum) {
					continue;
				}

				let v = await Volume.Open(path.join(dir, fname));
				if(!(v instanceof Windows2015Volume)) {
					await v.close();
					throw new FormatError('Expected ' + fname + ' to be a Windows backup file');
				}

				parts.push({ desc: d, volume: v });
			}

			parts.sort((a, b) => a.volume.header.sequence - b.volume.header.sequence);

			// Every file of an archive has a unique, consecutive sequence number and the same archive key
			for(let i = 0; i < parts.length; i++) {
				if(parts[i].volume.header.sequence !== i + 1) {
					throw new FormatError('Missing or extra backup files (sequence number ' + parts[i].volume.header.sequence + ' found where ' + (i + 1) + ' was expected)', 'missing-part');
				}

				if(!parts[i].volume.header.archiveKey.equals(initialVolume.header.archiveKey)) {
					throw new FormatError(parts[i].volume.fileName + ' belongs to a different archive');
				}
			}

			// TODO: Eventually support missing slices as long as there is a full slice that later incremental slices build on

			// Each slice takes the next run of volumes that share its slice number
			let i = 0;
			while(i < parts.length) {
				let vols: Windows2015Volume[] = [];

				let j = i;
				for(; j < parts.length; j++) {
					if(parts[j].desc.sliceNum !== slices.length + 1) {
						break;
					}

					if(parts[j].desc.volumeNum !== vols.length + 1) {
						throw new FormatError('Gap in volume numbering at ' + parts[j].volume.fileName, 'missing-part');
					}

					vols.push(parts[j].volume);
				}

				if(vols.length === 0) {
					throw new FormatError('Gap in slice numbering at ' + parts[i].volume.fileName);
				}

				let s = await WindowsSlice.Open(vols, slices[slices.length - 1] || null);
				slices.push(s);

				// Continue after the volumes this slice used
				i = j;
			}
		}
		catch(e) {
			for(let s of slices) {
				await s.close();
			}

			// The initial volume is closed by Archive.Open
			for(let p of parts) {
				if(p.volume !== initialVolume) {
					await p.volume.close();
				}
			}

			throw e;
		}

		return new WindowsArchive(desc.name, slices, parts.map((p) => p.volume));
	}

	constructor(name: string, slices: WindowsSlice[], volumes: Volume[]) {
		super(name, slices, volumes);
	}
}

Archive.AddType(VolumeVersion.Windows, WindowsArchive.OpenImpl);
