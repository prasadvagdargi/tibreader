import fs from 'node:fs/promises';
import search from './search';
import { FormatError } from './errors';

/**
 * Largest single read we allow. Size fields in a corrupt file could otherwise ask for gigabytes of memory.
 */
export const MAX_READ_SIZE = 256 * 1024 * 1024;


function checkReadSize(n: number) {
	if(!Number.isSafeInteger(n) || n < 0) {
		throw new RangeError('Invalid read size: ' + n);
	}

	if(n > MAX_READ_SIZE) {
		throw new RangeError('Read of ' + n + ' bytes is larger than the limit of ' + MAX_READ_SIZE);
	}
}

/**
 * Generic interface for reading little-endian binary data
 */
export abstract class Reader {

	/**
	 * Releases this reader. Calling it more than once is harmless.
	 */
	abstract close(): Promise<void>;

	/**
	 * Current position of the reader
	 */
	abstract pos(): number;

	/**
	 * Total size of the reader in bytes
	 */
	abstract length(): Promise<number>;

	/**
	 * Changes the absolute position of the reader
	 */
	abstract seek(pos: number): void;

	/**
	 * Advances the current position by this amount (may be negative)
	 */
	skip(count: number): void {
		this.seek(this.pos() + count);
	}

	/**
	 * Gets a new, independently seekable reader over [start, end) of this one.
	 * The new reader must be closed separately.
	 */
	abstract slice(start?: number, end?: number): Reader;

	/**
	 * Reads exactly 'len' bytes at the current position and advances past them.
	 * The returned buffer is never shared with the reader's internal storage.
	 */
	abstract readBytes(len: number): Promise<Buffer>;

	async readUint8(): Promise<number> {
		return (await this.readBytes(1)).readUInt8(0);
	}

	async readUint16(): Promise<number> {
		return (await this.readBytes(2)).readUInt16LE(0);
	}

	async readUint24(): Promise<number> {
		return (await this.readBytes(3)).readUIntLE(0, 3);
	}

	async readUint32(): Promise<number> {
		return (await this.readBytes(4)).readUInt32LE(0);
	}

	/**
	 * Reads an unsigned 64-bit integer. Throws if it can't be represented exactly as a JS number.
	 */
	async readUint64(): Promise<number> {
		return readUint64LE(await this.readBytes(8), 0);
	}

	async readStringU16(len: number): Promise<string> {
		return (await this.readBytes(len * 2)).toString('utf16le');
	}
}

/**
 * Reads an unsigned 64-bit little-endian integer from a buffer.
 * Throws a RangeError instead of silently losing precision above 2^53.
 */
export function readUint64LE(buf: Buffer, offset: number): number {
	let v = buf.readBigUInt64LE(offset);
	if(v > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError('64-bit value is too large: 0x' + v.toString(16));
	}

	return Number(v);
}


interface SharedHandle {
	handle: fs.FileHandle;
	refs: number;
}

/**
 * Reads from a file on disk. Files are always opened read-only.
 *
 * Slices share one OS file handle, which is closed once every slice and the original reader are closed.
 */
export class FileReader extends Reader {

	private _shared: SharedHandle;
	private _closed = false;
	private _pos: number;
	private _start: number;
	private _end: number;

	static async Create(filename: string): Promise<FileReader> {
		let handle = await fs.open(filename, 'r');
		try {
			let stat = await handle.stat();
			return new FileReader({ handle, refs: 1 }, 0, stat.size);
		}
		catch(e) {
			await handle.close();
			throw e;
		}
	}

	private constructor(shared: SharedHandle, start: number, end: number) {
		super();
		this._shared = shared;
		this._pos = start;
		this._start = start;
		this._end = end;
	}

	async length() {
		return this._end - this._start;
	}

	pos() {
		return this._pos - this._start;
	}

	seek(pos: number) {
		this._pos = pos + this._start;
	}

	slice(start: number = 0, end?: number) {
		this.checkOpen();

		let len = this._end - this._start;
		if(end === undefined) {
			end = len;
		}

		if(start < 0 || end < start || end > len) {
			throw new RangeError('Slice [' + start + ', ' + end + ') is outside of the reader (length ' + len + ')');
		}

		this._shared.refs++;
		return new FileReader(this._shared, this._start + start, this._start + end);
	}

	async readBytes(n: number): Promise<Buffer> {
		this.checkOpen();
		checkReadSize(n);

		if(this._pos < this._start || this._pos + n > this._end) {
			throw new RangeError('Read of ' + n + ' bytes at ' + this.pos() + ' is outside of the file (length ' + (this._end - this._start) + ')');
		}

		let buf = Buffer.allocUnsafe(n);
		let pos = this._pos;

		// Advance first so that concurrent reads on the same reader don't overlap
		this._pos += n;

		let done = 0;
		while(done < n) {
			let res = await this._shared.handle.read(buf, done, n - done, pos + done);
			if(res.bytesRead === 0) {
				throw new Error('Unexpected end of file while reading');
			}
			done += res.bytesRead;
		}

		return buf;
	}

	async close() {
		if(this._closed) {
			return;
		}

		this._closed = true;
		this._shared.refs--;
		if(this._shared.refs === 0) {
			await this._shared.handle.close();
		}
	}

	private checkOpen() {
		if(this._closed) {
			throw new Error('Reader is closed');
		}
	}
}


/**
 * Reads from an in-memory buffer
 */
export class BufferReader extends Reader {
	private _buf: Buffer;
	private _pos = 0;

	constructor(buf: Buffer) {
		super();
		this._buf = buf;
	}

	// Memory is handled by the garbage collector
	async close() { }

	pos() {
		return this._pos;
	}

	seek(n: number) {
		this._pos = n;
	}

	slice(start: number = 0, end?: number) {
		if(end === undefined) {
			end = this._buf.length;
		}

		if(start < 0 || end < start || end > this._buf.length) {
			throw new RangeError('Slice [' + start + ', ' + end + ') is outside of the buffer (length ' + this._buf.length + ')');
		}

		return new BufferReader(this._buf.subarray(start, end));
	}

	async length() {
		return this._buf.length;
	}

	async readBytes(n: number) {
		checkReadSize(n);

		if(this._pos < 0 || this._pos + n > this._buf.length) {
			throw new RangeError('Read of ' + n + ' bytes at ' + this._pos + ' is outside of the buffer (length ' + this._buf.length + ')');
		}

		let out = Buffer.from(this._buf.subarray(this._pos, this._pos + n));
		this._pos += n;
		return out;
	}
}


/**
 * Stands in for bytes that aren't available, such as a backup point whose files are gone. It has a length
 * so that later data keeps its position, but every read fails with a FormatError.
 */
export class MissingDataReader extends Reader {
	private _pos = 0;

	constructor(private _length: number, private _message: string) {
		super();
	}

	async close() { }

	pos() {
		return this._pos;
	}

	seek(n: number) {
		this._pos = n;
	}

	async length() {
		return this._length;
	}

	slice(start: number = 0, end: number = this._length) {
		return new MissingDataReader(end - start, this._message);
	}

	async readBytes(n: number): Promise<Buffer> {
		throw new FormatError(this._message, 'missing-part');
	}
}


/**
 * A reader made of several readers joined end to end.
 *
 * It takes ownership of the readers it is given and closes them when it is closed.
 * Use a MissingDataReader for a gap.
 */
export class ConcatenatedReader extends Reader {

	static async Create(readers: Reader[]): Promise<ConcatenatedReader> {
		let offsets: Array<{ start: number; end: number }> = [];

		let pos = 0;
		for(let r of readers) {
			let len = await r.length();
			offsets.push({ start: pos, end: pos + len });
			pos += len;
		}

		return new ConcatenatedReader(readers, offsets);
	}

	private _pos = 0;
	private _readers: Reader[];
	private _offsets: Array<{ start: number; end: number }>;

	private constructor(readers: Reader[], offsets: Array<{ start: number; end: number }>) {
		super();
		this._readers = readers;
		this._offsets = offsets;
	}

	/**
	 * Creates a new reader made of this one followed by 'reader'. Neither this reader nor 'reader' is consumed.
	 */
	append(reader: Reader) {
		return ConcatenatedReader.Create(
			this._readers.map((r) => r.slice()).concat([ reader.slice() ])
		);
	}

	async close() {
		await Promise.all(this._readers.map((r) => r.close()));
	}

	async length() {
		return this._offsets.length > 0 ? this._offsets[this._offsets.length - 1].end : 0;
	}

	async readBytes(count: number): Promise<Buffer> {
		checkReadSize(count);

		if(count === 0) {
			return Buffer.alloc(0);
		}

		// Find the reader holding the starting position
		let idx = search(this._offsets, this._pos, (item, v) => {
			if(item.end <= v) {
				return -1;
			}

			if(item.start > v) {
				return 1;
			}

			return 0;
		});

		if(idx < 0) {
			throw new RangeError('Read at ' + this._pos + ' is outside of the reader');
		}

		let parts: Buffer[] = [];
		let remaining = count;
		let pos = this._pos;
		while(remaining > 0 && idx < this._readers.length) {
			let n = Math.min(this._offsets[idx].end, pos + remaining) - pos;

			this._readers[idx].seek(pos - this._offsets[idx].start);
			parts.push(await this._readers[idx].readBytes(n));

			remaining -= n;
			pos += n;
			idx++;
		}

		if(remaining !== 0) {
			throw new RangeError('Read of ' + count + ' bytes at ' + this._pos + ' runs past the end of the reader');
		}

		this._pos = pos;
		return parts.length === 1 ? parts[0] : Buffer.concat(parts);
	}

	slice(start?: number, end?: number) {
		if(start !== undefined || end !== undefined) {
			throw new Error('Partial slices are not implemented on ConcatenatedReader');
		}

		return new ConcatenatedReader(this._readers.map((r) => r.slice()), this._offsets);
	}

	pos() {
		return this._pos;
	}

	seek(n: number) {
		this._pos = n;
	}
}
