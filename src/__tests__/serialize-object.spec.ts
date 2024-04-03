import MemoryHeap from '../memory-heap';
import { serializeObjectToMemory, createObjectFromMemory } from '../serialize-object';

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
});