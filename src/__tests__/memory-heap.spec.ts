import MemoryHeap from '../memory-heap';

describe('MemoryHeap', () => {
	it('auto grows memory as needed', () => {
		let memory = new MemoryHeap({ bufferSize: 200 });
		const startedUsed = memory.currentUsed;

		let allocated = memory.allocUI32(10);
		expect(allocated.data.length).toEqual(10);
		memory.allocUI32(10);
		expect(memory.buffers.length).toEqual(1);
		// Don't try to get exact size since actual used memory depends on how much memory malloc is using for internal representation
		expect(memory.currentUsed).toBeGreaterThan(startedUsed + 20 * 4);
		expect(memory.totalAllocated).toEqual(200);
		const midUsed = memory.currentUsed;

		memory.allocUI32(20);
		expect(memory.buffers.length).toEqual(2);
		expect(memory.currentUsed).toBeGreaterThan(midUsed + 20 * 4);
		expect(memory.totalAllocated).toEqual(400);
	});
	it('can re-create from raw memory and continue working', () => {
		let mainMemory = new MemoryHeap({ bufferSize: 200 });
		let copyMemory = new MemoryHeap(mainMemory.getSharedMemory());

		let mainBlock = mainMemory.allocUI32(10);
		let copyBlock = copyMemory.getFromSharedMemory(mainBlock.getSharedMemory());
		expect(copyBlock?.data.length).toEqual(12);

		mainBlock.data[1] = 10;
		expect(copyBlock?.data[1]).toEqual(10);
	});
	it('can grow memory from copy', () => {
		let mainMemory = new MemoryHeap({ bufferSize: 200 });
		let copyMemory = new MemoryHeap(mainMemory.getSharedMemory());
		mainMemory.addOnGrowBufferHandlers(newBuffer => {
			copyMemory.addSharedBuffer(newBuffer);
		});
		copyMemory.addOnGrowBufferHandlers(newBuffer => {
			mainMemory.addSharedBuffer(newBuffer);
		});

		// Main can grow from copy
		mainMemory.allocUI32(20);
		expect(mainMemory.buffers.length).toEqual(1);
		copyMemory.allocUI32(20);
		expect(copyMemory.buffers.length).toEqual(2);
		expect(mainMemory.buffers.length).toEqual(2);

		// Copy can grow from main
		mainMemory.allocUI32(20);
		expect(copyMemory.buffers.length).toEqual(3);
		expect(mainMemory.buffers.length).toEqual(3);
	});

	it('grabs free memory from any used buffer', () => {
		let memory = new MemoryHeap({ bufferSize: 200 });

		let block1 = memory.allocUI32(20);
		let block2 = memory.allocUI32(20);
		let block3 = memory.allocUI32(20);
		expect(memory.buffers.length).toEqual(3);
		let maxMemory = memory.currentUsed;

		block1.free();
		expect(memory.currentUsed).toBeLessThan(maxMemory);
		memory.allocUI32(20);
		expect(memory.buffers.length).toEqual(3);
		expect(memory.currentUsed).toEqual(maxMemory);
		
		block2.free();
		expect(memory.currentUsed).toBeLessThan(maxMemory);
		memory.allocUI32(20);
		expect(memory.buffers.length).toEqual(3);
		expect(memory.currentUsed).toEqual(maxMemory);
		
		block3.free();
		expect(memory.currentUsed).toBeLessThan(maxMemory);
		memory.allocUI32(20);
		expect(memory.buffers.length).toEqual(3);
		expect(memory.currentUsed).toEqual(maxMemory);
	});

	it('growing memory by doubles while freeing previous', () => {
		let memory = new MemoryHeap({
			bufferSize: 1_024 * 16
		});
		let allocSize = 40;

		let oldMemory = memory.allocUI32(allocSize);
		for(let i = 0; i < 5; i++) {
			allocSize *= 2;
			let newMemory = memory.allocUI32(allocSize);
			expect(newMemory.bufferByteOffset).toBeGreaterThan(oldMemory.bufferByteOffset);

			oldMemory.free();
			oldMemory = newMemory;
		}
	});

	it('Block creating with bufferSize greater than 1MB', () => {
		let error: Error | null = null;
		try {
			new MemoryHeap({ bufferSize: Math.pow(2, 30) });
		} catch(e) {
			error = e as Error;
		}

		expect(error).not.toBeNull();
	});
});