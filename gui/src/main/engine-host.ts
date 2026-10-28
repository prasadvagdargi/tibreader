import { utilityProcess, type UtilityProcess } from 'electron';
import enginePath from '../engine/index?modulePath';
import type { EngineEvent, EngineMessage, EngineMethod, EngineArgs, EngineReturn, EngineRequest, Result } from '../shared/api';


/**
 * Starts and talks to one engine process (one per open backup)
 */
export class EngineHost {

	private _child: UtilityProcess;
	private _pending = new Map<number, (r: Result<unknown>) => void>();
	private _nextId = 1;
	private _exited = false;
	private _exitPromise: Promise<void>;

	onEvent?: (event: EngineEvent) => void;
	/** Called if the process stops without being asked to */
	onCrash?: (code: number) => void;

	private _stopping = false;

	constructor(env: NodeJS.ProcessEnv) {
		this._child = utilityProcess.fork(enginePath, [], {
			serviceName: 'TibReader backup engine',
			env,
			stdio: 'inherit',
		});

		this._child.on('message', (m: EngineMessage) => {
			if(m.type === 'response') {
				let resolve = this._pending.get(m.id);
				if(resolve) {
					this._pending.delete(m.id);
					resolve(m.result);
				}
			}
			else if(m.type === 'event' && this.onEvent) {
				this.onEvent(m.event);
			}
		});

		this._exitPromise = new Promise((resolve) => {
			this._child.once('exit', (code) => {
				this._exited = true;
				for(let r of this._pending.values()) {
					r({ ok: false, error: { code: 'engine', message: 'The backup process stopped (exit code ' + code + ')' } });
				}
				this._pending.clear();

				if(!this._stopping && this.onCrash) {
					this.onCrash(code);
				}
				resolve();
			});
		});
	}

	get pid(): number | undefined {
		return this._child.pid;
	}

	request<M extends EngineMethod>(method: M, args: EngineArgs<M>): Promise<Result<EngineReturn<M>>> {
		if(this._exited) {
			return Promise.resolve({ ok: false, error: { code: 'engine', message: 'The backup process has stopped' } });
		}

		let id = this._nextId++;
		return new Promise((resolve) => {
			this._pending.set(id, resolve as (r: Result<unknown>) => void);
			this.post({ type: 'request', id, method, args });
		});
	}

	/** Asks the engine to close the backup and exit; ends it after a few seconds if it doesn't */
	async shutdown(): Promise<void> {
		if(this._exited) {
			return;
		}

		this._stopping = true;
		this.post({ type: 'shutdown' });

		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			this._exitPromise,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					this._child.kill();
					resolve();
				}, 3000);
			}),
		]);
		clearTimeout(timer);
	}

	private post(message: EngineRequest) {
		this._child.postMessage(message);
	}
}
