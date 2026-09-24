import MemoryHeap from '../memory-heap';
import SharedList from '../shared-list';
import { SAFETY_TEST_OPTIONS, TestWorker, bundleWorker, cleanupWorkerBundles, terminateTestWorkers } from './helpers/worker-threads';

// Exercises the auto-reclaim path under real concurrency: every worker keeps a disjoint block of permanent values while
// hammering insert+delete churn that drives autoReclaim to physically unlink and free interior nodes - all while the other
// workers are still inserting. A reclaim that freed a reachable node, corrupted a link an insert touched, or double-freed
// would show up as a lost/duplicated/extra value or a torn node in the final quiescent walk.
// Small live set (cheap deleteValue scans) but enough churn that autoReclaim fires many times per worker
const WORKER_COUNT = 10;
const PERMANENT_COUNT = 40;
const CHURN_ITERATIONS = 1_500;

describe('SharedList reclaim thread safety', () => {
	let workerFile: string;
	beforeAll(async () => {
		workerFile = await bundleWorker(new URL('./shared-list-reclaim.safety.worker.ts', import.meta.url));
	}, 60_000);
	afterEach(() => terminateTestWorkers());
	afterAll(() => cleanupWorkerBundles());

	it('keeps every permanent node and frees every churned node with no corruption', SAFETY_TEST_OPTIONS, async () => {
		// Pre-size the heap so every node lands in a buffer all workers already hold, and disable auto-grow
		let heap = new MemoryHeap({ initialBuffers: 48, autoGrowSize: 0 });
		let list = new SharedList(heap);

		let workers = Array.from({ length: WORKER_COUNT }, (_unused, workerId) => new TestWorker(workerFile, {
			heap: heap.getSharedMemory(),
			list: list.getSharedMemory(),
			base: workerId * 1_000_000,
			permanentCount: PERMANENT_COUNT,
			churnIterations: CHURN_ITERATIONS,
		}));

		await Promise.all(workers.map(worker => worker.nextMessage<{ ready: true }>()));
		workers.forEach(worker => worker.postMessage({ run: true }));
		await Promise.all(workers.map(worker => worker.nextMessage<{ done: true }>()));

		// Quiescent walk from the main thread: exactly the permanents, each once, and nothing else
		let expectedTotal = WORKER_COUNT * PERMANENT_COUNT;
		expect(list.length).toEqual(expectedTotal);

		let counts = new Map<number, number>();
		let walked = 0;
		for(let { data } of list) {
			counts.set(data[0], (counts.get(data[0]) ?? 0) + 1);
			walked++;
		}
		expect(walked).toEqual(expectedTotal);

		let missing: number[] = [];
		let duplicated: number[] = [];
		for(let workerId = 0; workerId < WORKER_COUNT; workerId++) {
			for(let i = 0; i < PERMANENT_COUNT; i++) {
				let value = workerId * 1_000_000 + i;
				let seen = counts.get(value) ?? 0;
				if(seen === 0) {
					missing.push(value);
				} else if(seen > 1) {
					duplicated.push(value);
				}
			}
		}
		expect(missing).toEqual([]);
		expect(duplicated).toEqual([]);
		// Every value in the list is a permanent one - no leaked temp/churn value survived
		expect(counts.size).toEqual(expectedTotal);
	});
});
