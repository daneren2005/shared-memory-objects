import { parentPort, workerData } from 'node:worker_threads';
import MemoryHeap, { type MemoryHeapMemory } from '../memory-heap';
import SharedList, { type SharedListMemory } from '../shared-list';

interface ListWorkerData {
	heap: MemoryHeapMemory
	list: SharedListMemory
	value: number
	iterations: number
}

const { heap: heapMemory, list: listMemory, value, iterations } = workerData as ListWorkerData;
const port = parentPort!;

const heap = new MemoryHeap(heapMemory);
const list = new SharedList(heap, listMemory);

let expectedCount = 0;

port.on('message', (message: { run?: boolean, check?: boolean }) => {
	if(message.run) {
		for(let i = 0; i < iterations; i++) {
			list.insert(value);
			expectedCount++;
		}

		port.postMessage({ done: true, expectedCount });
	} else if(message.check) {
		// Walking the whole chain while the other workers have stopped: every node this worker inserted must still be there
		let actualCount = 0;
		for(let { data } of list) {
			if(data[0] === value) {
				actualCount++;
			}
		}

		port.postMessage({ checked: true, value, actualCount, expectedCount });
	}
});

port.postMessage({ ready: true });
