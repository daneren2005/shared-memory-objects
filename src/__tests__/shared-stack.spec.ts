import MemoryHeap from '../memory-heap';
import SharedStack from '../shared-stack';

describe('SharedStack', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap({
			bufferSize: 1024 * 16,
		});
	});

	it('insert into stack', () => {
		let stack = new SharedStack(memory, {
			type: Uint32Array,
		});

		expect(stack.push(10)).toEqual(0);
		expect(stack.push(52)).toEqual(1);
		expect(stack.push(4)).toEqual(2);
		stack.push(18);
		stack.push(25);

		expect(stack.length).toEqual(5);
		expect(flat(stack)).toEqual([10, 52, 4, 18, 25]);

		expect(stack.at(0)).toEqual(10);
		expect(stack.at(1)).toEqual(52);
		expect(stack.at(4)).toEqual(25);
	});

	it('continually grows memory as needed', () => {
		let stack = new SharedStack(memory, {
			type: Uint32Array,
		});

		const expectedValues = [];
		for(let i = 0; i < 1_000; i++) {
			stack.push(i);
			expectedValues.push(i);
		}

		expect(stack.length).toEqual(1_000);
		expect(flat(stack)).toEqual(expectedValues);
		expect(stack.at(52)).toEqual(expectedValues[52]);
		expect(stack.at(109)).toEqual(expectedValues[109]);
		expect(stack.at(543)).toEqual(expectedValues[543]);
	});

	it('pop', () => {
		let stack = new SharedStack(memory);

		stack.push(10);
		stack.push(52);
		stack.push(4);
		stack.push(8);

		expect(stack.pop()).toEqual(8);
		expect(stack.length).toEqual(3);
		expect(stack.pop()).toEqual(4);
		expect(stack.length).toEqual(2);
		expect(flat(stack)).toEqual([10, 52]);
	});

	it('float32', () => {
		let stack = new SharedStack(memory, {
			type: Float32Array,
		});

		stack.push(10.5);
		stack.push(52);
		stack.push(4.5);
		stack.push(13.5);
		stack.push(6);

		expect(stack.length).toEqual(5);
		expect(flat(stack)).toEqual([10.5, 52, 4.5, 13.5, 6]);

		expect(stack.at(0)).toEqual(10.5);
		expect(stack.at(2)).toEqual(4.5);
	});

	it('can work from memory', () => {
		let mainVector = new SharedStack(memory, {
			type: Uint32Array,
		});
		let cloneVector = new SharedStack(memory, mainVector.getSharedMemory());

		mainVector.push(10);
		mainVector.push(52);
		mainVector.push(40);

		expect(mainVector.length).toEqual(3);
		expect(flat(mainVector)).toEqual([
			10,
			52,
			40,
		]);
		expect(cloneVector.length).toEqual(3);
		expect(flat(cloneVector)).toEqual([
			10,
			52,
			40,
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

	it('int32 stores negative numbers', () => {
		let stack = new SharedStack(memory, {
			type: Int32Array,
		});

		stack.push(-10);
		stack.push(52);
		stack.push(-4);

		expect(stack.length).toEqual(3);
		expect(flat(stack)).toEqual([-10, 52, -4]);
		expect(stack.at(0)).toEqual(-10);
		expect(stack.at(2)).toEqual(-4);
	});

	it('clear resets length and allows reuse', () => {
		let stack = new SharedStack(memory);

		stack.push(10);
		stack.push(52);
		stack.push(4);
		expect(stack.length).toEqual(3);

		stack.clear();
		expect(stack.length).toEqual(0);
		expect(flat(stack)).toEqual([]);

		stack.push(99);
		expect(stack.length).toEqual(1);
		expect(flat(stack)).toEqual([99]);
	});

	it('throws when accessing out of bounds', () => {
		let stack = new SharedStack(memory);
		stack.push(10);

		expect(() => stack.at(1)).toThrowError('1 is out of bounds 1');
	});

	it('free', () => {
		let startMemory = memory.currentUsed;
		let stack = new SharedStack(memory, {
			type: Uint32Array,
		});

		for(let i = 0; i < 1_000; i++) {
			stack.push(i);
		}

		stack.free();
		expect(memory.currentUsed).toEqual(startMemory);
	});

	it('errors start occuring when we hit max length', () => {
		let stack = new SharedStack(memory, {
			baseSegmentLength: 4,
			segmentCount: 3,
		});
		expect(stack.maxLength).toEqual(28);

		for(let i = 0; i < 28; i++) {
			stack.push(i);
		}

		expect(() => stack.push(30)).toThrowError('29 is out of bounds 28');
	});

	it('maxSize is derived from baseSegments and maxSegments', () => {
		let stack = new SharedStack(memory, {
			baseSegmentLength: 4,
			segmentCount: 3,
		});
		expect(stack.maxLength).toEqual(28);

		let defaults = new SharedStack(memory);
		expect(defaults.baseSegmentLength).toEqual(4);
		expect(defaults.maxSegments).toEqual(20);
		expect(defaults.maxLength).toEqual(4_194_300);
	});
});

function flat(list: SharedStack<any>) {
	return [...list].reduce((array, value) => {
		array.push(value);

		return array;
	}, [] as number[]);
}