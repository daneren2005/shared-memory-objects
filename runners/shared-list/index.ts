import MemoryHeap from '../../src/memory-heap';
import SharedList from '../../src/shared-list';
import { attachWorkerLogging, captureGlobalErrors, log } from '../logger';
import prettyMemory from '../pretty-memory';
import TestWorker from './worker?worker';

captureGlobalErrors();

const heap = new MemoryHeap({
	bufferSize: 1024 * 1024,
});
const list = new SharedList(heap);

const workers: Array<Worker> = [];
let workersDone = 0;

const workerValues = [
	5,
	8,
	52,
	9,
];

workerValues.forEach((allocations, index) => {
	let worker = new TestWorker();
	worker.postMessage({
		heap: heap.getSharedMemory(),
		list: list.getSharedMemory(),
		workerNumber: index + 1,
	});

	attachWorkerLogging(worker);
	worker.onmessage = (e) => {
		if(e.data.done) {
			workersDone++;
			checkIfDone();
		}
	};
	workers.push(worker);
});

let startTime = 0;
// Give workers a minute to finish initializing
window.setTimeout(() => {
	log('running list operations');
	startTime = performance.now();
	workerValues.forEach((value, index) => {
		workers[index].postMessage({
			iterations: 5_000,
			value,
		});
	});
}, 500);

function checkIfDone() {
	if(workersDone >= workers.length) {
		log(`finished list operations in ${Math.round(performance.now() - startTime)}ms`);
		log(`all workers done running - checking results - ${list.length} items`);
		log(`memory: ${prettyMemory(heap)}`);

		workers.forEach(worker => {
			worker.postMessage({
				check: true,
			});
		});
	}
}