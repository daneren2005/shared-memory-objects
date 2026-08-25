import AllocatedMemory from './allocated-memory';
import type MemoryHeap from './memory-heap';
import type { SharedListMemory } from './shared-list';
import SharedList from './shared-list';
import { createPointer, loadPointer } from './utils/pointer';

export default abstract class SharedPointerList<T extends PointerItem> implements Iterable<T> {
	private memory: MemoryHeap;
	private list: SharedList;

	constructor(heap: MemoryHeap, memory?: SharedListMemory) {
		this.memory = heap;

		if(memory) {
			this.list = new SharedList(heap, memory);
		} else {
			this.list = new SharedList(heap);
		}
	}

	get length() {
		return this.list.length;
	}

	insert(item: T) {
		this.list.insert(createPointer(item.memory.bufferPosition, item.memory.bufferByteOffset, this.memory.positionBits));
	}
	delete(item: T) {
		let deleted = this.list.deleteValue(createPointer(item.memory.bufferPosition, item.memory.bufferByteOffset, this.memory.positionBits));
		// This wrapper is single-threaded per instance, so reclaim the tombstoned node right away
		this.list.compact();
		return deleted;
	}

	compact() {
		this.list.compact();
	}

	*[Symbol.iterator]() {
		let iterator = this.list[Symbol.iterator]();

		for(let { data: pointerData } of iterator) {
			let { bufferPosition, bufferByteOffset } = loadPointer(pointerData, 0, this.memory.positionBits);
			let allocatedMemory = new AllocatedMemory(this.memory, {
				bufferPosition,
				bufferByteOffset,
			});
			yield this.createItem(allocatedMemory);
		}
	}
	forEach(callback: (item: T) => void) {
		for(let value of this) {
			callback(value);
		}
	}

	find(callback: (item: T) => boolean): T | undefined {
		for(let value of this) {
			if(callback(value)) {
				return value;
			}
		}

		return undefined;
	}

	getSharedMemory() {
		return this.list.getSharedMemory();
	}

	protected abstract createItem(allocatedMemory: AllocatedMemory): T;

	free() {
		for(let item of this) {
			// NOTE: Anything that allocates it's own memory (ie: type for Item) needs to call free for that class so we can clear all memory recursively
			if('free' in item && typeof item.free === 'function') {
				item.free();
			} else {
				item.memory.free();
			}
		}

		this.list.free();
	}
}

interface PointerItem {
	readonly memory: AllocatedMemory
}