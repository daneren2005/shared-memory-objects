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

	it('float64 stores full-precision numbers across segments', () => {
		let stack = new SharedStack(memory, {
			type: Float64Array,
		});

		stack.push(10.5);
		stack.push(Number.MAX_SAFE_INTEGER);
		// Push enough to grow past the base segment and exercise the 64-bit segment stride
		for(let i = 0; i < 50; i++) {
			stack.push(i + 0.5);
		}

		expect(stack.at(0)).toEqual(10.5);
		expect(stack.at(1)).toEqual(Number.MAX_SAFE_INTEGER);
		expect(stack.at(10)).toEqual(8.5);
		expect(stack.length).toEqual(52);
	});
	it('int64 stores bigint values across segments', () => {
		let stack = new SharedStack(memory, {
			type: BigInt64Array,
		});

		stack.push(-10n);
		stack.push(9223372036854775807n);
		for(let i = 0n; i < 50n; i++) {
			stack.push(i);
		}

		expect(stack.at(0)).toEqual(-10n);
		expect(stack.at(1)).toEqual(9223372036854775807n);
		expect(stack.at(10)).toEqual(8n);
		expect(stack.pop()).toEqual(49n);
	});
	it('uint64 stores large unsigned bigint values', () => {
		let stack = new SharedStack(memory, {
			type: BigUint64Array,
		});

		stack.push(18446744073709551615n);
		stack.push(5n);

		expect(stack.length).toEqual(2);
		expect(flat(stack)).toEqual([18446744073709551615n, 5n]);
		expect(stack.pop()).toEqual(5n);
		expect(stack.pop()).toEqual(18446744073709551615n);
	});

	it('initializes with firstBlock', () => {
		const hostBlock = memory.allocUI32(SharedStack.DEFAULT_ALLOCATE_COUNT * 2);
		const stack = new SharedStack(memory, {
			type: Float32Array,
			firstBlock: {
				bufferPosition: hostBlock.bufferPosition,
				bufferByteOffset: hostBlock.bufferByteOffset + SharedStack.DEFAULT_ALLOCATE_COUNT * Uint32Array.BYTES_PER_ELEMENT,
				length: SharedStack.DEFAULT_ALLOCATE_COUNT,
			},
		});

		expect(stack.push(99)).toEqual(0);
		expect(stack.push(42)).toEqual(1);
		expect(flat(stack)).toEqual([99, 42]);
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
	it('free from memory', () => {
		let startMemory = memory.currentUsed;
		let stack = new SharedStack(memory, {
			type: Uint32Array,
		});

		for(let i = 0; i < 1_000; i++) {
			stack.push(i);
		}

		let cloneStack = new SharedStack(memory, stack.getSharedMemory());
		cloneStack.free();
		expect(memory.currentUsed).toEqual(startMemory);
	});

	it('errors start occuring when we hit max length', () => {
		let stack = new SharedStack(memory, {
			baseSegmentLength: 4,
			maxLength: 28,
		});
		expect(stack.maxLength).toEqual(28);

		for(let i = 0; i < 28; i++) {
			stack.push(i);
		}

		expect(() => stack.push(30)).toThrowError('29 is out of bounds 28');
	});

	it('maxSize is derived from baseSegments and maxLength', () => {
		let stack = new SharedStack(memory, {
			baseSegmentLength: 4,
			maxLength: 28,
		});
		expect(stack.maxLength).toEqual(28);

		let defaults = new SharedStack(memory);
		expect(defaults.baseSegmentLength).toEqual(4);
		// The default is a 20-segment budget: segments double until they reach the largest a buffer holds, then stay flat,
		// so maxLength is the honest capacity of those 20 segments rather than the old unreachable power-of-two ceiling
		expect(defaults.maxSegments).toEqual(20);
		expect(defaults.maxSegmentLength).toEqual(SharedStack.getMaxSegmentLength(memory.maxAllocationLength));
		expect(defaults.maxLength).toEqual(SharedStack.getCapacity(20, 4, defaults.maxSegmentLength));
	});

	it('caps segment growth at maxSegmentLength instead of doubling forever', () => {
		// 4, 8, 16, 16, 16 - once capped at 16 the segments stay flat so no single segment outgrows a buffer
		let stack = new SharedStack(memory, {
			baseSegmentLength: 4,
			maxSegmentLength: 16,
			maxLength: 60,
		});
		expect(stack.maxSegmentLength).toEqual(16);
		expect(stack.maxSegments).toEqual(5);
		expect(stack.maxLength).toEqual(60);

		let expectedValues = [];
		for(let i = 0; i < 60; i++) {
			stack.push(i);
			expectedValues.push(i);
		}
		expect(flat(stack)).toEqual(expectedValues);
		expect(stack.at(3)).toEqual(3); // last slot of the base segment
		expect(stack.at(4)).toEqual(4); // first slot of segment 1
		expect(stack.at(28)).toEqual(28); // first slot of the first capped segment
		expect(stack.at(59)).toEqual(59);
		expect(() => stack.push(60)).toThrowError('61 is out of bounds 60');
	});

	it('floors a requested maxSegmentLength to a power-of-two multiple of the base', () => {
		let stack = new SharedStack(memory, {
			baseSegmentLength: 4,
			maxSegmentLength: 20, // floored down to 16
		});
		expect(stack.maxSegmentLength).toEqual(16);
	});

	it('a larger buffer size covers the same maxLength with fewer segments', () => {
		let target = 1_000_000;
		let smallBufferHeap = new MemoryHeap({ bufferSize: 1024 * 1024 });
		let largeBufferHeap = new MemoryHeap({ bufferSize: 8 * 1024 * 1024 });

		let smallBufferStack = new SharedStack(smallBufferHeap, { maxLength: target });
		let largeBufferStack = new SharedStack(largeBufferHeap, { maxLength: target });

		// 8MB segments cap at 8x the length of 1MB segments, so half as many segments cover the same target
		expect(smallBufferStack.maxSegmentLength).toEqual(65_536);
		expect(largeBufferStack.maxSegmentLength).toEqual(524_288);
		expect(smallBufferStack.maxSegments).toEqual(29);
		expect(largeBufferStack.maxSegments).toEqual(18);
		expect(largeBufferStack.maxSegments).toBeLessThan(smallBufferStack.maxSegments);

		// Both still address the full target
		expect(smallBufferStack.maxLength).toBeGreaterThanOrEqual(target);
		expect(largeBufferStack.maxLength).toBeGreaterThanOrEqual(target);
	});
});

function flat(list: SharedStack<any>) {
	return [...list].reduce((array, value) => {
		array.push(value);

		return array;
	}, [] as number[]);
}