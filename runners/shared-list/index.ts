import MemoryHeap from '../../src/memory-heap';
import SharedList from '../../src/shared-list';
import TestWorker from './worker?worker';

const heap = new MemoryHeap({
	bufferSize: 1024 * 1024
});
const list = new SharedList(heap);

const workers: Array<Worker> = [];
let workersDone = 0;

const workerValues = [
	5,
	8,
	52,
	9
];

workerValues.forEach((allocations, index) => {
	let worker = new TestWorker();
	worker.postMessage({
		heap: heap.getSharedMemory(),
		list: list.getSharedMemory(),
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
	console.time('running list operations');
	workerValues.forEach((value, index) => {
		workers[index].postMessage({
			iterations: 5_000,
			value
		});
	});
}, 500);

function checkIfDone() {
	if(workersDone >= workers.length) {
		console.timeEnd('running list operations');
		console.log(`all workers done running - checking results - ${list.length} items`);
		console.log(`memory: ${heap.prettyMemory()}`);

		workers.forEach(worker => {
			worker.postMessage({
				check: true
			});
		});
	}
}