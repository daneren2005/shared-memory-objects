import { parentPort, workerData } from 'node:worker_threads';
import MemoryHeap, { type MemoryHeapMemory } from '../memory-heap';
import SharedPool, { type SharedPoolMemory } from '../shared-pool';

interface PoolWorkerData {
	heap: MemoryHeapMemory
	pool: SharedPoolMemory
	value: number
	iterations: number
}

const { heap: heapMemory, pool: poolMemory, value, iterations } = workerData as PoolWorkerData;
const port = parentPort!;

const heap = new MemoryHeap(heapMemory);
const pool = new SharedPool(heap, poolMemory);

let expectedCount = 0;

port.on('message', (message: { run?: boolean, check?: boolean }) => {
	if(message.run) {
		// Track the indexes we own so we can hand some of them back to the recycle path
		let insertedIndexes: Array<number> = [];
		for(let i = 0; i < iterations; i++) {
			insertedIndexes.push(pool.push(value));
			expectedCount++;

			// Randomly delete one of our own inserted indexes to exercise the recycle path
			if(Math.random() > 0.8) {
				let removeAt = Math.floor(Math.random() * insertedIndexes.length);
				let deleteIndex = insertedIndexes[removeAt];
				insertedIndexes.splice(removeAt, 1);
				pool.deleteIndex(deleteIndex);
				expectedCount--;
			}
		}

		port.postMessage({ done: true, expectedCount });
	} else if(message.check) {
		// Each worker uses a distinctive value, so counting its own value across the whole pool counts exactly the
		// records it still owns - a recycled index handed to two threads would show up here as a wrong count
		let actualCount = 0;
		for(let data of pool) {
			if(data[0] === value) {
				actualCount++;
			}
		}

		port.postMessage({ checked: true, value, actualCount, expectedCount });
	}
});

port.postMessage({ ready: true });
