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
});