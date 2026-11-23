import Volume, { VolumeVersion, VolumeHeader } from "../volume";
import { Reader, readUint64LE } from '../reader';
import { warn } from '../log';


/**
 * Present in the last volume of a slice and describes the size of the slice it is in
 */
export interface VolumeFooter {
	isValid: boolean;
	length: number; /**< Number of bytes at the end of the file that this footer takes up */
	sliceSize: number; /**< Number of bytes in this slice (this number is counted as every byte after the headers up to the last meaninful byte in this last file) */
}

const FOOTER_SIZE = 48;


export class Windows2015Volume extends Volume {

	static async OpenImpl(fileName: string, reader: Reader, header: VolumeHeader) {
		return new Windows2015Volume(fileName, reader, header);
	}


	/**
	 * Offset at which data begins
	 */
	startOffset() {
		return this.header.length; // Should always be 32
	}

	async readFooter(): Promise<VolumeFooter> {

		let reader = this.reader.slice();

		try {
			let size = await reader.length();
			if(size < this.header.length + FOOTER_SIZE) {
				warn('Volume ' + this.fileName + ' is too small to have a footer');
				return { isValid: false, sliceSize: 0, length: FOOTER_SIZE };
			}

			if(size % this.header.blockSize !== 0) {
				// Most likely the backup did not finish being written
				warn('Volume ' + this.fileName + ' is not block aligned (incomplete?)');
			}

			reader.seek(size - FOOTER_SIZE);

			let buf = await reader.readBytes(FOOTER_SIZE);

			// The end of the file should contain an exact mirror image of the header
			let isValid = true;
			for(let i = 0; i < this.header.length; i++) {
				if(this.header.rawBytes[i] !== buf[buf.length - i - 1]) {
					isValid = false;
					break;
				}
			}

			// An unfinished file (interrupted backup) just ends in data
			if(!isValid) {
				return { isValid, sliceSize: 0, length: FOOTER_SIZE };
			}

			// Counted from the end of the header of the first volume of the slice
			let sliceSize = readUint64LE(buf, buf.length - this.header.length - 8);

			return { isValid, sliceSize, length: FOOTER_SIZE };
		}
		finally {
			await reader.close();
		}
	}

}

Volume.AddType(VolumeVersion.Windows, Windows2015Volume.OpenImpl);
