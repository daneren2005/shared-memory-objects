import SharedStack from '../../src/shared-stack';
import MemoryHeap from '../../src/memory-heap';
import { log, warn } from '../logger';

let stack: SharedStack;
let workerNumber: number;

// The full set of values any worker pushes - a pop can return another worker's value, so all we can verify per pop is
// that whatever came back is a value that was legitimately pushed by someone
let validValues = new Set<number>();

let expectedCount = 0;
let invalidPops = 0;
self.onmessage = (e) => {
	if(e.data.stack) {
		let heap = new MemoryHeap(e.data.heap);
		stack = new SharedStack(heap, e.data.stack);
		validValues = new Set(e.data.allValues);
		// @ts-expect-error
		self.workerNumber = workerNumber = e.data.workerNumber;
	} else if(e.data.iterations) {
		for(let i = 0; i < e.data.iterations; i++) {
			stack.push(e.data.value);
			expectedCount++;

			// Randomly pop so push and pop run concurrently across every worker
			if(Math.random() > 0.6) {
				let popped = stack.pop();
				if(popped !== undefined) {
					expectedCount--;
					if(!validValues.has(popped)) {
						invalidPops++;
					}
				}
			}
		}

		self.postMessage({
			done: true,
			expectedCount,
			invalidPops,
		});
	} else if(e.data.check) {
		if(invalidPops > 0) {
			warn(`worker ${workerNumber} popped ${invalidPops} values that were never pushed`);
		} else {
			log(`worker ${workerNumber} only ever popped valid pushed values`);
		}
	}
};
