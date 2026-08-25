import MemoryHeap from '../../src/memory-heap';
import SharedSpatialGrid from '../../src/spatial/shared-spatial-grid';
import { attachWorkerLogging, captureGlobalErrors, log, warn } from '../logger';
import prettyMemory from '../pretty-memory';
import TestWorker from './worker?worker';

captureGlobalErrors();

// Each worker owns a disjoint id range (worker N owns [N * ID_RANGE, N * ID_RANGE + INSERT_PER_WORKER)) so every entity
// has exactly one writer - the standard shared-memory pattern. Workers insert their own entities and then move them
// around the world for several rounds, all concurrently, hammering the per-cell locks. Afterwards a full-world retrieve
// must return exactly the surviving ids, each valid and unique: a torn link, lost update, or dropped multi-cell slot
// would show up as a garbage id, a duplicate, or a count mismatch.
const WORKER_COUNT = 8;
const ID_RANGE = 1_000_000;
const INSERT_PER_WORKER = 1_500;
const UPDATE_ROUNDS = 6;

const WORLD = { x: 0, y: 0, width: 4000, height: 4000 };
const GRID_SIZE = 50;

// Pre-size the heap so every pool chunk / map table allocation lands in a buffer all workers already hold, and disable
// auto-grow: cross-thread buffer growth can't be propagated safely mid-run.
const heap = new MemoryHeap({
	initialBuffers: 24,
	autoGrowSize: 0,
});
const grid = new SharedSpatialGrid(heap, {
	bounds: WORLD,
	gridSize: GRID_SIZE,
	maxEntities: WORKER_COUNT * INSERT_PER_WORKER,
});

const workers: Array<Worker> = [];
let workersDone = 0;
let totalExpected = 0;

for(let index = 0; index < WORKER_COUNT; index++) {
	let workerNumber = index + 1;
	let worker = new TestWorker();
	worker.postMessage({
		heap: heap.getSharedMemory(),
		grid: grid.getSharedMemory(),
		workerNumber,
		idBase: workerNumber * ID_RANGE,
		insertCount: INSERT_PER_WORKER,
		updateRounds: UPDATE_ROUNDS,
		world: WORLD,
	});

	attachWorkerLogging(worker);
	worker.onmessage = (e) => {
		if(e.data.done) {
			workersDone++;
			totalExpected += e.data.expectedCount;
			checkIfDone();
		}
	};
	workers.push(worker);
}

let startTime = 0;
// Give workers a moment to finish initializing
window.setTimeout(() => {
	log(`running spatial grid operations across ${WORKER_COUNT} workers`);
	startTime = performance.now();
	workers.forEach(worker => worker.postMessage({ run: true }));
}, 500);

function checkIfDone() {
	if(workersDone < workers.length) {
		return;
	}

	log(`finished spatial grid operations in ${Math.round(performance.now() - startTime)}ms`);

	if(grid.size === totalExpected) {
		log(`all workers done - grid size ${grid.size} matches expected ${totalExpected}`);
	} else {
		warn(`all workers done - grid size ${grid.size} does NOT match expected ${totalExpected}`);
	}

	// A full-world query returns every stored id. Each must be unique and fall inside some worker's id range - anything
	// else means a corrupted bucket link or a torn slot record.
	let all = grid.retrieve(WORLD.x, WORLD.y, WORLD.width, WORLD.height);
	let unique = new Set(all);
	if(unique.size !== all.length) {
		warn(`full-world retrieve returned ${all.length} ids but only ${unique.size} unique (duplicated bucket link)`);
	} else {
		log(`full-world retrieve returned ${all.length} unique ids`);
	}

	let outOfRange = 0;
	for(let id of unique) {
		let workerNumber = Math.floor(id / ID_RANGE);
		let offset = id - workerNumber * ID_RANGE;
		if(workerNumber < 1 || workerNumber > WORKER_COUNT || offset < 0 || offset >= INSERT_PER_WORKER) {
			outOfRange++;
		}
	}
	if(outOfRange) {
		warn(`found ${outOfRange} retrieved ids that belong to no worker range (torn / garbage id)`);
	} else {
		log('every retrieved id belongs to a valid worker range');
	}
	if(unique.size !== grid.size) {
		warn(`unique retrieved ids ${unique.size} does NOT match grid size ${grid.size}`);
	}

	log(`memory: ${prettyMemory(heap)}`);

	// Ask each worker to verify every entity it still owns is retrievable at its last-known position
	workers.forEach(worker => worker.postMessage({ check: true }));
}
