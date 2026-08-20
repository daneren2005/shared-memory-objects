import SharedPool from '../../src/shared-pool';
import MemoryHeap from '../../src/memory-heap';
import { log, warn } from '../logger';

let pool: SharedPool;
let workerNumber: number;

let expectedCount = 0;
let expectedValue = 0;
self.onmessage = (e) => {
	if(e.data.pool) {
		let heap = new MemoryHeap(e.data.heap);
		pool = new SharedPool(heap, e.data.pool);
		// @ts-expect-error
		self.workerNumber = workerNumber = e.data.workerNumber;
	} else if(e.data.iterations) {
		expectedValue = e.data.value;
		// Track the indexes we own so we can hand some of them back to the recycle path
		let insertedIndexes: Array<number> = [];
		for(let i = 0; i < e.data.iterations; i++) {
			let index = pool.push(e.data.value);
			insertedIndexes.push(index);
			expectedCount++;

			// Randomly delete one of our own inserted indexes to exercise the recycle path
			if(Math.random() > 0.8 && insertedIndexes.length) {
				let removeAt = Math.floor(Math.random() * insertedIndexes.length);
				let deleteIndex = insertedIndexes[removeAt];
				insertedIndexes.splice(removeAt, 1);
				pool.deleteIndex(deleteIndex);
				expectedCount--;
			}
		}

		self.postMessage({
			done: true,
			expectedCount
		});
	} else if(e.data.check) {
		let actualCount = 0;
		for(let data of pool) {
			if(data[0] === expectedValue) {
				actualCount++;
			}
		}

		if(actualCount !== expectedCount) {
			warn(`worker ${workerNumber} expected ${expectedCount} values but found ${actualCount}`);
		} else {
			log(`worker ${workerNumber} found all ${actualCount} expected values`);
		}
	}
};
