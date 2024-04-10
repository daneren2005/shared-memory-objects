import type AllocatedMemory from '../../src/allocated-memory';
import MemoryHeap from '../../src/memory-heap';

let memory: MemoryHeap;
let workerNumber: number;

let allocatedBlocks: Array<AllocatedMemory> = [];
self.onmessage = (e) => {
	if(e.data.init) {
		memory = new MemoryHeap(e.data.init);
		// @ts-expect-error
		self.workerNumber = workerNumber = e.data.workerNumber;

		memory.addOnGrowBufferHandlers(data => {
			self.postMessage({
				growBuffer: data
			});
		});
	} else if(e.data.iterations) {
		for(let i = 0; i < e.data.iterations; i++) {
			let allocated = memory.allocUI32(e.data.allocations);
			for(let i = 0; i < allocated.data.length; i++) {
				allocated.data[i] = workerNumber;
			}
			allocatedBlocks.push(allocated);

			// Randomly free some memory to trigger split/compact
			if(Math.random() > 0.8 && allocatedBlocks.length) {
				let freeMemory = randomPop(allocatedBlocks);
				freeMemory.free();
			}
		}

		self.postMessage({
			done: true
		});
	} else if(e.data.check) {
		for(let i = 0; i < allocatedBlocks.length; i++) {
			let allocatedBlock = allocatedBlocks[i];
			for(let j = 0; j < allocatedBlock.data.length; j++) {
				if(allocatedBlock.data[j] !== workerNumber) {
					console.warn(`worker ${workerNumber} found a bad allocation - expected ${workerNumber} but found ${allocatedBlock.data[j]}`);
					return;
				}
			}
		}
	} else if(e.data.growBuffer) {
		memory.addSharedBuffer(e.data.growBuffer);
	}
};

function randomPop<T>(array: Array<T>): T {
	let index = Math.floor(Math.random() * array.length );
	return array.splice(index, 1)[0] as T;
}