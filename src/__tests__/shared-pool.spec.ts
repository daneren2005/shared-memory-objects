import MemoryHeap from '../memory-heap';
import SharedPool from '../shared-pool';

describe('SharedPool', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap({
			bufferSize: 1024 * 16
		});
	});

	it('insert', () => {
		let vector = new SharedPool(memory, {
			type: Uint32Array
		});

		expect(vector.push(10)).toEqual(0);
		expect(vector.push(52)).toEqual(1);
		expect(vector.push(4)).toEqual(2);
		vector.push(18);
		vector.push(25);

		expect(vector.length).toEqual(5);
		expect(flat(vector)).toEqual([10, 52, 4, 18, 25]);

		expect([...vector.at(0)]).toEqual([10]);
		expect(vector.get(0)).toEqual(10);
		expect([...vector.at(1)]).toEqual([52]);
		expect(vector.get(2)).toEqual(4);
		expect(vector.get(4)).toEqual(25);
		expect(vector.bufferLength).toEqual(100);
	});

	it('continually grows memory as needed', () => {
		let vector = new SharedPool(memory, {
			type: Uint32Array,
			maxChunkSize: 100
		});

		const expectedValues = [];
		for(let i = 0; i < 1_020; i++) {
			vector.push(i);
			expectedValues.push(i);
		}

		expect(vector.length).toEqual(1_020);
		expect(flat(vector)).toEqual(expectedValues);
		for(let i = 0; i < 1_020; i++) {
			expect(vector.get(i)).toEqual(i);
		}
		expect(vector.bufferLength).toEqual(1_100);
	});

	it('deleteIndex', () => {
		let vector = new SharedPool(memory);

		vector.push(10);
		vector.push(52);
		vector.push(4);
		vector.push(8);

		vector.deleteIndex(3);
		expect(vector.length).toEqual(3);
		expect(flat(vector)).toEqual([10, 52, 4]);
		
		vector.deleteIndex(1);
		expect(vector.length).toEqual(2);
		expect(flat(vector)).toEqual([10, 4]);
		// Stable index
		expect(vector.get(2)).toEqual(4);
		
		vector.deleteIndex(0);
		expect(vector.length).toEqual(1);
		expect(flat(vector)).toEqual([4]);

		// Recycles indexes so shouldn't be ordered as a new insert!
		vector.push(97);
		vector.push(65);
		expect(vector.length).toEqual(3);
		expect(flat(vector)).toEqual([97, 65, 4]);

		// Can delete last element
		vector.deleteIndex(1);
		vector.deleteIndex(2);
		expect(vector.length).toEqual(1);
		expect(flat(vector)).toEqual([97]);
	});

	it('with dataLength: 3', () => {
		let vector = new SharedPool(memory, {
			type: Uint32Array,
			dataLength: 3
		});

		vector.push(10);
		expect(vector.push([52, 32, 6])).toEqual(1);
		vector.push([40, 41, 42]);

		expect(vector.length).toEqual(3);
		expect(flat(vector)).toEqual([
			10, 0, 0,
			52, 32, 6,
			40, 41, 42
		]);
		expect([...vector.at(0)]).toEqual([10, 0, 0]);
		expect([...vector.at(1)]).toEqual([52, 32, 6]);
		expect([...vector.at(2)]).toEqual([40, 41, 42]);
		expect(vector.get(0, 0)).toEqual(10);
		expect(vector.get(0, 1)).toEqual(0);
		expect(vector.get(1, 2)).toEqual(6);
		expect(vector.get(2)).toEqual(40);

		vector.deleteIndex(0);
		expect(vector.length).toEqual(2);
		expect(flat(vector)).toEqual([
			52, 32, 6,
			40, 41, 42
		]);
		// Indexes are stable and do not change
		expect([...vector.at(1)]).toEqual([52, 32, 6]);
		expect(vector.get(1)).toEqual(52);
		expect(vector.get(1, 2)).toEqual(6);
	});

	it('float32', () => {
		let vector = new SharedPool(memory, {
			type: Float32Array
		});

		vector.push(10.5);
		vector.push(52);
		vector.push(4.5);
		vector.push(13.5);
		vector.push(6);

		expect(vector.length).toEqual(5);
		expect(flat(vector)).toEqual([10.5, 52, 4.5, 13.5, 6]);

		expect([...vector.at(0)]).toEqual([10.5]);
		expect(vector.get(0)).toEqual(10.5);
		expect([...vector.at(1)]).toEqual([52]);
		expect(vector.get(2)).toEqual(4.5);
	});

	it('float64', () => {
		const startMemory = memory.currentUsed;
		let vector = new SharedPool(memory, {
			type: Float64Array
		});
		expect(vector.byteMultipler).toEqual(2);
		let cloneVector = new SharedPool(memory, vector.getSharedMemory());
		expect(cloneVector.byteMultipler).toEqual(2);

		// Float64 should be allocating more than normal 32bit ones
		let afterFloat64Memory = memory.currentUsed;
		new SharedPool(memory);
		expect(memory.currentUsed - afterFloat64Memory).toBeLessThan(afterFloat64Memory - startMemory);

		vector.push(10.5);
		vector.push(52);
		vector.push(4.5);
		vector.push(13.5);
		vector.push(6);
		// JS uses Float64 for numbers by default, so we should be able to store/retrieve max sized numbers like normal
		vector.push(Number.MAX_SAFE_INTEGER);
		vector.push(Number.MAX_VALUE);

		expect(vector.length).toEqual(7);
		expect(flat(vector)).toEqual([10.5, 52, 4.5, 13.5, 6, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]);

		expect([...vector.at(0)]).toEqual([10.5]);
		expect(vector.get(0)).toEqual(10.5);
		expect([...vector.at(1)]).toEqual([52]);
		expect(vector.get(2)).toEqual(4.5);

		// Add ton of numbers to make sure memory isn't going out of bounds
		for(let i = 0; i < 1_000; i++) {
			vector.push(i);
		}
		for(let i = 0; i < 1_000; i++) {
			expect(vector.get(i + 7)).toEqual(i);
		}
	});

	it('can work from memory', () => {
		let mainVector = new SharedPool(memory, {
			type: Uint32Array,
			dataLength: 3
		});
		let cloneVector = new SharedPool(memory, mainVector.getSharedMemory());

		mainVector.push(10);
		mainVector.push([52, 32, 6]);
		mainVector.push([40, 41, 42]);

		expect(mainVector.length).toEqual(3);
		expect(flat(mainVector)).toEqual([
			10, 0, 0,
			52, 32, 6,
			40, 41, 42
		]);
		expect(cloneVector.length).toEqual(3);
		expect(flat(cloneVector)).toEqual([
			10, 0, 0,
			52, 32, 6,
			40, 41, 42
		]);

		// Make sure growing works
		for(let i = 0; i < 10; i++) {
			cloneVector.push(i);
		}
		for(let i = 0; i < 10; i++) {
			mainVector.push(i);
		}
		expect(mainVector.length).toEqual(23);
		expect(cloneVector.length).toEqual(23);
	});

	it('free', () => {
		let startMemory = memory.currentUsed;
		let vector = new SharedPool(memory, {
			type: Uint32Array
		});

		for(let i = 0; i < 1_000; i++) {
			vector.push(i);
		}

		vector.free();
		expect(memory.currentUsed).toEqual(startMemory);
	});

	it('clear', () => {
		let vector = new SharedPool(memory, {
			type: Uint32Array
		});

		vector.push(10);
		vector.push(52);
		vector.push(4);
		vector.push(18);
		vector.push(25);
		vector.deleteIndex(1);
		vector.deleteIndex(3);
		expect(vector.length).toEqual(3);
		expect(flat(vector)).toEqual([10, 4, 25]);

		// Clear should make it empty
		vector.clear();
		expect(vector.length).toEqual(0);
		expect(flat(vector)).toEqual([]);

		// Should be able to reuse cleared vector like normal
		vector.push(97);
		vector.push(82);
		vector.push(41);
		vector.deleteIndex(1);
		expect(vector.length).toEqual(2);
		expect(flat(vector)).toEqual([97, 41]);
	});
});

function flat(list: SharedPool<any>) {
	return [...list].reduce((array, value) => {
		array.push(...value);

		return array;
	}, []);
}