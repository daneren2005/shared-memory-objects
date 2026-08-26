import MemoryHeap from '../memory-heap';
import SharedList from '../shared-list';
import { SAFETY_TEST_OPTIONS, TestWorker, bundleWorker, cleanupWorkerBundles, terminateTestWorkers } from './helpers/worker-threads';

// Real multi-threaded safety test - the vitest version of runners/shared-list, driving node worker_threads instead of
// browser Web Workers. Every worker inserts one distinctive value over and over into the same lock-free list, so a lost
// enqueue, a duplicated node or a torn value all show up as a per-value count that no longer matches what its writer did.
const WORKER_VALUES = [5, 8, 52, 9];
const ITERATIONS = 5_000;

describe('SharedList thread safety', () => {
	let workerFile: string;
	beforeAll(async () => {
		workerFile = await bundleWorker(new URL('./shared-list.safety.worker.ts', import.meta.url));
	}, 60_000);
	// Runs even when the test itself timed out, which is how a deadlocked worker gets killed instead of wedging vitest
	afterEach(() => terminateTestWorkers());
	afterAll(() => cleanupWorkerBundles());

	it('keeps every concurrently inserted node exactly once', SAFETY_TEST_OPTIONS, async () => {
		// Pre-size the heap so every node lands in a buffer all workers already hold, and disable auto-grow: cross-thread
		// buffer growth can't be propagated safely mid-run.
		let heap = new MemoryHeap({ initialBuffers: 24, autoGrowSize: 0 });
		let list = new SharedList(heap);

		let workers = WORKER_VALUES.map(value => new TestWorker(workerFile, {
			heap: heap.getSharedMemory(),
			list: list.getSharedMemory(),
			value,
			iterations: ITERATIONS,
		}));

		// Wait until every worker has attached to the heap before any of them starts writing
		await Promise.all(workers.map(worker => worker.nextMessage<{ ready: true }>()));

		workers.forEach(worker => worker.postMessage({ run: true }));
		let results = await Promise.all(workers.map(worker => worker.nextMessage<{ expectedCount: number }>()));

		let expectedCount = results.reduce((total, result) => total + result.expectedCount, 0);
		expect(expectedCount).toEqual(WORKER_VALUES.length * ITERATIONS);
		expect(list.length).toEqual(expectedCount);

		// A full walk from the main thread must see exactly the values that were inserted, in the right multiplicities -
		// anything else means a dropped link or a torn node
		let counts = new Map<number, number>();
		let walked = 0;
		for(let { data } of list) {
			counts.set(data[0], (counts.get(data[0]) ?? 0) + 1);
			walked++;
		}
		expect(walked).toEqual(expectedCount);
		expect([...counts.keys()].sort((a, b) => a - b)).toEqual([...WORKER_VALUES].sort((a, b) => a - b));
		expect([...counts.values()]).toEqual(WORKER_VALUES.map(() => ITERATIONS));

		// And each worker must see its own inserts from its own thread
		workers.forEach(worker => worker.postMessage({ check: true }));
		let checks = await Promise.all(workers.map(worker => worker.nextMessage<{ value: number, actualCount: number, expectedCount: number }>()));
		expect(checks.map(check => check.actualCount)).toEqual(checks.map(check => check.expectedCount));
	});
});
