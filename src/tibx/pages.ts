import { FileReader } from '../reader';
import { FormatError } from '../errors';
import { crc32c } from './crc32c';


export const PAGE_SIZE = 4096;
export const PAGE_ENVELOPE_SIZE = 8;

export const enum PageType {
	ArchiveHeader = 0x01,
	ArchiveIndex = 0x02,
	TreeLeaf = 0x03,
	TreeDirectory = 0x04,
	DedupFilter = 0x05,
	Data = 0xff,
}

/** Stored CRC-32C (big-endian at +4) against the page with that field zeroed */
export function pageChecksumMatches(page: Buffer): boolean {
	let copy = Buffer.from(page);
	copy.fill(0, 4, 8);
	return crc32c(copy) === page.readUInt32BE(4);
}

/** Sets a page's CRC field (writers and test fixtures) */
export function sealPage(page: Buffer): Buffer {
	page.fill(0, 4, 8);
	page.writeUInt32BE(crc32c(page), 4);
	return page;
}

export interface PageFile {
	fileName: string;
	reader: FileReader;
	pageCount: number;
	/** Global page number of this file's first page */
	firstGlobalPage: number;
}

/**
 * The pages of a .tibx archive. A split archive spreads one global page space over several files; tree
 * and segment references always use global page numbers.
 */
export class PageStore {

	constructor(readonly files: PageFile[]) {
		this.files.sort((a, b) => a.firstGlobalPage - b.firstGlobalPage);
	}

	static async openFile(fileName: string): Promise<PageFile> {
		let reader = await FileReader.Create(fileName);
		let size = await reader.length();
		if(size === 0 || size % PAGE_SIZE !== 0) {
			await reader.close();
			throw new FormatError(fileName + ' is not a whole number of 4 KiB pages; not a .tibx file, or cut short');
		}
		return { fileName, reader, pageCount: size / PAGE_SIZE, firstGlobalPage: 0 };
	}

	private locate(globalPage: number): { file: PageFile; localPage: number } {
		for(let f of this.files) {
			if(globalPage >= f.firstGlobalPage && globalPage < f.firstGlobalPage + f.pageCount) {
				return { file: f, localPage: globalPage - f.firstGlobalPage };
			}
		}
		throw new FormatError('Page ' + globalPage + ' is in a part of the backup that is missing', 'missing-part');
	}

	/**
	 * Reads one page (4096 bytes, envelope included). Checks its envelope and CRC unless told not to.
	 */
	async readPage(globalPage: number, verifyChecksum = true): Promise<Buffer> {
		let { file, localPage } = this.locate(globalPage);
		return PageStore.readLocalPage(file, localPage, verifyChecksum, globalPage);
	}

	static async readLocalPage(file: PageFile, localPage: number, verifyChecksum = true, globalPage = localPage): Promise<Buffer> {
		let r = file.reader.slice();
		let page: Buffer;
		try {
			r.seek(localPage * PAGE_SIZE);
			page = await r.readBytes(PAGE_SIZE);
		}
		finally {
			await r.close();
		}
		if(page[0] !== 0x41) {
			throw new FormatError('Page ' + globalPage + ' of ' + file.fileName + ' is not a .tibx page');
		}
		if(verifyChecksum && !pageChecksumMatches(page)) {
			throw new FormatError('Page ' + globalPage + ' of ' + file.fileName + ' is damaged (checksum mismatch)');
		}
		return page;
	}

	get totalPages(): number {
		return this.files.reduce((s, f) => s + f.pageCount, 0);
	}

	async close() {
		for(let f of this.files) {
			await f.reader.close();
		}
	}
}
