import MemoryHeap from '../memory-heap';
import { serializeObjectToMemory, createObjectFromMemory, createObjectFromPointer } from '../serialize-object';

describe('SerializeObject', () => {
	let heap: MemoryHeap;
	beforeEach(() => {
		heap = new MemoryHeap();
	});

	it('simple', () => {
		const object = {
			test: 12.5,
			test2: 'string',
			fa: 'blue'
		};
		let memory = serializeObjectToMemory(heap, object);

		let clone = createObjectFromMemory<typeof object>(memory);
		expect(clone.test).toEqual(12.5);
		expect(clone.test2).toEqual('string');
		expect(clone.fa).toEqual('blue');
	});

	it('can round trip through a pointer', () => {
		const object = {
			a: 1,
			b: 'two',
			c: 3.25
		};
		let memory = serializeObjectToMemory(heap, object);

		let clone = createObjectFromPointer<typeof object>(heap, memory.pointer);
		expect(clone.a).toEqual(1);
		expect(clone.b).toEqual('two');
		expect(clone.c).toEqual(3.25);
	});

	it('handles negative and zero numbers', () => {
		const object = {
			neg: -42.5,
			zero: 0,
			pos: 17
		};
		let memory = serializeObjectToMemory(heap, object);

		let clone = createObjectFromMemory<typeof object>(memory);
		expect(clone.neg).toEqual(-42.5);
		expect(clone.zero).toEqual(0);
		expect(clone.pos).toEqual(17);
	});

	it('handles empty string values', () => {
		const object = {
			empty: '',
			filled: 'value'
		};
		let memory = serializeObjectToMemory(heap, object);

		let clone = createObjectFromMemory<typeof object>(memory);
		expect(clone.empty).toEqual('');
		expect(clone.filled).toEqual('value');
	});

	it('throws when reading from an invalid memory location', () => {
		let memory = heap.allocUI32(8);
		expect(() => createObjectFromMemory(memory)).toThrowError('Trying to create object from invalid memory location');
	});
});