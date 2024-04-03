import MemoryHeap from '../memory-heap';
import SharedString from '../shared-string';

describe('SharedString', () => {
	it('can create', () => {
		let memory = new MemoryHeap();
		let string = new SharedString(memory, 'Test');

		expect(string.value).toEqual('Test');
	});

	it('utf16 characters work', () => {
		let memory = new MemoryHeap();
		let string = new SharedString(memory, 'Teǭst');

		expect(string.value).toEqual('Teǭst');	
	});

	it('can initialize from memory without the string allocated yet', () => {
		let memory = new MemoryHeap();
		let allocatedMemory = memory.allocUI32(SharedString.ALLOCATE_COUNT);
		let string = new SharedString(memory, {
			...allocatedMemory.getSharedMemory(),
			value: 'Test'
		});

		expect(string.value).toEqual('Test');
	});
	it('can work from uninitialized memory', () => {
		let memory = new MemoryHeap();
		let allocatedMemory = memory.allocUI32(SharedString.ALLOCATE_COUNT);
		let string = new SharedString(memory, allocatedMemory.getSharedMemory());

		expect(string.value).toEqual('');
	});

	it('can be set to new memory strings', () => {
		let memory = new MemoryHeap();
		let string = new SharedString(memory, 'Tests again22222222222222222222');
		let startMemory = memory.currentUsed;
		let copy = new SharedString(memory, string.getSharedMemory());

		expect(copy.value).toEqual('Tests again22222222222222222222');
		
		copy.value = 'Blows again22222222222222222222';
		expect(string.value).toEqual('Blows again22222222222222222222');
		expect(memory.currentUsed).toEqual(startMemory);

		string.value = 'Yo';
		expect(string.value).toEqual('Yo');
		expect(copy.value).toEqual('Yo');
		expect(memory.currentUsed).toBeLessThan(startMemory);

		string.value = 'Yo Mama Is So Fat2222222222222222222222222222222222222222';
		expect(memory.currentUsed).toBeGreaterThan(startMemory);
	});

	it('can set to empty string', () => {
		let memory = new MemoryHeap();
		let string = new SharedString(memory, '');

		expect(string.value).toEqual('');
	});

	it('free', () => {
		let memory = new MemoryHeap();
		let startMemory = memory.currentUsed;
		let string = new SharedString(memory, 'Tests');
		// No memory leak from changing values
		string.value = 'Blob';
		string.free();

		expect(memory.currentUsed).toEqual(startMemory);
	});
});