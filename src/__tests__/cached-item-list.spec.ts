import CachedItemList from '../cached-item-list';
import { getPointer } from '../main';
import MemoryHeap from '../memory-heap';
import SharedString from '../shared-string';

describe('CachedItemList', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap();
	});

	it('init', () => {
		let list = new StringList(memory);

		let string = new SharedString(memory, 'Test');
		list.insert(string);

		expect(list.length).toEqual(1);
		expect(list._cache.size).toEqual(1);
		expect(list.getByPointer(string.pointer)).toBe(string);
		expect([...list].map(i => i.item)).toEqual([string]);
	});

	it('cache works per thread', () => {
		let list = new StringList(memory);
		let cloneList = new StringList(memory, list.getSharedMemory());

		let string = new SharedString(memory, 'Test');
		list.insert(string);

		expect(list.length).toEqual(1);
		expect(list._cache.size).toEqual(1);
		expect(cloneList.length).toEqual(1);
		expect(cloneList._cache.size).toEqual(0);
		
		expect(list.getByPointer(string.pointer)).toBe(string);
		let cloneString = cloneList.getByPointer(string.pointer);
		expect(cloneString).not.toBe(string);
		expect(cloneString?.value).toEqual('Test');
		// Repeat calls should return the same instance
		expect(cloneList.getByPointer(string.pointer)).toBe(cloneString);
		expect(cloneList._cache.size).toEqual(1);

		// Double check that it is linked to the same memory object
		string.value = 'Blue';
		expect(cloneString?.value).toEqual('Blue');
	});

	it('deleting clears all memory', () => {
		let list = new StringList(memory);
		let startMemory = memory.currentUsed;

		let string = new SharedString(memory, 'Test');
		list.insert(string);
		list.delete(string);

		expect(list.length).toEqual(0);
		expect(list._cache.size).toEqual(0);
		expect(memory.currentUsed).toEqual(startMemory);

		list.insert(new SharedString(memory, 'Test'));
		list.clear();
		expect(list.length).toEqual(0);
		expect(list._cache.size).toEqual(0);
	});

	it('free clears all memory', () => {
		let startMemory = memory.currentUsed;
		let list = new StringList(memory);
		list.insert(new SharedString(memory, 'Test'));
		list.insert(new SharedString(memory, 'Test'));

		list.free();
		expect(memory.currentUsed).toEqual(startMemory);
	});
});

class StringList extends CachedItemList<SharedString> {
	initItem(pointer: number) {
		return new SharedString(this.heap, getPointer(pointer));
	}

	get _cache() {
		return this.cache;
	}
}