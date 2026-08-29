import MemoryBuffer from '../memory-buffer';

describe('MemoryBuffer', () => {
	describe('lengthOf', () => {
		it('valid', () => {
			let buffer = new MemoryBuffer();
			let data0 = buffer.callocAs('u32', 10) as Uint32Array;
			let data1 = buffer.callocAs('u32', 4) as Uint32Array;
			let data2 = buffer.callocAs('u32', 8) as Uint32Array;

			expect(buffer.lengthOf(data0)).toEqual(10);
			expect(buffer.lengthOf(data1)).toEqual(4);
			expect(buffer.lengthOf(data2)).toEqual(8);
		});

		it('old invalid memory', () => {
			let buffer = new MemoryBuffer();
			let data0 = buffer.callocAs('u32', 10) as Uint32Array;
			let data1 = buffer.callocAs('u32', 4) as Uint32Array;
			let data2 = buffer.callocAs('u32', 8) as Uint32Array;

			// Create new data location the size of #1/2 combined
			buffer.free(data1);
			buffer.free(data2);
			let data3 = buffer.callocAs('u32', 12) as Uint32Array;
			data3.fill(40);
			buffer.callocAs('u32', 10) as Uint32Array;
			
			expect(buffer.lengthOf(data0)).toEqual(10);
			expect(buffer.lengthOf(data3)).toEqual(12);
			expect(buffer.lengthOf(data2)).toBeUndefined();
		});
	});

	describe('free', () => {
		// O(1) free trusts the doubly-linked used list, so a rejected double-free is what keeps a second free from
		// splicing stale free-list pointers back into the used list and handing the same block out twice.
		it('rejects a double free without corrupting the allocator', () => {
			let buffer = new MemoryBuffer({ compact: false, split: false });
			let data0 = buffer.callocAs('u32', 4) as Uint32Array;
			let data1 = buffer.callocAs('u32', 4) as Uint32Array;
			let data2 = buffer.callocAs('u32', 4) as Uint32Array;

			expect(buffer.free(data1)).toBe(true);
			expect(buffer.free(data1)).toBe(false);

			// Neighbours are untouched and the freed block is handed out exactly once on reuse
			expect(buffer.lengthOf(data0)).toEqual(4);
			expect(buffer.lengthOf(data2)).toEqual(4);
			let reused = buffer.callocAs('u32', 4) as Uint32Array;
			expect(reused.byteOffset).toEqual(data1.byteOffset);
			let fresh = buffer.callocAs('u32', 4) as Uint32Array;
			expect(fresh.byteOffset).not.toEqual(data1.byteOffset);
		});
	});

	describe('calloc', () => {
		// Fresh bump memory skips zero-filling (backing buffer is already zero), but reused memory is dirty and must be re-zeroed.
		it('zeroes reused memory that a previous allocation dirtied', () => {
			let buffer = new MemoryBuffer({ compact: false, split: false });
			let data0 = buffer.callocAs('u32', 4) as Uint32Array;
			data0.fill(0xdead);
			buffer.free(data0);

			let reused = buffer.callocAs('u32', 4) as Uint32Array;
			expect(reused.byteOffset).toEqual(data0.byteOffset);
			expect(Array.from(reused)).toEqual([0, 0, 0, 0]);
		});

		it('honors a non-zero fill on fresh memory', () => {
			let buffer = new MemoryBuffer({ compact: false, split: false });
			let data = buffer.callocAs('u32', 4, 7) as Uint32Array;
			expect(Array.from(data)).toEqual([7, 7, 7, 7]);
		});
	});
});