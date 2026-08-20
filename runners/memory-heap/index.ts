import MemoryHeap from '../../src/memory-heap';
import { attachWorkerLogging, captureGlobalErrors, log } from '../logger';
import prettyMemory from '../pretty-memory';
import TestWorker from './worker?worker';

captureGlobalErrors();

const memory = new MemoryHeap({
	bufferSize: 1024 * 10
});

const workers: Array<Worker> = [];
let workersDone = 0;

const workerAllocations = [
	2,
	12,
	1,
	6,
	3,
	2,
	1
];

workerAllocations.forEach((allocations, index) => {
	let worker = new TestWorker();
	worker.postMessage({
		init: memory.getSharedMemory(),
		workerNumber: index + 1
	});

	attachWorkerLogging(worker);
	worker.onmessage = (e) => {
		if(e.data.done) {
			workersDone++;
			checkIfDone();
		} else if(e.data.growBuffer) {
			memory.addSharedBuffer(e.data.growBuffer);

			for(let i = 0; i < workers.length; i++) {
				if(i === index) {
					continue;
				}

				workers[i].postMessage({
					growBuffer: e.data.growBuffer
				});
			}
		}
	};
	workers.push(worker);
});

let startTime = 0;
// Give workers a minute to finish initializing
window.setTimeout(() => {
	log('running allocations');
	startTime = performance.now();
	workerAllocations.forEach((allocations, index) => {
		workers[index].postMessage({
			iterations: 5_000,
			allocations
		});
	});
}, 500);

function checkIfDone() {
	if(workersDone >= workers.length) {
		log(`finished allocations in ${Math.round(performance.now() - startTime)}ms`);
		log('all workers done allocating - checking results');
		log(`memory: ${prettyMemory(memory)} - ${memory.buffers.length} buffers`);

		workers.forEach(worker => {
			worker.postMessage({
				check: true
			});
		});
	}
}