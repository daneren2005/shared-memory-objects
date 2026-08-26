import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';

// Real thread-safety tests need real threads, and node:worker_threads can only start a plain .js file: it has no vite
// pipeline, so a worker written in TS that touches `import.meta.env` (AllocatedMemory does) cannot be started directly.
// So we bundle the worker with vite first - in 'test' mode, so the worker runs with the same strict bounds checks the
// test process does - and hand node the built file.
// Options every safety test runs with. The repeat count comes from vitest.safety.config.ts - a race that shows up one
// run in five needs many passes to be visible - and the timeout is the failure mode for a deadlock, since a thread
// parked in Atomics.wait never comes back on its own.
export const SAFETY_TEST_OPTIONS = {
	repeats: Number(process.env.SAFETY_REPEATS ?? 0),
	timeout: 30_000,
};

const BUNDLES = new Map<string, string>();
const TEMP_DIRS: Array<string> = [];

// `self` is absent under worker_threads, so SimpleLock would take its main-thread branch and degrade every contended
// lock to a spin. Presenting the worker as a WorkerGlobalScope keeps it on the real Atomics.wait path, which is the
// path we are actually trying to test.
const WORKER_SHIM = 'globalThis.self ??= globalThis;\nglobalThis.WorkerGlobalScope ??= class WorkerGlobalScope {};';

export async function bundleWorker(entryUrl: string | URL): Promise<string> {
	let entry = typeof entryUrl === 'string' ? entryUrl : fileURLToPath(entryUrl);
	let cached = BUNDLES.get(entry);
	if(cached) {
		return cached;
	}

	let outDir = mkdtempSync(join(tmpdir(), 'shared-memory-worker-'));
	TEMP_DIRS.push(outDir);

	await build({
		configFile: false,
		logLevel: 'error',
		mode: 'test',
		build: {
			outDir,
			minify: false,
			lib: {
				entry,
				formats: ['es'],
				fileName: () => 'worker.js',
			},
			rollupOptions: {
				external: ['node:worker_threads'],
				output: {
					banner: WORKER_SHIM,
				},
			},
		},
	});

	let file = join(outDir, 'worker.js');
	BUNDLES.set(entry, file);
	return file;
}

export async function cleanupWorkerBundles() {
	// A worker outliving its bundle would fail to load it, so make sure none are left before the directory goes
	await terminateTestWorkers();
	for(let dir of TEMP_DIRS.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	BUNDLES.clear();
}

// Every live worker, so a test can tear them all down from an afterEach: when a test times out vitest abandons the test
// function, so a `finally` inside it never runs and a worker stuck in a spin or an Atomics.wait would keep the vitest
// process alive forever.
const LIVE_WORKERS = new Set<TestWorker>();

export function terminateTestWorkers(): Promise<Array<number>> {
	return Promise.all([...LIVE_WORKERS].map(worker => worker.terminate()));
}

// A worker that stays alive across phases: messages are handed back one at a time so the test can drive it like the
// browser runners do (run, verify, then check).
export class TestWorker {
	private worker: Worker;
	private queued: Array<unknown> = [];
	private waiting: Array<{ resolve: (message: unknown) => void, reject: (error: Error) => void }> = [];
	private failure: Error | null = null;

	constructor(file: string, workerData: unknown) {
		this.worker = new Worker(file, { workerData });
		LIVE_WORKERS.add(this);
		this.worker.on('message', message => {
			let pending = this.waiting.shift();
			if(pending) {
				pending.resolve(message);
			} else {
				this.queued.push(message);
			}
		});
		this.worker.on('error', (error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
		this.worker.on('exit', code => {
			if(code !== 0) {
				this.fail(new Error(`worker exited with code ${code}`));
			} else if(this.waiting.length) {
				// Exiting while the test still expects a reply would otherwise hang the run until vitest's timeout
				this.fail(new Error('worker exited before replying'));
			}
		});
	}

	postMessage(message: unknown) {
		this.worker.postMessage(message);
	}

	nextMessage<T>(): Promise<T> {
		if(this.failure) {
			return Promise.reject(this.failure);
		}

		let queued = this.queued.shift();
		if(queued !== undefined) {
			return Promise.resolve(queued as T);
		}

		return new Promise<T>((resolve, reject) => {
			this.waiting.push({ resolve: resolve as (message: unknown) => void, reject });
		});
	}

	terminate(): Promise<number> {
		LIVE_WORKERS.delete(this);
		return this.worker.terminate();
	}

	private fail(error: Error) {
		this.failure ??= error;
		for(let pending of this.waiting.splice(0)) {
			pending.reject(error);
		}
	}
}
