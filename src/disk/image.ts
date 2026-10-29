import { Reader } from '../reader';


/**
 * Random-access bytes of a disk or partition image (sector-by-sector .tib, .tibx, or a part of one)
 */
export interface DiskImage {
	/** Size in bytes */
	readonly size: number;

	/**
	 * Reads [offset, offset + length), clamped to the image size. Areas that weren't backed up
	 * (unused clusters) read as zeros.
	 */
	read(offset: number, length: number): Promise<Buffer>;
}

/**
 * A window [start, start + size) of another image (e.g. one partition of a disk)
 */
export class SubImage implements DiskImage {
	constructor(private _parent: DiskImage, private _start: number, readonly size: number) {
		if(_start < 0 || size < 0 || _start + size > _parent.size) {
			throw new RangeError('Part of the image is outside of it (' + _start + '+' + size + ' > ' + _parent.size + ')');
		}
	}

	read(offset: number, length: number): Promise<Buffer> {
		let end = Math.min(offset + length, this.size);
		if(offset >= end) {
			return Promise.resolve(Buffer.alloc(0));
		}
		return this._parent.read(this._start + offset, end - offset);
	}
}

/**
 * An image held in memory (tests, small images)
 */
export class BufferImage implements DiskImage {
	constructor(private _buf: Buffer) {}

	get size() {
		return this._buf.length;
	}

	async read(offset: number, length: number): Promise<Buffer> {
		let end = Math.min(offset + length, this._buf.length);
		if(offset >= end) {
			return Buffer.alloc(0);
		}
		return Buffer.from(this._buf.subarray(offset, end));
	}
}

/**
 * Reads exactly 'length' bytes at 'offset' without moving the reader
 */
export async function readAt(reader: Reader, offset: number, length: number): Promise<Buffer> {
	let r = reader.slice();
	try {
		r.seek(offset);
		return await r.readBytes(length);
	}
	finally {
		await r.close();
	}
}

/**
 * Reads [offset, offset + length) of an image into one buffer, failing if the image is shorter
 */
export async function readExact(image: DiskImage, offset: number, length: number): Promise<Buffer> {
	let b = await image.read(offset, length);
	if(b.length !== length) {
		throw new RangeError('Read of ' + length + ' bytes at ' + offset + ' runs past the end of the image');
	}
	return b;
}
