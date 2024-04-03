import AllocatedMemory, { type SharedAllocatedMemory } from './allocated-memory';
import type MemoryHeap from './memory-heap';
import SharedList from './shared-list';
import { loadPointer, storePointer } from './utils/pointer';

// TODO: Grow hashMemory
// TODO: Add iterator
// TODO: Add read/write locks
const DEFAULT_HASH_SIZE = 10;
export default class SharedMap<K extends string | number> {
	static readonly ALLOCATE_COUNT = 4;

	private memory: MemoryHeap;
	// Memory order: Pointer, Lock, Length, MaxHash
	private pointerMemory: AllocatedMemory;
	private lock: Int32Array;
	private get hashMemory(): AllocatedMemory {
		return new AllocatedMemory(this.memory, loadPointer(this.pointerMemory.data, 0));
	}

	get length(): number {
		return Atomics.load(this.pointerMemory.data, 2);
	}
	get maxHash(): number {
		return Atomics.load(this.pointerMemory.data, 3);
	}

	constructor(memory: MemoryHeap, clone?: SharedMapMemory) {
		this.memory = memory;

		if(clone) {
			this.pointerMemory = new AllocatedMemory(memory, clone.firstBlock);
		} else {
			this.pointerMemory = memory.allocUI32(SharedMap.ALLOCATE_COUNT);
			let hashMemory = memory.allocUI32(DEFAULT_HASH_SIZE);
			storePointer(this.pointerMemory.data, 0, hashMemory.bufferPosition, hashMemory.bufferByteOffset);
			Atomics.store(this.pointerMemory.data, 3, DEFAULT_HASH_SIZE);
		}
		this.lock = new Int32Array(this.pointerMemory.data.buffer, this.pointerMemory.bufferByteOffset + Uint32Array.BYTES_PER_ELEMENT, 1);
	}

	set(key: K, value: number) {
		if(this.length >= this.maxHash * 2) {
			this.growHashTable();
		}

		let fullHashKey = get32BitHash(key);
		if(this.setHashKey(this.hashMemory, this.maxHash, fullHashKey, value)) {
			Atomics.add(this.pointerMemory.data, 2, 1);
		}
	}
	private setHashKey(hashMemory: AllocatedMemory, maxHash: number, fullHashKey: number, value: number) {
		let hashKey = this.hash(fullHashKey, maxHash);
		
		let list: SharedList;
		let pointer = loadPointer(hashMemory.data, hashKey);
		if(pointer.bufferByteOffset === 0) {
			// Initialize a list here
			list = new SharedList(this.memory, {
				dataLength: 2
			});

			let listMemory = list.getSharedMemory();
			storePointer(hashMemory.data, hashKey, listMemory.firstBlock.bufferPosition, listMemory.firstBlock.bufferByteOffset);
		} else {
			list = new SharedList(this.memory, {
				firstBlock: pointer
			});
		}

		// Check if any other items in list have the same key and delete them
		let inserted = true;
		if(list.deleteValue(fullHashKey)) {
			inserted = false;
		}
		list.insert([fullHashKey, value]);
		
		return inserted;
	}

	get(key: K): number | undefined {
		let fullHashKey = get32BitHash(key);
		let hashKey = this.hash(fullHashKey, this.maxHash);

		let pointer = loadPointer(this.hashMemory.data, hashKey);
		if(pointer.bufferByteOffset === 0) {
			return undefined;
		}

		let list = new SharedList(this.memory, {
			firstBlock: pointer
		});

		for(let { data } of list) {
			if(data[0] === fullHashKey) {
				return data[1];
			}
		}

		return undefined;
	}
	has(key: K): boolean {
		let fullHashKey = get32BitHash(key);
		let hashKey = this.hash(fullHashKey, this.maxHash);

		let pointer = loadPointer(this.hashMemory.data, hashKey);
		if(pointer.bufferByteOffset === 0) {
			return false;
		}

		let list = new SharedList(this.memory, {
			firstBlock: pointer
		});

		for(let { data } of list) {
			if(data[0] === fullHashKey) {
				return true;
			}
		}

		return false;
	}

	delete(key: K): boolean {
		let fullHashKey = get32BitHash(key);
		let hashKey = this.hash(fullHashKey, this.maxHash);

		let pointer = loadPointer(this.hashMemory.data, hashKey);
		if(pointer.bufferByteOffset === 0) {
			return false;
		}

		let list = new SharedList(this.memory, {
			firstBlock: pointer
		});

		for(let { data, deleteCurrent } of list) {
			if(data[0] === fullHashKey) {
				deleteCurrent();

				Atomics.sub(this.pointerMemory.data, 2, 1);
				return true;
			}
		}

		return false;
	}

	private growHashTable() {
		let oldMaxHash = this.maxHash;
		let newMaxHash = oldMaxHash * 2;
		let newHashMemory = this.memory.allocUI32(newMaxHash);
		let oldHashMemory = this.hashMemory;

		// Copy each old hash value into new hash memory
		for(let i = 0; i < oldMaxHash; i++) {
			let pointer = loadPointer(oldHashMemory.data, i);
			if(pointer.bufferByteOffset === 0) {
				continue;
			}

			let list = new SharedList(this.memory, {
				firstBlock: pointer
			});
			for(let { data } of list) {
				this.setHashKey(newHashMemory, newMaxHash, data[0], data[1]);
			}
		}

		storePointer(this.pointerMemory.data, 0, newHashMemory.bufferPosition, newHashMemory.bufferByteOffset);
		Atomics.store(this.pointerMemory.data, 3, newMaxHash);
	}

	private hash(key: number, maxHash: number) {
		return key % maxHash;
	}

	free() {
		// Loop through and free lists in hash table first
		for(let i = 0; i < this.maxHash; i++) {
			let pointer = loadPointer(this.hashMemory.data, i);
			if(pointer.bufferByteOffset === 0) {
				continue;
			}

			let list = new SharedList(this.memory, {
				firstBlock: pointer
			});
			list.free();
		}

		this.hashMemory.free();
		this.pointerMemory.free();
	}

	getSharedMemory(): SharedMapMemory {
		return {
			firstBlock: this.pointerMemory.getSharedMemory()
		};
	}
}

interface SharedMapMemory {
	firstBlock: SharedAllocatedMemory
}

function get32BitHash<K extends string | number>(key: K): number {
	if(typeof key === 'number') {
		return key;
	} else if(typeof key === 'string') {
		return hashString(key as string);
	} else {
		return key;
	}
}

// Copied from https://github.com/mmomtchev/SharedMap/blob/master/index.js - MurmurHash2
function hashString(str: string): number {
	let
		l = str.length,
		h = 17 ^ l,
		i = 0,
		k;
	while(l >= 4) {
		k =
			((str.charCodeAt(i) & 0xff)) |
			((str.charCodeAt(++i) & 0xff) << 8) |
			((str.charCodeAt(++i) & 0xff) << 16) |
			((str.charCodeAt(++i) & 0xff) << 14);
		k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
		k ^= k >>> 14;
		k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
		h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16)) ^ k;
		l -= 4;
		++i;
	}
	/* eslint-disable no-fallthrough */
	switch(l) {
		case 3: h ^= (str.charCodeAt(i + 2) & 0xff) << 16;
		case 2: h ^= (str.charCodeAt(i + 1) & 0xff) << 8;
		case 1: h ^= (str.charCodeAt(i) & 0xff);
			h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
	}
	/* eslint-enable no-fallthrough */
	h ^= h >>> 13;
	h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
	h ^= h >>> 15;
	h = h >>> 0;
	return h;
}

export type { SharedMapMemory };