import MemoryHeap from '../memory-heap';
import SharedVector from '../shared-vector';

describe('SharedVector', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap({
			bufferSize: 1024 * 16
		});
	});

	it('insert into vector', () => {
		let vector = new SharedVector(memory, {
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
	});

	it('continually grows memory as needed', () => {
		let vector = new SharedVector(memory, {
			type: Uint32Array
		});

		const expectedValues = [];
		for(let i = 0; i < 1_000; i++) {
			vector.push(i);
			expectedValues.push(i);
		}

		expect(vector.length).toEqual(1_000);
		expect(flat(vector)).toEqual(expectedValues);
	});

	it('pop', () => {
		let vector = new SharedVector(memory);

		vector.push(10);
		vector.push(52);
		vector.push(4);
		vector.push(8);

		expect([...vector.pop()]).toEqual([8]);
		expect(vector.length).toEqual(3);
		expect([...vector.pop()]).toEqual([4]);
		expect(vector.length).toEqual(2);
		expect(flat(vector)).toEqual([10, 52]);
	});

	it('deleteIndex', () => {
		let vector = new SharedVector(memory);

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
		
		vector.deleteIndex(0);
		expect(vector.length).toEqual(1);
		expect(flat(vector)).toEqual([4]);
	});

	it('with dataLength: 3', () => {
		let vector = new SharedVector(memory, {
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

		expect([...vector.pop()]).toEqual([40, 41, 42]);
		expect(vector.length).toEqual(2);
		expect(flat(vector)).toEqual([
			10, 0, 0,
			52, 32, 6
		]);
		expect([...vector.at(0)]).toEqual([10, 0, 0]);
		expect([...vector.at(1)]).toEqual([52, 32, 6]);

		vector.deleteIndex(0);
		expect(vector.length).toEqual(1);
		expect(flat(vector)).toEqual([
			52, 32, 6
		]);
		expect([...vector.at(0)]).toEqual([52, 32, 6]);
		expect(vector.get(0)).toEqual(52);
		expect(vector.get(0, 2)).toEqual(6);
	});

	it('float32', () => {
		let vector = new SharedVector(memory, {
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

	it('can work from memory', () => {
		let mainVector = new SharedVector(memory, {
			type: Uint32Array,
			dataLength: 3
		});
		let cloneVector = new SharedVector(memory, mainVector.getSharedMemory());

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
		let vector = new SharedVector(memory, {
			type: Uint32Array
		});

		for(let i = 0; i < 1_000; i++) {
			vector.push(i);
		}

		vector.free();
		expect(memory.currentUsed).toEqual(startMemory);
	});
});

function flat(list: SharedVector<any>) {
	return [...list].reduce((array, value) => {
		array.push(...value);

		return array;
	}, []);
}