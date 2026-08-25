import AllocatedMemory, { type SharedAllocatedMemory } from './allocated-memory';
import type MemoryHeap from './memory-heap';
import { getPointer, storeRawPointer } from './utils/pointer';
import { get32BitHash, mix32 } from './utils/hash';
import { lock, unlock, SIMPLE_LOCK_ALLOCATE_COUNT } from './lock/simple-lock';
import { getArrayTypeCode, getByteMultipler, makeArrayView, type NumericArray, type NumericArrayIO, type TypedArrayConstructor } from './utils/array-type';

// Open-addressing hash map with linear probing, held in one contiguous table (no per-bucket lists, no per-operation
// allocation). A single exclusive lock guards the table so slot reads/writes inside the critical section can be plain
// memory access instead of per-slot Atomics; the lock's acquire/release provides the cross-thread happens-before.
//
// The table uses a Structure-of-Arrays layout: three contiguous regions - states | keys | values - so probing touches
// the dense states and keys regions (more candidates per cache line) and iteration walks values densely. capacity is
// always a power of two, so slot = mix(key) & (capacity - 1). state distinguishes EMPTY/FULL/TOMBSTONE, so key 0 and
// value 0 need no sentinel.
//
// Keys are always stored as the 32-bit hash (a numeric key is its own hash); values are stored in the typed array the
// map was created with (Uint32Array by default, or Int32Array / Float32Array). Iteration is a best-effort scan that is
// not lock-guarded, so it must not run concurrently with mutation from another thread. A single allocation can't span
// buffers, so the table is bounded by MemoryHeap.maxAllocationLength.

const EMPTY = 0;
const FULL = 1;
const TOMBSTONE = 2;

const DEFAULT_CAPACITY = 16;
// Grow when (occupied + tombstones) / capacity exceeds this. Kept as a fraction to avoid floating point in the hot path.
const LOAD_NUMERATOR = 3;
const LOAD_DENOMINATOR = 4;

// Metadata block layout (pointerMemory)
const TABLE_POINTER_INDEX = 0;
const LOCK_INDEX = 1;
const LENGTH_INDEX = 2;
const TOMBSTONE_INDEX = 3;
const CAPACITY_INDEX = 4;
const TYPE_INDEX = 5;

export default class SharedMap<K extends string | number, V extends NumericArray = Uint32Array> {
	static readonly ALLOCATE_COUNT = 6;

	private memory: MemoryHeap;
	private pointerMemory: AllocatedMemory;
	private lock: Int32Array;
	// Value type is written once at creation and never changes, so resolve it once instead of reading metadata per op
	private cachedType: number;
	// u32 units per value slot: 1 for 32-bit types, 2 for 64-bit (float64/int64/uint64). The values region and every
	// table allocation scale by this.
	private cachedValueUnits = 1;

	// Cache the resolved views so most operations avoid rebuilding them. Rebuild whenever the table pointer OR the capacity
	// changes: the pointer alone is not enough because the allocator recycles freed addresses (split:false), so a rehash can
	// land a differently-sized table at the same address (ABA). The cached views are plain windows into shared memory, so
	// they always reflect the current bytes at that address; only the derived capacity (mask/offsets) can go stale, and the
	// capacity check catches exactly that.
	private cachedTablePointer = 0;
	private cachedTableMemory?: AllocatedMemory;
	private cachedSlots?: Uint32Array; // whole block as u32: states region, then keys region
	private cachedValues?: V; // typed view over the values region
	private cachedCapacity = 0;
	// Callers hold the lock, so the acquire fence already published the latest pointer/capacity - plain reads are enough
	// and avoid two Atomics.load per operation on the hot path.
	private ensureTable() {
		let data = this.pointerMemory.data;
		let pointer = data[TABLE_POINTER_INDEX];
		let capacity = data[CAPACITY_INDEX];
		if(pointer === this.cachedTablePointer && capacity === this.cachedCapacity && this.cachedSlots) {
			return;
		}

		let table = new AllocatedMemory(this.memory, getPointer(pointer, this.memory.positionBits));
		this.cachedTableMemory = table;
		this.cachedSlots = table.data;
		this.cachedValues = this.makeValuesView(table, capacity);
		this.cachedCapacity = capacity;
		this.cachedTablePointer = pointer;
	}
	private makeValuesView(table: AllocatedMemory, capacity: number): V {
		// states and keys each take one u32 per slot, so the values region starts after 2 * capacity u32s
		let byteOffset = table.bufferByteOffset + capacity * 2 * Uint32Array.BYTES_PER_ELEMENT;
		return makeArrayView(this.cachedType, table.data.buffer, byteOffset, capacity) as V;
	}
	// u32s a table of this capacity needs: states + keys (one each per slot) plus the values region, which is
	// cachedValueUnits u32s per slot.
	private tableLength(capacity: number): number {
		return capacity * (2 + this.cachedValueUnits);
	}

	get length(): number {
		return Atomics.load(this.pointerMemory.data, LENGTH_INDEX);
	}
	get capacity(): number {
		return Atomics.load(this.pointerMemory.data, CAPACITY_INDEX);
	}
	get maxHash(): number {
		return this.capacity;
	}
	get type(): number {
		return this.cachedType;
	}
	// Metadata block plus the single table allocation the map currently points at.
	get usedMemory(): number {
		lock(this.lock);
		try {
			this.ensureTable();
			return this.pointerMemory.usedMemory + this.cachedTableMemory!.usedMemory;
		} finally {
			unlock(this.lock);
		}
	}

	constructor(memory: MemoryHeap, config?: SharedMapConfig<V> | SharedMapMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.pointerMemory = new AllocatedMemory(memory, config.firstBlock);
		} else {
			this.pointerMemory = memory.allocUI32(SharedMap.ALLOCATE_COUNT);
			let typeCode = getArrayTypeCode(config?.type ?? Uint32Array);
			this.cachedValueUnits = getByteMultipler(typeCode);
			let table = memory.allocUI32(DEFAULT_CAPACITY * (2 + this.cachedValueUnits));
			storeRawPointer(this.pointerMemory.data, TABLE_POINTER_INDEX, table.pointer);
			Atomics.store(this.pointerMemory.data, CAPACITY_INDEX, DEFAULT_CAPACITY);
			Atomics.store(this.pointerMemory.data, TYPE_INDEX, typeCode);
		}
		this.lock = new Int32Array(this.pointerMemory.data.buffer, this.pointerMemory.bufferByteOffset + LOCK_INDEX * Uint32Array.BYTES_PER_ELEMENT, SIMPLE_LOCK_ALLOCATE_COUNT);
		this.cachedType = Atomics.load(this.pointerMemory.data, TYPE_INDEX);
		this.cachedValueUnits = getByteMultipler(this.cachedType);
	}

	set(key: K, value: V[number]) {
		let fullHashKey = get32BitHash(key);

		lock(this.lock);
		try {
			let data = this.pointerMemory.data;
			let length = data[LENGTH_INDEX];
			let tombstones = data[TOMBSTONE_INDEX];
			if((length + tombstones + 1) * LOAD_DENOMINATOR > data[CAPACITY_INDEX] * LOAD_NUMERATOR) {
				this.resize();
			}

			this.ensureTable();
			let slots = this.cachedSlots!;
			let values = this.cachedValues! as NumericArrayIO;
			let capacity = this.cachedCapacity;
			let mask = capacity - 1;
			let keysBase = capacity;
			let idx = mix32(fullHashKey) & mask;
			let firstTomb = -1;
			// eslint-disable-next-line no-constant-condition
			while(true) {
				let state = slots[idx];
				if(state === EMPTY) {
					let target = firstTomb >= 0 ? firstTomb : idx;
					slots[target] = FULL;
					slots[keysBase + target] = fullHashKey;
					values[target] = value;
					data[LENGTH_INDEX]++;
					// Reusing a tombstone slot reclaims it
					if(firstTomb >= 0) {
						data[TOMBSTONE_INDEX]--;
					}
					return;
				} else if(state === TOMBSTONE) {
					if(firstTomb < 0) {
						firstTomb = idx;
					}
				} else if(slots[keysBase + idx] === fullHashKey) {
					values[idx] = value;
					return;
				}

				idx = (idx + 1) & mask;
			}
		} finally {
			unlock(this.lock);
		}
	}

	// Atomic read-modify-write under the table lock: resolves the current value (undefined if the key is
	// absent), calls updater, and stores the result - so two threads mutating the same key never lose an
	// update the way a separate get() + set() can. updater runs inside the lock and must be synchronous and
	// must not touch this same map (the lock is not reentrant).
	update(key: K, updater: (current: V[number] | undefined) => V[number]): V[number] {
		let fullHashKey = get32BitHash(key);

		lock(this.lock);
		try {
			let data = this.pointerMemory.data;
			let length = data[LENGTH_INDEX];
			let tombstones = data[TOMBSTONE_INDEX];
			if((length + tombstones + 1) * LOAD_DENOMINATOR > data[CAPACITY_INDEX] * LOAD_NUMERATOR) {
				this.resize();
			}

			this.ensureTable();
			let slots = this.cachedSlots!;
			let values = this.cachedValues! as NumericArrayIO;
			let capacity = this.cachedCapacity;
			let mask = capacity - 1;
			let keysBase = capacity;
			let idx = mix32(fullHashKey) & mask;
			let firstTomb = -1;
			// eslint-disable-next-line no-constant-condition
			while(true) {
				let state = slots[idx];
				if(state === EMPTY) {
					let newValue = updater(undefined);
					let target = firstTomb >= 0 ? firstTomb : idx;
					slots[target] = FULL;
					slots[keysBase + target] = fullHashKey;
					values[target] = newValue;
					data[LENGTH_INDEX]++;
					if(firstTomb >= 0) {
						data[TOMBSTONE_INDEX]--;
					}
					return newValue;
				} else if(state === TOMBSTONE) {
					if(firstTomb < 0) {
						firstTomb = idx;
					}
				} else if(slots[keysBase + idx] === fullHashKey) {
					let newValue = updater(values[idx]);
					values[idx] = newValue;
					return newValue;
				}

				idx = (idx + 1) & mask;
			}
		} finally {
			unlock(this.lock);
		}
	}

	get(key: K): V[number] | undefined {
		let fullHashKey = get32BitHash(key);

		lock(this.lock);
		try {
			this.ensureTable();
			let slots = this.cachedSlots!;
			let values = this.cachedValues! as NumericArrayIO;
			let capacity = this.cachedCapacity;
			let mask = capacity - 1;
			let keysBase = capacity;
			let idx = mix32(fullHashKey) & mask;
			// eslint-disable-next-line no-constant-condition
			while(true) {
				let state = slots[idx];
				if(state === EMPTY) {
					return undefined;
				}
				if(state === FULL && slots[keysBase + idx] === fullHashKey) {
					return values[idx];
				}
				idx = (idx + 1) & mask;
			}
		} finally {
			unlock(this.lock);
		}
	}
	has(key: K): boolean {
		return this.get(key) !== undefined;
	}

	delete(key: K): boolean {
		let fullHashKey = get32BitHash(key);

		lock(this.lock);
		try {
			this.ensureTable();
			let data = this.pointerMemory.data;
			let slots = this.cachedSlots!;
			let capacity = this.cachedCapacity;
			let mask = capacity - 1;
			let keysBase = capacity;
			let idx = mix32(fullHashKey) & mask;
			// eslint-disable-next-line no-constant-condition
			while(true) {
				let state = slots[idx];
				if(state === EMPTY) {
					return false;
				}
				if(state === FULL && slots[keysBase + idx] === fullHashKey) {
					slots[idx] = TOMBSTONE;
					data[LENGTH_INDEX]--;
					data[TOMBSTONE_INDEX]++;
					return true;
				}
				idx = (idx + 1) & mask;
			}
		} finally {
			unlock(this.lock);
		}
	}

	// Best-effort scan (see class note): not lock-guarded, so must not run concurrently with writes from another thread.
	*[Symbol.iterator](): IterableIterator<[number, V[number]]> {
		this.ensureTable();
		let slots = this.cachedSlots!;
		let values = this.cachedValues! as NumericArrayIO;
		let capacity = this.cachedCapacity;
		let keysBase = capacity;
		for(let i = 0; i < capacity; i++) {
			if(slots[i] === FULL) {
				yield [slots[keysBase + i], values[i]];
			}
		}
	}

	// Rehash into a fresh table. Doubles capacity when live entries are crowding the table; when tombstones are the cause,
	// a same-size table already reclaims them. Caller must hold the lock.
	private resize() {
		this.ensureTable();
		let oldTable = this.cachedTableMemory!;
		let oldSlots = this.cachedSlots!;
		let oldValues = this.cachedValues! as NumericArrayIO;
		let oldCapacity = this.cachedCapacity;
		let oldKeysBase = oldCapacity;
		let length = Atomics.load(this.pointerMemory.data, LENGTH_INDEX);

		let newCapacity = oldCapacity;
		if((length + 1) * LOAD_DENOMINATOR > oldCapacity * LOAD_NUMERATOR) {
			newCapacity = oldCapacity * 2;
		}
		let newTable = this.memory.allocUI32(this.tableLength(newCapacity));
		let newSlots = newTable.data;
		let newValues = this.makeValuesView(newTable, newCapacity) as NumericArrayIO;
		let mask = newCapacity - 1;
		let newKeysBase = newCapacity;

		for(let i = 0; i < oldCapacity; i++) {
			if(oldSlots[i] !== FULL) {
				continue;
			}

			let key = oldSlots[oldKeysBase + i];
			let value = oldValues[i];
			let idx = mix32(key) & mask;
			// Fresh table has no tombstones, so probe straight to the first empty slot
			while(newSlots[idx] !== EMPTY) {
				idx = (idx + 1) & mask;
			}
			newSlots[idx] = FULL;
			newSlots[newKeysBase + idx] = key;
			newValues[idx] = value;
		}

		storeRawPointer(this.pointerMemory.data, TABLE_POINTER_INDEX, newTable.pointer);
		Atomics.store(this.pointerMemory.data, CAPACITY_INDEX, newCapacity);
		Atomics.store(this.pointerMemory.data, TOMBSTONE_INDEX, 0);
		// Invalidate the cached views so the next access rebuilds against the new table
		this.cachedTablePointer = 0;
		this.cachedSlots = undefined;
		oldTable.free();
	}

	free() {
		this.ensureTable();
		this.cachedTableMemory!.free();
		this.pointerMemory.free();
	}

	getSharedMemory(): SharedMapMemory {
		return {
			firstBlock: this.pointerMemory.getSharedMemory(),
		};
	}
}

interface SharedMapConfig<V extends NumericArray> {
	type?: TypedArrayConstructor<V>
}
interface SharedMapMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedMapConfig, SharedMapMemory };
