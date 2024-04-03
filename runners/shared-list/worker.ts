import SharedList from '../../src/shared-list';
import MemoryHeap from '../../src/memory-heap';

let list: SharedList;
let workerNumber: number;

let expectedCount = 0;
let expectedValue = 0;
self.onmessage = (e) => {
	if(e.data.list) {
		let heap = new MemoryHeap(e.data.heap);
		list = new SharedList(heap, e.data.list);
		// @ts-expect-error
		self.workerNumber = workerNumber = e.data.workerNumber;
	} else if(e.data.iterations) {
		expectedValue = e.data.value;
		for(let i = 0; i < e.data.iterations; i++) {
			list.insert(e.data.value);
			expectedCount++;

			// Randomly delete some items
			/*if(Math.random() > 0.8 && list.length) {
				for(let { data, deleteCurrent } of list) {
					if(Math.random() > 0.95 && data[0] === e.data.value) {
						deleteCurrent();
						expectedCount--;
					}
				}
			}*/
		}

		self.postMessage({
			done: true
		});
	} else if(e.data.check) {
		let actualCount = 0;
		for(let { data } of list) {
			if(data[0] === expectedValue) {
				actualCount++;
			}
		}

		if(actualCount !== expectedCount) {
			console.warn(`worker ${workerNumber} expected ${expectedCount} values but found ${actualCount}`);
		}
	}
};