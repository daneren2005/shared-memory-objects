import { parentPort, workerData } from 'node:worker_threads';
import MemoryHeap, { type MemoryHeapMemory } from '../memory-heap';
import SharedStack, { type SharedStackMemory } from '../shared-stack';

interface StackWorkerData {
	heap: MemoryHeapMemory
	stack: SharedStackMemory
	value: number
	allValues: Array<number>
	iterations: number
}

const { heap: heapMemory, stack: stackMemory, value, allValues, iterations } = workerData as StackWorkerData;
const port = parentPort!;

const heap = new MemoryHeap(heapMemory);
const stack = new SharedStack(heap, stackMemory);
// A pop can return another worker's value, so all we can verify per pop is that whatever came back is a value that was
// legitimately pushed by someone
const validValues = new Set(allValues);

port.on('message', (message: { run?: boolean }) => {
	if(!message.run) {
		return;
	}

	let expectedCount = 0;
	let invalidPops: Array<number> = [];
	for(let i = 0; i < iterations; i++) {
		stack.push(value);
		expectedCount++;

		// Randomly pop so push and pop run concurrently across every worker
		if(Math.random() > 0.6) {
			let popped = stack.pop();
			if(popped !== undefined) {
				expectedCount--;
				if(!validValues.has(popped)) {
					invalidPops.push(popped);
				}
			}
		}
	}

	port.postMessage({ done: true, expectedCount, invalidPops });
});

port.postMessage({ ready: true });
