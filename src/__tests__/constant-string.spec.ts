import MemoryHeap from '../memory-heap';
import ConstantString from '../constant-string';
import { getPointer } from '../utils/pointer';

describe('ConstantString', () => {
	it('can create', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 16 });
		let string = new ConstantString(memory, 'Test');

		expect(string.value).toEqual('Test');
	});

	it('utf16 characters work', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 16 });
		let string = new ConstantString(memory, 'Teǭst');

		expect(string.value).toEqual('Teǭst');
	});

	it('can set to empty string', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 16 });
		let string = new ConstantString(memory, '');

		expect(string.value).toEqual('');
	});

	it('another view over the same memory reads the same value without re-allocating', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 16 });
		let string = new ConstantString(memory, 'Space Ship');
		let usedAfterCreate = memory.currentUsed;

		let copy = new ConstantString(memory, string.getSharedMemory());
		expect(copy.value).toEqual('Space Ship');
		// A second view allocates nothing - it just reads the existing header/char memory.
		expect(memory.currentUsed).toEqual(usedAfterCreate);
	});

	it('can be resolved from just its pointer', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 16 });
		let string = new ConstantString(memory, 'Miner');

		// getPointer(pointer) is what a worker does with the value stored in a component block.
		let { bufferPosition, bufferByteOffset } = getPointer(string.pointer);
		let resolved = new ConstantString(memory, { bufferPosition, bufferByteOffset });
		expect(resolved.value).toEqual('Miner');
	});

	it('handles large ascii strings without blowing the stack', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 1024 });
		let big = 'a'.repeat(200_000);
		let string = new ConstantString(memory, big);

		expect(string.value.length).toEqual(200_000);
		expect(string.value).toEqual(big);
	});

	it('handles large utf16 strings without blowing the stack', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 1024 });
		let big = 'ǭ'.repeat(100_000);
		let string = new ConstantString(memory, big);

		expect(string.value.length).toEqual(100_000);
		expect(string.value).toEqual(big);
	});

	it('free releases both the header and the character memory', () => {
		let memory = new MemoryHeap({ bufferSize: 1024 * 16 });
		let startMemory = memory.currentUsed;
		let string = new ConstantString(memory, 'Tests');
		string.free();

		expect(memory.currentUsed).toEqual(startMemory);
	});
});