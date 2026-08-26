import MemoryHeap from '../memory-heap';
import SharedPool from '../shared-pool';
import { SAFETY_TEST_OPTIONS, TestWorker, bundleWorker, cleanupWorkerBundles, terminateTestWorkers } from './helpers/worker-threads';

// Real multi-threaded safety test - the vitest version of runners/shared-pool, driving node worker_threads instead of
// browser Web Workers. Every worker pushes one distinctive value and randomly frees records it owns, so allocation and
// recycling race the whole run: handing one recycled index to two threads shows up as a per-value count that no longer
// matches what its writer did.
const WORKER_VALUES = [
	5, 8, 52, 9, 1093, 524, 7645, 2334, 14, 3452452,
	7612, 63, 754, 7316, 1234, 4321, 753, 97, 2, 9223423,
];
const ITERATIONS = 5_000;
// Small maxChunkSize so we constantly cross chunk boundaries and hammer the chunk-allocation path
const MAX_CHUNK_SIZE = 100;

describe('SharedPool thread safety', () => {
	let workerFile: string;
	beforeAll(async () => {
		workerFile = await bundleWorker(new URL('./shared-pool.safety.worker.ts', import.meta.url));
	}, 60_000);
	// Runs even when the test itself timed out, which is how a deadlocked worker gets killed instead of wedging vitest
	afterEach(() => terminateTestWorkers());
	afterAll(() => cleanupWorkerBundles());

	it('hands out and recycles indexes without ever sharing one', SAFETY_TEST_OPTIONS, async () => {
		// Pre-size the heap so every chunk lands in a buffer all workers already hold, and disable auto-grow: cross-thread
		// buffer growth can't be propagated safely mid-run.
		let heap = new MemoryHeap({ initialBuffers: 24, autoGrowSize: 0 });
		let pool = new SharedPool(heap, { maxChunkSize: MAX_CHUNK_SIZE });

		let workers = WORKER_VALUES.map(value => new TestWorker(workerFile, {
			heap: heap.getSharedMemory(),
			pool: pool.getSharedMemory(),
			value,
			iterations: ITERATIONS,
		}));

		// Wait until every worker has attached to the heap before any of them starts writing
		await Promise.all(workers.map(worker => worker.nextMessage<{ ready: true }>()));

		workers.forEach(worker => worker.postMessage({ run: true }));
		let results = await Promise.all(workers.map(worker => worker.nextMessage<{ expectedCount: number }>()));

		let expectedCount = results.reduce((total, result) => total + result.expectedCount, 0);
		expect(pool.length).toEqual(expectedCount);

		// A full iteration from the main thread must find exactly the surviving records, and every one of them must hold
		// a value some worker actually wrote
		let counts = new Map<number, number>();
		let walked = 0;
		for(let data of pool) {
			counts.set(data[0], (counts.get(data[0]) ?? 0) + 1);
			walked++;
		}
		expect(walked).toEqual(expectedCount);
		expect([...counts.keys()].filter(value => !WORKER_VALUES.includes(value))).toEqual([]);
		expect(WORKER_VALUES.map(value => counts.get(value) ?? 0)).toEqual(results.map(result => result.expectedCount));

		// And each worker must see its own surviving records from its own thread
		workers.forEach(worker => worker.postMessage({ check: true }));
		let checks = await Promise.all(workers.map(worker => worker.nextMessage<{ value: number, actualCount: number, expectedCount: number }>()));
		expect(checks.map(check => check.actualCount)).toEqual(checks.map(check => check.expectedCount));
	});
});
