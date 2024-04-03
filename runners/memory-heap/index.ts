import MemoryHeap from '../../src/memory-heap';
import TestWorker from './worker?worker';

const memory = new MemoryHeap({
	bufferSize: 1024 * 1024
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

	worker.onmessage = (e) => {
		if(e.data.done) {
			workersDone++;
			checkIfDone();
		}
	};
	workers.push(worker);
});

// Give workers a minute to finish initializing
window.setTimeout(() => {
	console.time('running allocations');
	workerAllocations.forEach((allocations, index) => {
		workers[index].postMessage({
			iterations: 5_000,
			allocations
		});
	});
}, 500);

function checkIfDone() {
	if(workersDone >= workers.length) {
		console.timeEnd('running allocations');
		console.log('all workers done allocating - checking results');
		console.log(`memory: ${memory.prettyMemory()}`);

		workers.forEach(worker => {
			worker.postMessage({
				check: true
			});
		});
	}
}