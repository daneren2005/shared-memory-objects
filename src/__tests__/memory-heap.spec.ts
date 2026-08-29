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
	it('auto grows memory with autoGrowSize: 80', () => {
		let memory = new MemoryHeap({ autoGrowSize: 80, bufferSize: 8_192 });

		memory.allocUI32(1_500);
		expect(memory.buffers.length).toEqual(1);

		memory.allocUI32(200);
		expect(memory.buffers.length).toEqual(2);
		memory.allocUI32(200);
		expect(memory.buffers.length).toEqual(2);
		memory.allocUI32(200);
		memory.allocUI32(1_300);
		expect(memory.buffers.length).toEqual(2);

		memory.allocUI32(200);
		expect(memory.buffers.length).toEqual(3);
	});
	it('appends growth after every initial buffer', () => {
		let memory = new MemoryHeap({ bufferSize: 200, initialBuffers: 3, autoGrowSize: 0 });
		const initialBuffers = memory.buffers.map(buffer => buffer.buf);

		const allocations = Array.from({ length: 4 }, () => memory.allocUI32(20));

		expect(allocations.map(allocation => allocation.bufferPosition)).toEqual([0, 1, 2, 3]);
		expect(memory.buffers.length).toEqual(4);
		expect(memory.buffers.slice(0, 3).map(buffer => buffer.buf)).toEqual(initialBuffers);
	});
	it('can re-create from raw memory and continue working', () => {
		let mainMemory = new MemoryHeap({ bufferSize: 200 });
		let copyMemory = new MemoryHeap(mainMemory.getSharedMemory());

		let mainBlock = mainMemory.allocUI32(10);
		let copyBlock = copyMemory.getSharedAlloc(mainBlock.getSharedMemory());
		expect(copyBlock?.data.length).toEqual(10);

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
			bufferSize: 1_024 * 16,
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

	it('Block creating with bufferSize greater than the addressable max throws', () => {
		let error: Error | null = null;
		try {
			// Buffers up to 2^31 are addressable now (the split shrinks to fit); beyond that leaves no position bits
			void new MemoryHeap({ bufferSize: Math.pow(2, 32) });
		} catch(e) {
			error = e as Error;
		}

		expect(error).not.toBeNull();
	});

	it('Creating with a >1MB bufferSize is now allowed (dynamic pointer split)', () => {
		let heap = new MemoryHeap({ bufferSize: Math.pow(2, 23) });
		// 8MB buffers -> 23 offset bits, 9 position bits -> 512 buffers, still 4GB addressable
		expect(heap.positionBits).toEqual(9);
		expect(heap.bufferSize).toEqual(Math.pow(2, 23));
	});

	it('Another thread updating old freed memory does not corrupt a following allocation', () => {
		let memory = new MemoryHeap({ bufferSize: 200 });
		let block1 = memory.allocUI32(16);
		block1.free();

		let block2 = memory.allocUI32(12);
		let block3 = memory.allocUI32(4);
		block3.data.fill(30);

		block1.data.fill(20);
		let shared2 = memory.getSharedAlloc(block2.getSharedMemory());
		let shared3 = memory.getSharedAlloc(block3.getSharedMemory());

		expect(shared2).toBeDefined();
		expect(shared3).toBeDefined();
		expect(block3.data).toEqual(new Uint32Array([30, 30, 30, 30]));
		expect(block3.usedMemory).toEqual(16);
	});

	it('ensureSpareBuffer grows a fanned-out empty buffer only when none is free', () => {
		let mainMemory = new MemoryHeap({ bufferSize: 200 });
		let copyMemory = new MemoryHeap(mainMemory.getSharedMemory());
		mainMemory.addOnGrowBufferHandlers(newBuffer => copyMemory.addSharedBuffer(newBuffer));

		// Fresh heap: the only buffer holds the header, so it is not empty and a spare must be grown.
		expect(mainMemory.ensureSpareBuffer()).toBe(true);
		expect(mainMemory.buffers.length).toEqual(2);
		// The grown buffer was fanned out to the copy.
		expect(copyMemory.buffers.length).toEqual(2);

		// The spare (buffer 1) is still empty, so another call is a no-op.
		expect(mainMemory.ensureSpareBuffer()).toBe(false);
		expect(mainMemory.buffers.length).toEqual(2);

		// Fill both buffers so no empty spare remains; ensureSpareBuffer then grows a fresh one.
		mainMemory.allocUI32(20);
		mainMemory.allocUI32(20);
		expect(mainMemory.buffers.some(buffer => buffer.isEmpty)).toBe(false);
		expect(mainMemory.ensureSpareBuffer()).toBe(true);
		expect(mainMemory.buffers.length).toEqual(3);
	});

	it('double freeing a block leaves other allocations intact', () => {
		let memory = new MemoryHeap({ bufferSize: 1_024 });
		let block1 = memory.allocUI32(8);
		let block2 = memory.allocUI32(8);
		block2.data.fill(7);

		block1.free();
		block1.free();

		// A corrupted free list would cycle and hand block1's address out to both allocations; block2 must stay intact
		let block3 = memory.allocUI32(8);
		let block4 = memory.allocUI32(8);
		block3.data.fill(9);
		block4.data.fill(11);
		expect(block2.data).toEqual(new Uint32Array(8).fill(7));
		expect(block3.bufferByteOffset).not.toEqual(block4.bufferByteOffset);
		expect(block3.bufferByteOffset).not.toEqual(block2.bufferByteOffset);
	});

	it('round allocs', () => {
		let memory = new MemoryHeap({ bufferSize: 200 });

		let allocated = memory.allocUI32(10.5);
		expect(allocated.data.length).toEqual(11);
	});
});
