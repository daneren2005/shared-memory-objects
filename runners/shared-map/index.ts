import MemoryHeap from '../../src/memory-heap';
import SharedMap from '../../src/shared-map';
import { attachWorkerLogging, captureGlobalErrors, log, warn } from '../logger';
import prettyMemory from '../pretty-memory';
import TestWorker from './worker?worker';

captureGlobalErrors();

// Each worker owns a disjoint key range (worker N uses [N * KEY_RANGE, (N + 1) * KEY_RANGE)) and stores value === key, so
// after the run every surviving entry must have value === key and a key that lands in exactly one worker's range - which
// catches torn writes and lost updates from concurrent set/delete/resize hammering the same shared table.
const KEY_RANGE = 1_000_000;
const ITERATIONS = 5_000; // must stay below KEY_RANGE so ranges never overlap
const WORKER_COUNT = 10;

// Pre-size the heap so every table (re)allocation lands in a buffer all workers already hold. Cross-thread buffer growth
// can't be propagated safely mid-run, so we give the map room to grow its table without ever calling growBuffer.
const heap = new MemoryHeap({
	initialBuffers: 8,
});
const map = new SharedMap<number>(heap);

const workers: Array<Worker> = [];
let workersDone = 0;
let totalExpected = 0;
const rangeExpected = new Map<number, number>();

for(let index = 0; index < WORKER_COUNT; index++) {
	let workerNumber = index + 1;
	let worker = new TestWorker();
	worker.postMessage({
		heap: heap.getSharedMemory(),
		map: map.getSharedMemory(),
		workerNumber,
		keyRange: KEY_RANGE,
	});

	attachWorkerLogging(worker);
	worker.onmessage = (e) => {
		if(e.data.done) {
			workersDone++;
			totalExpected += e.data.expectedCount;
			rangeExpected.set(e.data.workerNumber, e.data.expectedCount);
			checkIfDone();
		}
	};
	workers.push(worker);
}

let startTime = 0;
// Give workers a moment to finish initializing
window.setTimeout(() => {
	log(`running map operations across ${WORKER_COUNT} workers`);
	startTime = performance.now();
	workers.forEach((worker) => {
		worker.postMessage({
			iterations: ITERATIONS,
		});
	});
}, 500);

function checkIfDone() {
	if(workersDone < workers.length) {
		return;
	}

	log(`finished map operations in ${Math.round(performance.now() - startTime)}ms`);

	if(map.length === totalExpected) {
		log(`all workers done - map length ${map.length} matches expected ${totalExpected}`);
	} else {
		warn(`all workers done - map length ${map.length} does NOT match expected ${totalExpected}`);
	}

	// Global scan: every entry must be a value === key torn-write-free pair, and its key must belong to exactly one
	// worker's range. Tally per range so we can compare against what each worker reported it left behind.
	let tornWrites = 0;
	let outOfRange = 0;
	let rangeActual = new Map<number, number>();
	for(let [key, value] of map) {
		if(value !== key) {
			tornWrites++;
		}
		let workerNumber = Math.floor(key / KEY_RANGE);
		if(workerNumber < 1 || workerNumber > WORKER_COUNT) {
			outOfRange++;
		} else {
			rangeActual.set(workerNumber, (rangeActual.get(workerNumber) ?? 0) + 1);
		}
	}

	if(tornWrites) {
		warn(`found ${tornWrites} entries where value !== key (torn write / lost update)`);
	} else {
		log('every entry has value === key');
	}
	if(outOfRange) {
		warn(`found ${outOfRange} entries whose key belongs to no worker range`);
	} else {
		log('every entry key belongs to a valid worker range');
	}

	let mismatched = 0;
	for(let workerNumber = 1; workerNumber <= WORKER_COUNT; workerNumber++) {
		let expected = rangeExpected.get(workerNumber) ?? 0;
		let actual = rangeActual.get(workerNumber) ?? 0;
		if(expected !== actual) {
			mismatched++;
			warn(`worker ${workerNumber} range holds ${actual} entries but reported ${expected}`);
		}
	}
	if(!mismatched) {
		log('every worker range holds exactly the number of entries the worker reported');
	}

	log(`memory: ${prettyMemory(heap)}`);

	// Ask each worker to verify its own known-live keys resolve and its deleted keys are gone
	workers.forEach(worker => worker.postMessage({ check: true }));
}
