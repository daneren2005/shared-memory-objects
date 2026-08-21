import MemoryHeap from '../../src/memory-heap';
import SharedStack from '../../src/shared-stack';
import { attachWorkerLogging, captureGlobalErrors, log, warn } from '../logger';
import prettyMemory from '../pretty-memory';
import TestWorker from './worker?worker';

captureGlobalErrors();

const heap = new MemoryHeap({
	bufferSize: 1024 * 1024,
});
const stack = new SharedStack(heap);

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
	3452452,
	7612,
	63,
	754,
	7316,
	1234,
	4321,
	753,
	97,
	2,
	9223423,
];

const ITERATIONS = 5_000;

workerValues.forEach((value, index) => {
	let worker = new TestWorker();
	worker.postMessage({
		heap: heap.getSharedMemory(),
		stack: stack.getSharedMemory(),
		allValues: workerValues,
		workerNumber: index + 1,
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
	log('running stack operations');
	startTime = performance.now();
	workerValues.forEach((value, index) => {
		workers[index].postMessage({
			iterations: ITERATIONS,
			value,
		});
	});
}, 500);

function checkIfDone() {
	if(workersDone >= workers.length) {
		log(`finished stack operations in ${Math.round(performance.now() - startTime)}ms`);

		if(stack.length === totalExpected) {
			log(`all workers done - stack length ${stack.length} matches expected ${totalExpected}`);
		} else {
			warn(`all workers done - stack length ${stack.length} does NOT match expected ${totalExpected}`);
		}

		// Every value still on the stack must be one a worker actually pushed - catches torn writes across segments
		let validValues = new Set(workerValues);
		let invalid = [];
		for(let data of stack) {
			if(!validValues.has(data)) {
				invalid.push(data);
			}
		}
		if(invalid.length) {
			warn(`stack holds ${invalid.join(', ')} values that were never pushed`);
		} else {
			log(`all ${stack.length} values remaining on the stack are valid`);
		}
		log(`memory: ${prettyMemory(heap)}`);

		workers.forEach(worker => {
			worker.postMessage({
				check: true,
			});
		});
	}
}
