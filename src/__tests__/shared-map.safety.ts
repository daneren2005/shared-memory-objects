import MemoryHeap from '../memory-heap';
import SharedMap from '../shared-map';
import { SAFETY_TEST_OPTIONS, TestWorker, bundleWorker, cleanupWorkerBundles, terminateTestWorkers } from './helpers/worker-threads';

// Real multi-threaded safety test - the vitest version of runners/shared-map, driving node worker_threads instead of
// browser Web Workers.
//
// Each worker owns a disjoint key range (worker N uses [N * KEY_RANGE, (N + 1) * KEY_RANGE)) and stores value === key, so
// after the run every surviving entry must have value === key and a key that lands in exactly one worker's range - which
// catches torn writes and lost updates from concurrent set/delete/resize hammering the same shared table.
const KEY_RANGE = 1_000_000;
const ITERATIONS = 5_000; // must stay below KEY_RANGE so ranges never overlap
const WORKER_COUNT = 10;

describe('SharedMap thread safety', () => {
	let workerFile: string;
	beforeAll(async () => {
		workerFile = await bundleWorker(new URL('./shared-map.safety.worker.ts', import.meta.url));
	}, 60_000);
	// Runs even when the test itself timed out, which is how a deadlocked worker gets killed instead of wedging vitest
	afterEach(() => terminateTestWorkers());
	afterAll(() => cleanupWorkerBundles());

	it('keeps every entry consistent while threads set, delete and resize at once', SAFETY_TEST_OPTIONS, async () => {
		// Pre-size the heap so every table (re)allocation lands in a buffer all workers already hold, and disable
		// auto-grow: cross-thread buffer growth can't be propagated safely mid-run.
		let heap = new MemoryHeap({ initialBuffers: 24, autoGrowSize: 0 });
		let map = new SharedMap<number>(heap);

		let workers: Array<TestWorker> = [];
		for(let index = 0; index < WORKER_COUNT; index++) {
			workers.push(new TestWorker(workerFile, {
				heap: heap.getSharedMemory(),
				map: map.getSharedMemory(),
				workerNumber: index + 1,
				keyRange: KEY_RANGE,
				iterations: ITERATIONS,
			}));
		}

		// Wait until every worker has attached to the heap before any of them starts writing
		await Promise.all(workers.map(worker => worker.nextMessage<{ ready: true }>()));

		workers.forEach(worker => worker.postMessage({ run: true }));
		let results = await Promise.all(workers.map(worker => worker.nextMessage<{ workerNumber: number, expectedCount: number }>()));

		let expectedCount = results.reduce((total, result) => total + result.expectedCount, 0);
		expect(map.length).toEqual(expectedCount);

		// Global scan: every entry must be a torn-write-free value === key pair whose key belongs to exactly one worker's
		// range, and each range must hold exactly as many entries as its worker reported leaving behind
		let tornWrites: Array<number> = [];
		let outOfRange: Array<number> = [];
		let rangeActual = new Map<number, number>();
		let walked = 0;
		for(let [key, value] of map) {
			walked++;
			if(value !== key) {
				tornWrites.push(key);
			}
			let workerNumber = Math.floor(key / KEY_RANGE);
			if(workerNumber < 1 || workerNumber > WORKER_COUNT) {
				outOfRange.push(key);
			} else {
				rangeActual.set(workerNumber, (rangeActual.get(workerNumber) ?? 0) + 1);
			}
		}
		expect(tornWrites).toEqual([]);
		expect(outOfRange).toEqual([]);
		expect(walked).toEqual(expectedCount);
		expect(results.map(result => rangeActual.get(result.workerNumber) ?? 0)).toEqual(results.map(result => result.expectedCount));

		// Each worker verifies its own known-live keys resolve and its deleted keys stayed gone
		workers.forEach(worker => worker.postMessage({ check: true }));
		let checks = await Promise.all(workers.map(worker => worker.nextMessage<{ missing: number, resurrected: number }>()));
		expect(checks.map(check => check.missing)).toEqual(workers.map(() => 0));
		expect(checks.map(check => check.resurrected)).toEqual(workers.map(() => 0));
	});
});
