import fs from 'node:fs';
import Volume, { VolumeVersion } from './volume';
import Slice from './slice';
import { NotSupportedError } from './errors';


type ArchiveGenerator = (initialVolume: Volume) => Promise<Archive>;
const ArchiveImpls: { [v: number]: ArchiveGenerator } = {};


/**
 * A chain of backups (slices) stored in one or more .tib files (volumes)
 */
export default abstract class Archive {

	/**
	 * Opens an archive given the name of any file in the archive. Files are only ever read.
	 *
	 * NOTE: Formats register themselves when imported. Import from the package root ('tibreader'),
	 * which loads both the Mac and Windows formats.
	 */
	static async Open(fileName: string): Promise<Archive> {

		// Normalize in case the name of a Mac metadata file was given
		fileName = fileName.replace(/\.tib\.metadata$/i, '.tib');

		if(!fs.existsSync(fileName)) {
			throw new Error('File not found: ' + fileName);
		}

		let initialVolume = await Volume.Open(fileName);

		let Gen = ArchiveImpls[initialVolume.header.version];
		if(!Gen) {
			await initialVolume.close();
			throw new NotSupportedError('No archive implementation for volume type ' + initialVolume.header.version);
		}

		// TODO: Ensure proper checksum in all file headers and run the whole verification process consistently
		// TODO: Verify headers/trailers in every single volume (in terms of checksums and the fact that they match in bytes)

		// The archive keeps using the initial volume, so only close it here if opening fails.
		// Otherwise Archive.close() is responsible for closing it.
		try {
			return await Gen(initialVolume);
		}
		catch(e) {
			await initialVolume.close();
			throw e;
		}
	}

	public static AddType(v: VolumeVersion, fn: ArchiveGenerator) {
		if(ArchiveImpls[v]) {
			throw new Error('Duplicate implementation of archive type: ' + v);
		}

		ArchiveImpls[v] = fn;
	}

	private _closed = false;

	/**
	 * Closes every slice and volume. Calling it more than once is harmless.
	 */
	async close() {
		if(this._closed) {
			return;
		}

		this._closed = true;

		for(let s of this.slices) {
			await s.close();
		}

		for(let v of this.volumes) {
			await v.close();
		}
	}

	protected constructor(name: string, slices: Slice[], volumes: Volume[]) {
		this.name = name;
		this.slices = slices;
		this.volumes = volumes;
	}

	/**
	 * Name of this archive, as it would appear in acronis upon being opened
	 */
	public name: string;

	/** Backup points, oldest first */
	public slices: Slice[];

	/** .tib files of this archive, in creation order */
	public volumes: Volume[];

	/**
	 * Gets a backup point by its 1-based number (oldest is 1). Negative numbers count from the newest (-1 is the latest).
	 */
	getSlice(n: number = -1): Slice {
		let idx = n < 0 ? this.slices.length + n : n - 1;
		let s = this.slices[idx];
		if(!s) {
			throw new RangeError('No backup point ' + n + ' (archive has ' + this.slices.length + ')');
		}

		return s;
	}
}
