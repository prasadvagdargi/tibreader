import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConflictChoice, JobConflict, JobProgress, Result } from '../../shared/api';
import { call, TibError } from './api';


export type JobKind = 'copy' | 'restore' | 'edit' | 'clipboard' | 'open';
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
	id: string;
	kind: JobKind;
	title: string;
	status: JobStatus;
	progress?: JobProgress;
	/** Bytes per second, smoothed */
	speed?: number;
	error?: string;
	/** Where the files went, when known */
	destination?: string;
	/** The first item written, for "Show in folder" */
	firstItem?: string;
	started: number;
	finished?: number;
}

/**
 * Copies running in one backup window: their progress, and the "file already exists" questions they ask
 */
export function useJobs(sessionId: string) {
	let [jobs, setJobs] = useState<Job[]>([]);
	let [conflicts, setConflicts] = useState<JobConflict[]>([]);
	let samples = useRef(new Map<string, { t: number; bytes: number }>());

	let update = useCallback((id: string, change: (j: Job) => Job) => {
		setJobs((list) => list.map((j) => (j.id === id ? change(j) : j)));
	}, []);

	useEffect(() => window.tib.onEvent((ev) => {
		if(ev.name === 'job-progress' && ev.sessionId === sessionId) {
			let p = ev.progress;
			let now = performance.now();
			let prev = samples.current.get(p.jobId);
			samples.current.set(p.jobId, { t: now, bytes: p.bytes });

			update(p.jobId, (j) => {
				let speed = j.speed;
				if(prev && now - prev.t > 50) {
					let instant = (p.bytes - prev.bytes) / ((now - prev.t) / 1000);
					speed = speed === undefined ? instant : speed * 0.8 + instant * 0.2;
				}
				return { ...j, progress: p, speed };
			});
		}
		else if(ev.name === 'job-conflict' && ev.sessionId === sessionId) {
			setConflicts((c) => [...c, ev.conflict]);
		}
	}), [sessionId, update]);

	/**
	 * Runs one job. Resolves with its result, or null if it was cancelled; throws a TibError if it
	 * failed (the job's entry in the list shows the error too).
	 */
	let run = useCallback(async <T>(
		kind: JobKind,
		title: string,
		destination: string | undefined,
		start: (jobId: string) => Promise<Result<T>>,
		onDone?: (value: T, job: Job) => Partial<Job>,
	): Promise<T | null> => {
		let id = crypto.randomUUID();
		let job: Job = { id, kind, title, status: 'running', destination, started: Date.now() };
		setJobs((list) => [job, ...list]);

		let r = await start(id);
		samples.current.delete(id);
		setConflicts((c) => c.filter((x) => x.jobId !== id));

		if(r.ok) {
			let extra = onDone ? onDone(r.value, job) : {};
			update(id, (j) => ({ ...j, ...extra, status: 'done', finished: Date.now() }));
			return r.value;
		}

		let cancelled = r.error.code === 'cancelled';
		update(id, (j) => ({ ...j, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : r.error.message, finished: Date.now() }));
		if(!cancelled) {
			throw new TibError(r.error.code, r.error.message);
		}
		return null;
	}, [update]);

	let cancel = useCallback((jobId: string) => {
		void call(sessionId, 'cancel', jobId).catch(() => {});
	}, [sessionId]);

	/** Answers the first waiting question; "all" also answers the job's other waiting questions */
	let answer = useCallback((conflict: JobConflict, choice: ConflictChoice, applyToAll: boolean) => {
		void call(sessionId, 'answer', conflict.jobId, conflict.conflictId, choice, applyToAll).catch(() => {});
		setConflicts((list) => {
			let rest = list.filter((c) => c !== conflict);
			if(applyToAll || choice === 'abort') {
				for(let c of rest.filter((x) => x.jobId === conflict.jobId)) {
					void call(sessionId, 'answer', c.jobId, c.conflictId, choice, false).catch(() => {});
				}
				rest = rest.filter((x) => x.jobId !== conflict.jobId);
			}
			return rest;
		});
	}, [sessionId]);

	let dismiss = useCallback((jobId: string) => {
		setJobs((list) => list.filter((j) => j.id !== jobId || j.status === 'running'));
	}, []);

	let clearFinished = useCallback(() => {
		setJobs((list) => list.filter((j) => j.status === 'running'));
	}, []);

	return { jobs, conflicts, run, cancel, answer, dismiss, clearFinished };
}

export type Jobs = ReturnType<typeof useJobs>;
