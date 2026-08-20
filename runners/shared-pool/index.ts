import MemoryHeap from '../../src/memory-heap';
import SharedPool from '../../src/shared-pool';
import { attachWorkerLogging, captureGlobalErrors, log, warn } from '../logger';
import prettyMemory from '../pretty-memory';
import TestWorker from './worker?worker';

captureGlobalErrors();

const heap = new MemoryHeap({
	bufferSize: 1024 * 1024
});
// Small maxChunkSize so we constantly cross chunk boundaries and hammer the buffer-growth path
const pool = new SharedPool(heap, {
	maxChunkSize: 100
});

const workers: Array<Worker> = [];
let workersDone = 0;
let totalExpected = 0;

const workerValues = [
	5,
	8,
	52,
	9,
	1093,
	524,
	7645,
	2334,
	14,
	3452452
];

const ITERATIONS = 5_000;

workerValues.forEach((value, index) => {
	let worker = new TestWorker();
	worker.postMessage({
		heap: heap.getSharedMemory(),
		pool: pool.getSharedMemory(),
		workerNumber: index + 1
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
});

let startTime = 0;
// Give workers a moment to finish initializing
window.setTimeout(() => {
	log('running pool operations');
	startTime = performance.now();
	workerValues.forEach((value, index) => {
		workers[index].postMessage({
			iterations: ITERATIONS,
			value
		});
	});
}, 500);

function checkIfDone() {
	if(workersDone >= workers.length) {
		log(`finished pool operations in ${Math.round(performance.now() - startTime)}ms`);

		if(pool.length === totalExpected) {
			log(`all workers done - pool length ${pool.length} matches expected ${totalExpected}`);
		} else {
			warn(`all workers done - pool length ${pool.length} does NOT match expected ${totalExpected}`);
		}
		log(`memory: ${prettyMemory(heap)}`);

		workers.forEach(worker => {
			worker.postMessage({
				check: true
			});
		});
	}
}
