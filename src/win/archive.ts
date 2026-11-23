import fs from 'node:fs';
import path from 'node:path';
import Archive from '../archive';
import Volume, { VolumeVersion } from '../volume';
import { Windows2015Volume } from './volume';
import WindowsSlice from './slice';
import { FormatError } from '../errors';
import { warn } from '../log';


// NAME_inc_b1_s2_v1.tib, and NAME_inc_b1_s2_v1-3.tib for the third attempt at that file
const WINDOWS_FILE_REGEX = /^(.*)_(full|inc|diff|[a-z]+)_b([0-9]+)_s([0-9]+)_v([0-9]+)(?:-([0-9]+))?\.tib$/i;

interface WinFilenameDesc {
	name: string;
	type: string; /**< 'full', 'inc', ... */
	backupNum: number;
	sliceNum: number;
	volumeNum: number;
	/**
	 * 1, or N for a "_v1-N.tib" file. True Image adds "-N" when it retries a backup point after an
	 * interrupted attempt, leaving the unfinished file of the earlier attempt behind (seen on a real backup).
	 */
	attemptNum: number;
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
		volumeNum: parseInt(m[5], 10),
		attemptNum: m[6] ? parseInt(m[6], 10) : 1
	};
}

type WinPart = { desc: WinFilenameDesc; volume: Windows2015Volume };

/**
 * Picks the files of one backup point: the newest attempt whose volumes are all there and whose last
 * volume has a footer. Returns null if no attempt was finished.
 */
async function completeAttempt(parts: WinPart[]): Promise<WinPart[] | null> {
	let attempts = [...new Set(parts.map((p) => p.desc.attemptNum))].sort((a, b) => b - a);

	for(let attempt of attempts) {
		let vols = parts.filter((p) => p.desc.attemptNum === attempt).sort((a, b) => a.desc.volumeNum - b.desc.volumeNum);
		let last = vols[vols.length - 1];
		if(!(await last.volume.readFooter()).isValid) {
			continue;
		}

		for(let i = 0; i < vols.length; i++) {
			if(vols[i].desc.volumeNum !== i + 1) {
				throw new FormatError('Gap in volume numbering at ' + vols[i].volume.fileName, 'missing-part');
			}
		}

		return vols;
	}

	return null;
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

		let parts: WinPart[] = [
			{ volume: initialVolume, desc }
		];
		let used: WinPart[] = [];

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

			// Every file of an archive has the same archive key. (The header's sequence number is the backup
			// point number, shared by all files of a point and its retries, so it can't order files.)
			for(let p of parts) {
				if(!p.volume.header.archiveKey.equals(initialVolume.header.archiveKey)) {
					throw new FormatError(p.volume.fileName + ' belongs to a different archive');
				}
			}

			let sliceNums = [...new Set(parts.map((p) => p.desc.sliceNum))].sort((a, b) => a - b);
			for(let n of sliceNums) {
				let ofSlice = parts.filter((p) => p.desc.sliceNum === n);
				let chosen = await completeAttempt(ofSlice);
				if(!chosen) {
					warn('Backup point ' + n + ' is skipped: none of its files (' + ofSlice.map((p) => path.basename(p.volume.fileName)).join(', ') +
						') has an end marker. The backup was probably interrupted, or its last file is missing.');
					continue;
				}

				let ignored = ofSlice.filter((p) => !chosen.includes(p));
				if(ignored.length > 0) {
					warn('Backup point ' + n + ': ignoring unfinished earlier attempts ' + ignored.map((p) => path.basename(p.volume.fileName)).join(', '));
				}

				let s = await WindowsSlice.Open(chosen.map((p) => p.volume), slices[slices.length - 1] || null, n);
				slices.push(s);
				used.push(...chosen);
			}

			if(slices.length === 0) {
				throw new FormatError('No finished backup point found (every file lacks its end marker; the backup may be incomplete)', 'missing-part');
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

		// Files of skipped attempts aren't part of the archive
		for(let p of parts) {
			if(!used.includes(p)) {
				await p.volume.close();
			}
		}

		return new WindowsArchive(desc.name, slices, used.map((p) => p.volume));
	}

	constructor(name: string, slices: WindowsSlice[], volumes: Volume[]) {
		super(name, slices, volumes);
	}
}

Archive.AddType(VolumeVersion.Windows, WindowsArchive.OpenImpl);
