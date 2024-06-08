import type { SharedAllocatedMemory } from './allocated-memory';
import type MemoryHeap from './memory-heap';
import SharedList, { type SharedListMemory } from './shared-list';

export default abstract class CachedItemList<T extends Item> implements Iterable<{ item: T, deleteCurrent: () => void }> {
	static readonly ALLOCATE_COUNT = SharedList.ALLOCATE_COUNT;

	protected heap: MemoryHeap;
	protected list: SharedList;
	protected cache: Map<number, T> = new Map();

	constructor(heap: MemoryHeap, config?: CachedListConfig | SharedListMemory) {
		if(config) {
			this.list = new SharedList(heap, config);
		} else {
			this.list = new SharedList(heap);
		}
		this.heap = heap;

		this.list.onDelete = (pointerData: Uint32Array) => {
			let pointer = Atomics.load(pointerData, 0);
			if(pointer) {
				let item = this.cache.get(pointer);
				if(!item) {
					item = this.initItem(pointer);
				}

				if(item) {
					item.free();
					this.cache.delete(pointer);
				}
			}
		};
	}

	get length() {
		return this.list.length;
	}

	clear() {
		this.list.clear();
		this.cache.clear();
	}

	insert(item: T) {
		this.list.insert(item.pointer);
		this.cache.set(item.pointer, item);
	}
	delete(item: T) {
		this.cache.delete(item.pointer);
		return this.list.deleteValue(item.pointer);
	}

	getByPointer(pointer: number): T | undefined {
		let item = this.cache.get(pointer);
		if(!item) {
			item = this.initItem(pointer);
			if(item) {
				this.cache.set(pointer, item);
			}
		}

		return item;
	}
	protected abstract initItem(pointer: number): T | undefined

	*[Symbol.iterator]() {
		let iterator = this.list[Symbol.iterator]();

		for(let { data: pointerData, deleteCurrent } of iterator) {
			let pointer = Atomics.load(pointerData, 0);
			if(!pointer) {
				continue;
			}

			let item = this.cache.get(pointer);
			if(!item) {
				item = this.initItem(pointer);
				if(item) {
					this.cache.set(pointer, item);
				}
			}

			if(item) {
				yield {
					item,
					deleteCurrent
				};
			}
		}
	}
	forEach(callback: (item: T) => void, filter?: (item: T) => boolean) {
		for(let { item } of this) {
			if(!filter || filter(item)) {
				callback(item);
			}
		}
	}

	find(callback: (item: T) => boolean): T | undefined {
		for(let { item } of this) {
			if(callback(item)) {
				return item;
			}
		}
	}
	filter(callback: (entity: T) => boolean): Array<T> {
		let items = [];
		for(let { item } of this) {
			if(callback(item)) {
				items.push(item);
			}
		}

		return items;
	}
	map<X>(callback: (item: T) => X): Array<X> {
		const array: Array<X> = [];
		for(let { item } of this) {
			array.push(callback(item));
		}

		return array;
	}

	getSharedMemory() {
		return this.list.getSharedMemory();
	}

	free() {
		this.list.free();
		this.cache.clear();
	}
}

export interface CachedListConfig {
	initWithBlock: SharedAllocatedMemory
}

interface Item {
	pointer: number
	free: () => void
}