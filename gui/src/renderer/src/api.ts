import type { EngineArgs, EngineMethod, EngineReturn, ErrorCode, Result, Session } from '../../shared/api';


/** An error from the engine or main, with a code the UI can explain */
export class TibError extends Error {
	override name = 'TibError';

	constructor(readonly code: ErrorCode, message: string) {
		super(message);
	}
}

function unwrap<T>(r: Result<T>): T {
	if(r.ok) {
		return r.value;
	}
	throw new TibError(r.error.code, r.error.message);
}

export const tib = window.tib;

export async function openBackup(file: string): Promise<Session> {
	return unwrap(await tib.openBackup(file));
}

/** Calls the engine of an open backup; throws TibError on failure */
export async function call<M extends EngineMethod>(sessionId: string, method: M, ...args: EngineArgs<M>): Promise<EngineReturn<M>> {
	return unwrap(await tib.call(sessionId, method, ...args));
}

export function errorCode(e: unknown): ErrorCode {
	return e instanceof TibError ? e.code : 'internal';
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
