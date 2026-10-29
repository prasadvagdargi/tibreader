import readline from 'node:readline';
import { packageVersion } from '../version';
import { BackupSession } from './session';
import { TOOLS, ToolDefinition, checkArguments } from './tools';


/**
 * A Model Context Protocol (MCP) server over standard input/output, so AI assistants such as Claude can
 * browse, measure, check and clean up backups. Messages are newline-delimited JSON-RPC 2.0; standard
 * output carries nothing else (warnings go to standard error).
 *
 * Backups are only ever read. The two tools that write (extract_files, write_cleaned_copy_of_backup)
 * create new files and never replace existing ones unless asked to.
 */

/** Newest first; an unknown version asked for by a client gets the newest */
const SUPPORTED_PROTOCOL_VERSIONS = [ '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05' ];

const INSTRUCTIONS = 'Tools for Acronis True Image backups (.tib, .tibx). Start with find_backups_in_folder ' +
	'to see which backups a folder holds, then describe_backup. Paths inside a backup use "/" and start at "/" ' +
	'(e.g. "/C/Users"). backup_point 1 is the oldest, -1 (default) the newest. Backup files are never changed: ' +
	'extract_files and write_cleaned_copy_of_backup write new files only; ask the user before calling them.';

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: any;
}

class RpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;


export class McpServer {

	private session = new BackupSession();
	/** Requests run one at a time: the backup readers keep a read position */
	private queue: Promise<void> = Promise.resolve();

	constructor(private send: (message: object) => void) {}

	/** Handles one line of input */
	receive(line: string) {
		if(line.trim() === '') {
			return;
		}

		let message: any;
		try {
			message = JSON.parse(line);
		}
		catch {
			this.send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Not valid JSON' } });
			return;
		}

		this.queue = this.queue.then(() => this.handle(message));
	}

	/** Waits for queued requests, then closes every open backup */
	async close() {
		await this.queue;
		await this.session.close();
	}

	private async handle(message: any) {
		let isRequest = message && typeof message === 'object' && !Array.isArray(message) && 'id' in message;
		if(!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
			// Responses to us (we send no requests) and malformed notifications are dropped
			if(isRequest && !('result' in message) && !('error' in message)) {
				this.send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: INVALID_REQUEST, message: 'Not a JSON-RPC 2.0 request' } });
			}
			return;
		}

		let request = message as JsonRpcRequest;
		if(!isRequest) {
			// Notifications (initialized, cancelled, ...) need no answer
			return;
		}

		try {
			let result = await this.dispatch(request.method, request.params ?? {});
			this.send({ jsonrpc: '2.0', id: request.id, result });
		}
		catch(e: any) {
			let code = e instanceof RpcError ? e.code : -32603;
			this.send({ jsonrpc: '2.0', id: request.id, error: { code, message: e && e.message ? e.message : String(e) } });
		}
	}

	private async dispatch(method: string, params: any): Promise<object> {
		switch(method) {
			case 'initialize': {
				let asked = params.protocolVersion;
				return {
					protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
					capabilities: { tools: {} },
					serverInfo: { name: 'tibreader', title: 'Acronis backup reader', version: packageVersion() },
					instructions: INSTRUCTIONS,
				};
			}
			case 'ping':
				return {};
			case 'tools/list':
				return { tools: TOOLS.map(describeTool) };
			case 'tools/call':
				return this.callTool(params);
			default:
				throw new RpcError(METHOD_NOT_FOUND, 'Unknown method: ' + method);
		}
	}

	private async callTool(params: any): Promise<object> {
		let tool = TOOLS.find((t) => t.name === params.name);
		if(!tool) {
			throw new RpcError(INVALID_PARAMS, 'Unknown tool: ' + params.name);
		}

		// Problems with the arguments or the backup are tool results, so the assistant can correct itself
		try {
			let args = params.arguments ?? {};
			checkArguments(tool, args);
			let result = await tool.run(args, this.session);
			return { content: [ { type: 'text', text: JSON.stringify(result) } ] };
		}
		catch(e: any) {
			return { content: [ { type: 'text', text: 'Error: ' + (e && e.message ? e.message : String(e)) } ], isError: true };
		}
	}
}

function describeTool(t: ToolDefinition) {
	return {
		name: t.name,
		title: t.title,
		description: t.description,
		inputSchema: t.inputSchema,
		annotations: {
			title: t.title,
			readOnlyHint: !t.writesFiles,
			destructiveHint: false,
			idempotentHint: !t.writesFiles,
			openWorldHint: false,
		},
	};
}


/**
 * Runs the server on this process's standard input and output until the input ends
 */
export async function runMcpServer(): Promise<void> {
	let server = new McpServer((message) => {
		process.stdout.write(JSON.stringify(message) + '\n');
	});

	let lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (let line of lines) {
		server.receive(line);
	}

	await server.close();
}
