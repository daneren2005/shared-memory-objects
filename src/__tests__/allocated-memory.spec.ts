import MemoryHeap from '../memory-heap';

describe('AllocatedMemory', () => {
	describe('getArray', () => {
		it('Int32Array', () => {
			let heap = new MemoryHeap();
			let memory = heap.allocUI32(5);

			expect(memory.getArray(Int32Array, 0, 5).length).toEqual(5);
			expect(memory.getArray(Int32Array, 0, 5).byteOffset).toEqual(56);
			expect(memory.getArray(Int32Array, 2, 3).length).toEqual(3);
			expect(memory.getArray(Int32Array, 2, 3).byteOffset).toEqual(64);
			expect(() => memory.getArray(Int32Array, 0, 6)).toThrowError();
			expect(() => memory.getArray(Int32Array, 2, 4)).toThrowError();
		});

		it('Int16Array', () => {
			let heap = new MemoryHeap();
			let memory = heap.allocUI32(5);

			expect(memory.getArray(Int16Array, 0, 10).length).toEqual(10);
			expect(memory.getArray(Int16Array, 0, 10).byteOffset).toEqual(56);
			expect(memory.getArray(Int16Array, 4, 6).length).toEqual(6);
			expect(memory.getArray(Int16Array, 4, 6).byteOffset).toEqual(64);
			expect(() => memory.getArray(Int16Array, 0, 12)).toThrowError();
			expect(() => memory.getArray(Int16Array, 4, 8)).toThrowError();
		});
	});
});