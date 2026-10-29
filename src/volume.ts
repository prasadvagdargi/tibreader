import { ComputeAdler32 } from './utils';
import { Reader, FileReader } from './reader';
import { FormatError, NotSupportedError } from './errors';
import { warn } from './log';


const VOLUME_MAGIC = 0xA2B924CE;


export enum VolumeVersion {
	Windows = 0,
	Mac = 1
}

export interface VolumeHeader {
	rawBytes: Buffer;

	length: number; /**< Length in bytes of the header */
	version: VolumeVersion;
	sequence: number; /**< Index of this file in the archive. Incremented every single time a new file is created whether it be a volume, slice, etc. These provide a total ordering of alla files in an archive */

	// NOTE: I don't call these identifiers, because TI has separate 16-byte UUIDs stored in the files to be the identifiers
	archiveKey: Buffer; /**< Random 4byte identifier common to all files in this volume */
	sliceKey: Buffer; /**< Random 4bytes to identify this slice */
	volumeKey: Buffer; /**< Random 4bytes to identify this volume */

	checkSumValid: boolean; /**< Whether or the checksum of the header is valid */

	blockSize: number;
}


type VolumeGenerator = (fileName: string, reader: Reader, header: VolumeHeader) => Promise<Volume>;
const VolumeImpls: { [v: number]: VolumeGenerator } = {};

// Large enough for every header variant seen so far (Mac: 36 bytes, Windows: 32 bytes)
const HEADER_READ_SIZE = 64;


export default abstract class Volume {
	/**
	 * Given a .tib file, this will open it (read-only) and load basic information on it
	 */
	public static async Open(fileName: string) {
		let reader = await FileReader.Create(fileName);

		try {
			let header = await this.LoadHeader(reader);

			let Gen = VolumeImpls[header.version];
			if(!Gen) {
				throw new NotSupportedError('Unknown volume type ' + header.version + ' in ' + fileName);
			}

			let vol = await Gen(fileName, reader, header);

			if(!vol.validateHeader()) {
				warn('Volume ' + fileName + ' has a suspicious header');
			}

			return vol;
		}
		catch(e) {
			await reader.close();
			throw e;
		}
	}

	private static async LoadHeader(reader: Reader): Promise<VolumeHeader> {

		if((await reader.length()) < HEADER_READ_SIZE) {
			throw new FormatError('File is too small to be a .tib volume');
		}

		reader.seek(0);

		let headerBlock = await reader.readBytes(HEADER_READ_SIZE);

		let magic = headerBlock.readUInt32LE(0);
		if(magic !== VOLUME_MAGIC) {
			throw new FormatError('Not a .tib file (wrong magic number)', 'not-a-backup');
		}

		// Should be 24 00 01 00 for Mac
		let headerLength = headerBlock.readUInt16LE(4);
		let version = headerBlock.readUInt16LE(6); // < 01 is Mac, 00 is windows

		// True Image 2010-2013 Windows files also say version 1, but have the shorter Windows header
		if(version === 1 && headerLength === 0x20) {
			throw new NotSupportedError('This is a .tib from True Image 2010-2013, which can\'t be read yet');
		}

		if(headerLength < 0x20 || headerLength > HEADER_READ_SIZE) {
			throw new FormatError('Unexpected volume header length: ' + headerLength);
		}

		// Random bytes created at the time of volume creation
		let identifiers = headerBlock.subarray(8, 8 + 12);

		// This will start at 1 and will be incremented for every file in a backup split into multiple files
		let sequence = headerBlock.readUInt32LE(20);

		let headerSum = headerBlock.readUInt32LE(0x18);

		// Checksum the header with the checksum field (and anything after the header up to 0x24) zeroed,
		// which matches what True Image does
		let sumBlock = Buffer.from(headerBlock);
		for(let i = headerLength; i < 0x24; i++) { sumBlock[i] = 0; }
		sumBlock.writeUInt32LE(0, 0x18);

		let isSumValid = ComputeAdler32(sumBlock.subarray(0, headerLength)) === headerSum;

		// Should usually be 4096 (Mac) or 32 (Windows)
		// NOTE: True Image supports a max block size of 0x10000
		let blockSize = headerBlock.readUInt32LE(0x1c);
		if(blockSize === 0 || blockSize > 0x10000) {
			throw new FormatError('Unexpected volume block size: ' + blockSize);
		}

		return {
			rawBytes: Buffer.from(headerBlock.subarray(0, headerLength)),
			length: headerLength,
			version: version,
			archiveKey: Buffer.from(identifiers.subarray(0, 4)),
			sliceKey: Buffer.from(identifiers.subarray(4, 8)),
			volumeKey: Buffer.from(identifiers.subarray(8, 12)),
			sequence: sequence,
			checkSumValid: isSumValid,
			blockSize: blockSize
		};
	}

	/**
	 * Registers a new implementation of a volume format
	 *
	 * NOTE: Don't use this externally. This is mainly for internal usage
	 */
	public static AddType(v: VolumeVersion, fn: VolumeGenerator) {
		if(VolumeImpls[v]) {
			throw new Error('Duplicate implementation of volume type: ' + v);
		}

		VolumeImpls[v] = fn;
	}

	public fileName: string;
	public header: VolumeHeader;
	public reader: Reader;

	protected constructor(fileName: string, reader: Reader, header: VolumeHeader) {
		this.fileName = fileName;
		this.reader = reader;
		this.header = header;
	}

	close() {
		return this.reader.close();
	}


	/**
	 * Depending on the format version, we do expect certain values (i.e. block size, length, etc.) to be pretty predictable. This will verify that those values are what we expect them to be
	 *
	 * NOTE: Even if you don't use this, you SHOULD STILL check that the header checksum is valid
	 *
	 * This is essentially a soft way of sanity checking that the volume seems valid
	 * While this is not a definitive check for validitity, it is a very good sign in if returns true and we haven't seen any samples yet that would contradict these rules
	 */
	validateHeader(): boolean {
		if(!this.header.checkSumValid) {
			return false;
		}

		if(this.header.version === VolumeVersion.Mac) {
			if(this.header.length !== 0x24 || this.header.blockSize !== 4096 || this.header.sequence !== 1) {
				return false;
			}

		}
		else if(this.header.version === VolumeVersion.Windows) {
			if(this.header.length !== 0x20 || this.header.blockSize !== 32) {
				return false;
			}
		}
		else {
			// Unknown version
			return false;
		}

		return true;
	}
}
