import http from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { FsEntry, SnapshotFS } from '../fs/types';
import { splitPath } from '../fs/tree';
import { warn } from '../log';


export interface WebDavOptions {
	/**
	 * Serve the backup only below this path, e.g. "/3f9c.../". A random path keeps other programs on
	 * this computer from guessing the address. Default: "/".
	 */
	basePath?: string;
}

/**
 * A read-only WebDAV server over a backup point.
 *
 * Pure JavaScript, so it works everywhere: Windows can map it as a network drive, macOS Finder and
 * Linux file managers can mount it directly. Only listens on 127.0.0.1 unless told otherwise.
 *
 * On a loopback address, requests must name this computer in their Host header (127.0.0.1, localhost
 * or [::1] with the right port). That stops web pages from reading the backup through DNS rebinding.
 */
export class WebDavServer {

	private _server: http.Server;
	private _chunkSize = 1024 * 1024;
	private _base: string; /**< basePath without its trailing '/', '' for the root */
	private _port = 0;
	private _checkHost = true;

	/** A random base path, for servers that only programs use */
	static randomBasePath(): string {
		return '/' + crypto.randomBytes(16).toString('hex') + '/';
	}

	constructor(private _fs: SnapshotFS, opts: WebDavOptions = {}) {
		let base = opts.basePath || '/';
		if(!base.startsWith('/') || !base.endsWith('/')) {
			throw new Error('basePath must start and end with "/"');
		}
		splitPath(base); // rejects '.' and '..'
		this._base = base.slice(0, -1);

		this._server = http.createServer((req, res) => {
			this.handle(req, res).catch((err) => {
				warn('WebDAV request failed: ' + (err && err.message));
				if(!res.headersSent) {
					send(res, 500, 'Internal error: ' + (err && err.message));
				}
				else {
					res.destroy();
				}
			});
		});

		// Clients keep connections open for a long time while browsing
		this._server.keepAliveTimeout = 60 * 1000;
	}

	/**
	 * Starts listening. Port 0 picks a free port. Resolves with the address actually used.
	 */
	listen(port: number, host = '127.0.0.1'): Promise<AddressInfo> {
		return new Promise((resolve, reject) => {
			this._server.once('error', reject);
			this._server.listen(port, host, () => {
				this._server.off('error', reject);
				let addr = this._server.address() as AddressInfo;
				this._port = addr.port;
				// Other computers reach a network address by names this server can't know
				this._checkHost = isLoopbackAddress(addr.address);
				resolve(addr);
			});
		});
	}

	/** The path the backup is served below, ending in '/' */
	get basePath(): string {
		return this._base + '/';
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			this._server.close(() => resolve());
			this._server.closeAllConnections();
		});
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
		res.setHeader('DAV', '1, 2');
		res.setHeader('MS-Author-Via', 'DAV');

		if(this._checkHost && !hostAllowed(req.headers.host, this._port)) {
			req.resume();
			return send(res, 403, 'Unexpected Host header');
		}

		let urlPath: string;
		try {
			urlPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
			splitPath(urlPath); // rejects '.' and '..'
		}
		catch(e) {
			return send(res, 400, 'Bad path');
		}

		if(this._base) {
			if(urlPath !== this._base && !urlPath.startsWith(this._base + '/')) {
				req.resume();
				return send(res, 404);
			}
			urlPath = urlPath.slice(this._base.length) || '/';
		}

		switch(req.method) {
			case 'OPTIONS':
				res.setHeader('Allow', ALLOW);
				return send(res, 200);

			case 'PROPFIND':
				return this.propfind(req, res, urlPath);

			case 'GET':
			case 'HEAD':
				return this.get(req, res, urlPath);

			// Windows asks for locks before opening some files. Hand out locks that don't do
			// anything, since nothing can be written anyway.
			case 'LOCK':
				return this.lock(req, res, urlPath);

			case 'UNLOCK':
				return send(res, 204);

			case 'PUT':
			case 'DELETE':
			case 'MKCOL':
			case 'COPY':
			case 'MOVE':
			case 'PROPPATCH':
				return send(res, 403, 'This backup is read-only');

			default:
				res.setHeader('Allow', ALLOW);
				return send(res, 405);
		}
	}

	private async propfind(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
		// The request body only selects properties; every property is always returned
		req.resume();

		let entry = await this._fs.stat(urlPath);
		if(!entry) {
			return send(res, 404);
		}

		let entries: FsEntry[] = [ entry ];

		// 'infinity' is treated as 1 so a request can't walk the whole backup at once
		let depth = String(req.headers['depth'] || 'infinity');
		if(entry.type === 'directory' && depth !== '0') {
			entries.push(...(await this._fs.list(urlPath) || []));
		}

		let body = '<?xml version="1.0" encoding="utf-8"?>\n' +
			'<D:multistatus xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">\n' +
			entries.map((e) => propXml(e, this._base)).join('') +
			'</D:multistatus>\n';

		res.statusCode = 207;
		res.setHeader('Content-Type', 'application/xml; charset=utf-8');
		res.setHeader('Content-Length', Buffer.byteLength(body));
		res.end(body);
	}

	private async get(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
		let entry = await this._fs.stat(urlPath);
		if(!entry) {
			return send(res, 404);
		}

		if(entry.type === 'directory') {
			return this.directoryPage(req, res, entry);
		}

		res.setHeader('Accept-Ranges', 'bytes');
		res.setHeader('Last-Modified', entry.mtime.toUTCString());
		res.setHeader('ETag', etag(entry));
		res.setHeader('Content-Type', 'application/octet-stream');

		let start = 0;
		let end = entry.size; // exclusive

		let range = parseRange(req.headers['range'], entry.size);
		if(range === 'invalid') {
			res.setHeader('Content-Range', 'bytes */' + entry.size);
			return send(res, 416);
		}
		else if(range) {
			[ start, end ] = range;
			res.statusCode = 206;
			res.setHeader('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + entry.size);
		}
		else {
			res.statusCode = 200;
		}

		res.setHeader('Content-Length', end - start);

		if(req.method === 'HEAD') {
			return res.end();
		}

		let aborted = false;
		res.on('close', () => { aborted = !res.writableFinished; });

		for(let off = start; off < end && !aborted; off += this._chunkSize) {
			let buf = await this._fs.read(entry.path, off, Math.min(this._chunkSize, end - off));
			if(!res.write(buf)) {
				await new Promise<void>((resolve) => {
					res.once('drain', resolve);
					res.once('close', resolve);
				});
			}
		}

		res.end();
	}

	private async directoryPage(req: http.IncomingMessage, res: http.ServerResponse, entry: FsEntry) {
		let kids = await this._fs.list(entry.path) || [];
		let base = hrefFor(entry, this._base);
		let rows = kids.map((k) => {
			let isDir = k.type === 'directory';
			let name = escapeXml(k.name) + (isDir ? '/' : '');
			let href = escapeXml(base + encodeURIComponent(k.name) + (isDir ? '/' : ''));
			return '<tr><td><a href="' + href + '"' + (isDir ? '' : ' download') + '>' + name + '</a></td>' +
				'<td class="n">' + (isDir ? '' : formatBytes(k.size)) + '</td>' +
				'<td>' + escapeXml(k.mtime.toISOString().slice(0, 16).replace('T', ' ')) + '</td></tr>';
		});

		let body = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
			'<title>' + escapeXml(entry.path) + '</title>' +
			'<style>body{font:14px system-ui,sans-serif;margin:16px}table{border-collapse:collapse}' +
			'td,th{padding:3px 14px 3px 0;text-align:left}.n{text-align:right}</style>' +
			'<h1>' + escapeXml(entry.path) + '</h1>' +
			'<table><tr><th>Name</th><th class="n">Size</th><th>Modified (UTC)</th></tr>' +
			(entry.path !== '/' ? '<tr><td><a href="../">../</a></td><td></td><td></td></tr>' : '') +
			rows.join('') + '</table>';

		res.statusCode = 200;
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Content-Length', Buffer.byteLength(body));
		res.end(req.method === 'HEAD' ? undefined : body);
	}

	private async lock(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
		req.resume();

		if(!(await this._fs.stat(urlPath))) {
			return send(res, 404);
		}

		let token = 'opaquelocktoken:' + crypto.randomUUID();
		let body = '<?xml version="1.0" encoding="utf-8"?>\n' +
			'<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
			'<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>' +
			'<D:depth>0</D:depth><D:timeout>Second-3600</D:timeout>' +
			'<D:locktoken><D:href>' + token + '</D:href></D:locktoken>' +
			'</D:activelock></D:lockdiscovery></D:prop>\n';

		res.statusCode = 200;
		res.setHeader('Lock-Token', '<' + token + '>');
		res.setHeader('Content-Type', 'application/xml; charset=utf-8');
		res.setHeader('Content-Length', Buffer.byteLength(body));
		res.end(body);
	}
}


const ALLOW = 'OPTIONS, GET, HEAD, PROPFIND, LOCK, UNLOCK';

// Windows FILE_ATTRIBUTE_* values shown to Windows clients. Files aren't marked read-only, because
// Windows would keep that flag on copies; writes are refused by the server anyway.
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;

function send(res: http.ServerResponse, status: number, text?: string) {
	res.statusCode = status;
	if(text) {
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.setHeader('Content-Length', Buffer.byteLength(text));
		res.end(text);
	}
	else {
		res.setHeader('Content-Length', 0);
		res.end();
	}
}

function formatBytes(n: number) {
	let units = [ 'B', 'KB', 'MB', 'GB', 'TB' ];
	let i = 0;
	let v = n;
	while(v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

function escapeXml(s: string) {
	return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' } as any)[c]);
}

function isLoopbackAddress(address: string) {
	return address === '::1' || address === '::ffff:127.0.0.1' || /^127\./.test(address);
}

/**
 * Host headers that name this computer: 127.0.0.1, localhost or [::1], with our port
 * (or without one when the port is 80)
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
	if(!host) {
		return false;
	}

	let m = /^(\[::1\]|127\.0\.0\.1|localhost)(?::(\d+))?$/i.exec(host.trim());
	if(!m) {
		return false;
	}

	return m[2] === undefined ? port === 80 : parseInt(m[2], 10) === port;
}

function hrefFor(entry: FsEntry, base = '') {
	let href = base + '/' + splitPath(entry.path).map(encodeURIComponent).join('/');
	if(entry.type === 'directory' && !href.endsWith('/')) {
		href += '/';
	}
	return href;
}

function etag(entry: FsEntry) {
	return '"' + entry.size.toString(16) + '-' + entry.mtime.getTime().toString(16) + '"';
}

function propXml(entry: FsEntry, base: string): string {
	let isDir = entry.type === 'directory';
	let props = [
		'<D:displayname>' + escapeXml(entry.name || '/') + '</D:displayname>',
		'<D:resourcetype>' + (isDir ? '<D:collection/>' : '') + '</D:resourcetype>',
		'<D:getlastmodified>' + entry.mtime.toUTCString() + '</D:getlastmodified>',
		'<D:creationdate>' + entry.mtime.toISOString() + '</D:creationdate>',
		'<Z:Win32FileAttributes>' + (isDir ? ATTR_DIRECTORY : ATTR_ARCHIVE).toString(16).padStart(8, '0') + '</Z:Win32FileAttributes>',
		'<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>',
	];

	if(!isDir) {
		props.push(
			'<D:getcontentlength>' + entry.size + '</D:getcontentlength>',
			'<D:getcontenttype>application/octet-stream</D:getcontenttype>',
			'<D:getetag>' + escapeXml(etag(entry)) + '</D:getetag>'
		);
	}

	return '<D:response><D:href>' + escapeXml(hrefFor(entry, base)) + '</D:href>' +
		'<D:propstat><D:prop>' + props.join('') + '</D:prop>' +
		'<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n';
}

/**
 * Parses a single "bytes=" range. Returns [start, endExclusive], null for no/unsupported range,
 * or 'invalid' if it can't be satisfied.
 */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'invalid' {
	if(!header) {
		return null;
	}

	let m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if(!m) {
		// Multiple ranges or other units: send the whole file, which is allowed
		return null;
	}

	let start: number;
	let end: number;
	if(m[1] === '') {
		if(m[2] === '') {
			return 'invalid';
		}
		// Last N bytes
		start = Math.max(0, size - parseInt(m[2], 10));
		end = size;
	}
	else {
		start = parseInt(m[1], 10);
		end = m[2] === '' ? size : Math.min(size, parseInt(m[2], 10) + 1);
	}

	if(start >= size || start >= end) {
		return 'invalid';
	}

	return [ start, end ];
}
