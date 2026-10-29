import fs from 'node:fs';
import Volume, { VolumeVersion } from './volume';
import Slice from './slice';
import { FormatError, NotSupportedError } from './errors';
import { detectFormat, FormatKind } from './detect';


type ArchiveGenerator = (initialVolume: Volume) => Promise<Archive>;
const ArchiveImpls: { [v: number]: ArchiveGenerator } = {};

export interface OpenOptions {
	/** Password for encrypted backups (experimental; .tibx only) */
	password?: string;
}

/** Opens formats that don't start with a .tib volume header (e.g. .tibx) */
type FileArchiveGenerator = (fileName: string, options: OpenOptions) => Promise<Archive>;
const FileImpls: { [kind: string]: FileArchiveGenerator } = {};

export type ArchiveFormat = 'Windows' | 'Mac' | 'tibx';

/** One file on disk that belongs to a backup */
export interface ArchiveFile {
	fileName: string;
	size: number;
	/** Whether the file's own header checksum matched (true when the format has none) */
	headerChecksumOk: boolean;
}


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
	static async Open(fileName: string, options: OpenOptions = {}): Promise<Archive> {

		// Normalize in case the name of a Mac metadata file was given
		fileName = fileName.replace(/\.tib\.metadata$/i, '.tib');

		if(!fs.existsSync(fileName)) {
			throw new Error('File not found: ' + fileName);
		}

		let detected = await detectFormat(fileName);
		if(detected.kind !== 'tib') {
			let open = FileImpls[detected.kind];
			if(open) {
				return open(fileName, options);
			}

			if(detected.kind === 'unknown') {
				throw new FormatError('Not a .tib or .tibx file (unknown format)', 'not-a-backup');
			}

			let advice = detected.kind === 'tib-very-old'
				? ' True Image 2018 and later convert these files when they open them; after that, this library can read them.'
				: '';
			throw new NotSupportedError('This is a ' + detected.description + ', which can\'t be read yet.' + advice);
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

	/**
	 * Registers an opener for a format recognized by detectFormat() that has no .tib volume header
	 */
	public static AddFileType(kind: FormatKind, fn: FileArchiveGenerator) {
		if(FileImpls[kind]) {
			throw new Error('Duplicate implementation of archive format: ' + kind);
		}

		FileImpls[kind] = fn;
	}

	/** Which format family this backup uses */
	get format(): ArchiveFormat {
		return this.volumes[0] && this.volumes[0].header.version === VolumeVersion.Mac ? 'Mac' : 'Windows';
	}

	/** The files on disk that make up this backup */
	async files(): Promise<ArchiveFile[]> {
		return Promise.all(this.volumes.map(async (v) => ({
			fileName: v.fileName,
			size: await v.reader.length(),
			headerChecksumOk: v.header.checkSumValid
		})));
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
