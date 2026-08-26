import MemoryHeap from '../memory-heap';
import SharedStack from '../shared-stack';
import { SAFETY_TEST_OPTIONS, TestWorker, bundleWorker, cleanupWorkerBundles, terminateTestWorkers } from './helpers/worker-threads';

// Real multi-threaded safety test - the vitest version of runners/shared-stack, driving node worker_threads instead of
// browser Web Workers. Every worker pushes one distinctive value and randomly pops, so push and pop race on the same
// slots the whole run: a torn slot or a lost publish sequence shows up as a value nobody ever pushed, and a lost update
// shows up as a length that disagrees with what the workers net-pushed.
const WORKER_VALUES = [
	5, 8, 52, 9, 1093, 524, 7645, 2334, 14, 3452452,
	7612, 63, 754, 7316, 1234, 4321, 753, 97, 2, 9223423,
];
const ITERATIONS = 5_000;

describe('SharedStack thread safety', () => {
	let workerFile: string;
	beforeAll(async () => {
		workerFile = await bundleWorker(new URL('./shared-stack.safety.worker.ts', import.meta.url));
	}, 60_000);
	// Runs even when the test itself timed out, which is how a deadlocked worker gets killed instead of wedging vitest
	afterEach(() => terminateTestWorkers());
	afterAll(() => cleanupWorkerBundles());

	it('never loses, duplicates or tears a value while threads push and pop at once', SAFETY_TEST_OPTIONS, async () => {
		// Pre-size the heap so every segment lands in a buffer all workers already hold, and disable auto-grow:
		// cross-thread buffer growth can't be propagated safely mid-run.
		let heap = new MemoryHeap({ initialBuffers: 24, autoGrowSize: 0 });
		let stack = new SharedStack(heap);

		let workers = WORKER_VALUES.map(value => new TestWorker(workerFile, {
			heap: heap.getSharedMemory(),
			stack: stack.getSharedMemory(),
			value,
			allValues: WORKER_VALUES,
			iterations: ITERATIONS,
		}));

		// Wait until every worker has attached to the heap before any of them starts writing
		await Promise.all(workers.map(worker => worker.nextMessage<{ ready: true }>()));

		workers.forEach(worker => worker.postMessage({ run: true }));
		let results = await Promise.all(workers.map(worker => worker.nextMessage<{ expectedCount: number, invalidPops: Array<number> }>()));

		expect(results.map(result => result.invalidPops)).toEqual(workers.map(() => []));

		let expectedCount = results.reduce((total, result) => total + result.expectedCount, 0);
		expect(stack.length).toEqual(expectedCount);

		// Every value still on the stack must be one a worker actually pushed - catches torn writes across segments
		let validValues = new Set(WORKER_VALUES);
		let invalid: Array<number> = [];
		let seen = 0;
		for(let data of stack) {
			seen++;
			if(!validValues.has(data)) {
				invalid.push(data);
			}
		}
		expect(invalid).toEqual([]);
		expect(seen).toEqual(expectedCount);
	});
});
