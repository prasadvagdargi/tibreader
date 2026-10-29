import fs from 'node:fs';
import Slice, { SliceConfig, SliceKind } from '../slice';
import { SnapshotFS } from '../fs/types';
import { openSectorDisk, SectorDisk } from '../sector/open';
import { DiskFS } from '../disk/fs';
import { fileKey } from '../cachedir';
import { ListingRecord, ReadRecord, RecordType } from './record';
import { Windows2015Volume } from './volume';
import { ConcatenatedReader, Reader } from '../reader';
import { ParseConfigRecord } from './config';
import { FormatError, NotSupportedError } from '../errors';
import { warn } from '../log';
import { createBlockCache, LRUCache } from '../cache';
import { WindowsFS } from './fs';


// TODO: windows slices will need to store the type 'inc'/'full'

export enum SliceForm {
	Unknown = 0,
	FileSystem = 1,
	SectorBySector = 2
}

/**
 * Always located at the very end of each slice and indicates where in the archive the metadata for this slice starts
 */
export interface SliceTrailer {
	isValid: boolean;
	form: SliceForm; /**< TODO: Check that this is consistent across all slices in a single archive */
	metaDataOffset: number; /**< This will be the offset of the RecordType.Config block relative to the start of the archive (skipping all headers) such that each this slice starts at the sum of all sliceSizes before this one */
}

const FILE_SYSTEM_MAGIC = Buffer.from('2C8AE194', 'hex');
const SECTOR_BY_SECTOR_MAGIC = Buffer.from('2B8AE194', 'hex');


export default class WindowsSlice extends Slice {

	static async Open(volumes: Windows2015Volume[], parent: WindowsSlice|null): Promise<WindowsSlice> {

		// TODO: We can also detect which files are the end of a slice without the filenames by looking for which one has a valid footer (which combined with having valid footer offsets could be a robust check)

		let lastVolume = volumes[volumes.length - 1];
		let footer = await lastVolume.readFooter();
		if(!footer.isValid) {
			throw new FormatError('Invalid slice footer in ' + lastVolume.fileName);
		}

		let innerReaders: Reader[] = [];
		let s: WindowsSlice | undefined;

		try {
			let n = footer.sliceSize;
			for(let i = 0; i < volumes.length; i++) {
				let v = volumes[i];

				let maxSize = (await v.reader.length()) - v.startOffset();

				// The footer of the last volume isn't slice data
				if(i === volumes.length - 1) {
					maxSize -= footer.length;
				}

				let size = Math.min(maxSize, n);
				if(size <= 0) {
					throw new FormatError('Volume ' + v.fileName + ' is beyond the end of its slice');
				}

				n -= size;

				innerReaders.push(v.reader.slice(v.startOffset(), v.startOffset() + size));
			}

			if(n !== 0) {
				throw new FormatError('Not all slice data could be found (' + n + ' bytes missing)', 'missing-part');
			}

			// Ownership of the inner readers moves to the concatenated reader
			let reader = await ConcatenatedReader.Create(innerReaders);
			innerReaders = [];

			s = new WindowsSlice(volumes, parent, reader);

			s.absoluteReader = await (
				parent ? parent.absoluteReader.append(reader) : ConcatenatedReader.Create([ reader.slice() ])
			);

			s.trailer = await this.ReadTrailer(reader);

			if(!s.trailer.isValid) {
				throw new FormatError('Could not validate slice trailer');
			}

			s._fileTime = (await fs.promises.stat(lastVolume.fileName)).mtime;

			if(s.trailer.form === SliceForm.SectorBySector) {
				await s.openDisk(lastVolume.fileName);
			}
			else {
				await s.readMetadata();
			}

			return s;
		}
		catch(e) {
			for(let r of innerReaders) {
				await r.close();
			}

			if(s) {
				await s.close();
			}

			throw e;
		}
	}

	/**
	 * Given a reader that ends on at the end of a slice, this will read it's trailer
	 */
	private static async ReadTrailer(reader: Reader): Promise<SliceTrailer> {

		reader = reader.slice();

		try {
			let end = await reader.length();

			reader.seek(end - 4);
			let lastFour = await reader.readBytes(4);

			// TODO: Validate all of the offsets we are reading are actually with-in the bounds of the slice/files
			// TODO: All offsets must also not intersect with the header/footer of the file

			// File/directory-based backups. The trailer is just the metadata offset.
			if(lastFour.equals(FILE_SYSTEM_MAGIC)) {
				reader.seek(end - 12);
				let metaDataOffset = await reader.readUint64();

				return { isValid: true, form: SliceForm.FileSystem, metaDataOffset };
			}

			// Sector-by-sector backups. Partly understood; see doc/Format-Windows.md
			if(lastFour.equals(SECTOR_BY_SECTOR_MAGIC)) {
				return { isValid: true, form: SliceForm.SectorBySector, metaDataOffset: -1 };
			}

			warn('Unknown slice trailer magic: ' + lastFour.toString('hex'));
			return { isValid: false, form: SliceForm.Unknown, metaDataOffset: -1 };
		}
		finally {
			await reader.close();
		}
	}


	reader: Reader; /**< A reader over this single slice */
	absoluteReader!: ConcatenatedReader; /**< A reader over the entire archive up to this point (We don't need to use a full archive reader as we don't expect a slice to contain data from future not-yet created child slices). The totalReader of the final slice can be considering to completely cover the entire archive */

	trailer!: SliceTrailer;
	config: SliceConfig = {};
	listing!: ListingRecord;

	private _id?: Buffer;
	private _creationTime?: Date;
	private _fileTime?: Date;
	private _cache: LRUCache<number, Buffer> = createBlockCache<number>();
	private _closed = false;

	/** Disk-image backup points only */
	disk?: SectorDisk;
	private _diskCache = createBlockCache<string>();
	private _diskFs?: Promise<DiskFS>;

	private constructor(volumes: Windows2015Volume[], parent: WindowsSlice|null, reader: Reader) {
		super(volumes, parent);
		this.reader = reader;
	}

	override get kind(): SliceKind {
		return this.disk ? 'disk' : 'files';
	}

	/**
	 * Opens the image(s) of a sector-by-sector (disk/partition) backup point
	 */
	private async openDisk(lastFile: string) {
		let sliceStart = (await this.absoluteReader.length()) - (await this.reader.length());
		let parent = this.parent as WindowsSlice | null;

		this.disk = await openSectorDisk(this.absoluteReader, sliceStart, {
			cache: this._diskCache,
			id: 'slice' + sliceStart,
			indexKey: fileKey(lastFile, 'sector-slice@' + sliceStart),
			parent: parent && parent.disk ? parent.disk : null,
		});

		this.config = this.disk.config;
		let enc = this.config.encryption;
		if(enc && enc.toLowerCase() !== 'none') {
			throw new NotSupportedError('Encrypted backups are not supported (encryption: ' + enc + ')', 'encrypted');
		}
	}

	/**
	 * Reads the config and listing records that follow the trailer's metadata offset
	 */
	private async readMetadata() {
		let r = this.absoluteReader.slice();
		try {
			r.seek(this.trailer.metaDataOffset);
			let size = await r.length();

			while(r.pos() < size) {
				let rec = await ReadRecord(r);

				if(rec.type === RecordType.EndTrailer) {
					break;
				}
				else if(rec.type === RecordType.Listing) {
					if(this.listing) {
						throw new FormatError('Got multiple listings in one slice');
					}

					this.listing = rec;
				}
				// NOTE: slices sometimes have duplicate configurations. The last one wins.
				else if(rec.type === RecordType.Config) {
					if(rec.creationTime) {
						this._creationTime = rec.creationTime;
					}
					if(rec.id) {
						this._id = rec.id;
					}

					try {
						await ParseConfigRecord(rec, this.config);
					}
					catch(e: any) {
						warn('Could not fully parse slice configuration: ' + e.message);
					}

					// Encrypted data can't be read; say so instead of failing on garbage later
					let enc = this.config.encryption;
					if(enc && enc.toLowerCase() !== 'none') {
						throw new NotSupportedError('Encrypted backups are not supported (encryption: ' + enc + ')', 'encrypted');
					}
				}
			}
		}
		finally {
			await r.close();
		}

		if(!this.listing) {
			throw new FormatError('Slice is missing its file listing');
		}
	}

	/**
	 * 16 byte id from the slice configuration (falls back to the 4 byte slice key of the volume header)
	 */
	get id() {
		return this._id || this.volumes[0].header.sliceKey;
	}

	/**
	 * When the backup was made (falls back to when its last file was written)
	 */
	get creationTime() {
		return this._creationTime || this._fileTime || new Date(0);
	}

	async openFileSystem(): Promise<SnapshotFS> {
		if(this.disk) {
			if(!this._diskFs) {
				this._diskFs = DiskFS.Create(this.disk.images, this.creationTime);
				this._diskFs.catch(() => { this._diskFs = undefined; });
			}
			return this._diskFs;
		}
		return new WindowsFS(this.absoluteReader, this.listing.files, this._cache, this.creationTime);
	}

	async close() {
		if(this._closed) {
			return;
		}

		this._closed = true;
		this._cache.clear();
		this._diskCache.clear();
		await this.reader.close();
		if(this.absoluteReader) {
			await this.absoluteReader.close();
		}
	}
}
