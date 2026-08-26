import MemoryHeap from '../../memory-heap';
import SharedSpatialGrid from '../shared-spatial-grid';
import { SAFETY_TEST_OPTIONS, cleanupWorkerBundles, terminateTestWorkers } from '../../__tests__/helpers/worker-threads';
import { WORLD, bundleSpatialWorker, expectedSpatialResult, runSpatialSafety } from './helpers/spatial-safety';

const WORKER_COUNT = 8;
const INSERT_PER_WORKER = 1_500;
const UPDATE_ROUNDS = 6;
const GRID_SIZE = 50;

describe('SharedSpatialGrid thread safety', () => {
	let workerFile: string;
	beforeAll(async () => {
		workerFile = await bundleSpatialWorker();
	}, 60_000);
	// Runs even when the test itself timed out, which is how a deadlocked worker gets killed instead of wedging vitest
	afterEach(() => terminateTestWorkers());
	afterAll(() => cleanupWorkerBundles());

	it('stays consistent while several threads insert, update and remove at once', SAFETY_TEST_OPTIONS, async () => {
		// Pre-size the heap so every pool chunk / map table allocation lands in a buffer all workers already hold, and
		// disable auto-grow: cross-thread buffer growth can't be propagated safely mid-run.
		let heap = new MemoryHeap({ initialBuffers: 24, autoGrowSize: 0 });
		let grid = new SharedSpatialGrid(heap, {
			bounds: WORLD,
			gridSize: GRID_SIZE,
			maxEntities: WORKER_COUNT * INSERT_PER_WORKER,
		});

		let result = await runSpatialSafety(workerFile, {
			kind: 'grid',
			heap,
			structure: grid,
			workerCount: WORKER_COUNT,
			insertPerWorker: INSERT_PER_WORKER,
			updateRounds: UPDATE_ROUNDS,
		});

		expect(result).toEqual(expectedSpatialResult(
			WORKER_COUNT * INSERT_PER_WORKER,
			WORKER_COUNT * UPDATE_ROUNDS,
		));
	});
});
