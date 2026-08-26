import MemoryHeap from '../../memory-heap';
import SharedSpatialMap from '../shared-spatial-map';
import { SAFETY_TEST_OPTIONS, cleanupWorkerBundles, terminateTestWorkers } from '../../__tests__/helpers/worker-threads';
import { bundleSpatialWorker, expectedSpatialResult, runSpatialSafety } from './helpers/spatial-safety';

const WORKER_COUNT = 8;
const INSERT_PER_WORKER = 1_500;
const UPDATE_ROUNDS = 6;
const GRID_SIZE = 50;
const BUCKET_COUNT = 8192;

describe('SharedSpatialMap thread safety', () => {
	let workerFile: string;
	beforeAll(async () => {
		workerFile = await bundleSpatialWorker();
	}, 60_000);
	// Runs even when the test itself timed out, which is how a deadlocked worker gets killed instead of wedging vitest
	afterEach(() => terminateTestWorkers());
	afterAll(() => cleanupWorkerBundles());

	// Unlike the grid this world has no fixed extent - cells are hashed into a fixed bucket array, so distinct cells
	// share buckets and the id+cell disambiguation gets exercised too.
	it('stays consistent while several threads insert, update and remove at once', SAFETY_TEST_OPTIONS, async () => {
		// Pre-size the heap so every pool chunk / map table allocation lands in a buffer all workers already hold, and
		// disable auto-grow: cross-thread buffer growth can't be propagated safely mid-run.
		let heap = new MemoryHeap({ initialBuffers: 24, autoGrowSize: 0 });
		let map = new SharedSpatialMap(heap, {
			gridSize: GRID_SIZE,
			buckets: BUCKET_COUNT,
			maxEntities: WORKER_COUNT * INSERT_PER_WORKER,
		});

		let result = await runSpatialSafety(workerFile, {
			kind: 'map',
			heap,
			structure: map,
			workerCount: WORKER_COUNT,
			insertPerWorker: INSERT_PER_WORKER,
			updateRounds: UPDATE_ROUNDS,
		});

		expect(result).toEqual(expectedSpatialResult(WORKER_COUNT * INSERT_PER_WORKER));
	});
});
