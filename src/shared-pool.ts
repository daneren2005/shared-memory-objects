import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import type { TypedArrayConstructor } from './interfaces/typed-array-constructor';
import { lock, unlock } from './lock/simple-lock';
import type MemoryHeap from './memory-heap';
import { getPointer } from './utils/pointer';

enum TYPE {
	uint32,
	int32,
	float32,
	float64,
}

const LENGTH_INDEX = 0;
const TYPE_INDEX = 1;
const MAX_CHUNK_SIZE_INDEX = 2;
// Guards growing the pointer spine so only one thread appends a new chunk at a time
const GROW_LOCK_INDEX = 3;
// Lock free free-list (Treiber stack) of deleted indexes. The head packs an ABA version counter (high bits) with the
// head index + 1 (low bits, 0 == empty) into a single 32 bit int so we can CAS it without BigInt (which allocates and
// tanks throughput). FREE_COUNT keeps length() O(1).
const FREE_HEAD_INDEX = 4;
const FREE_COUNT_INDEX = 5;
// Number of chunks appended so far, followed by the pointer spine (see below)
const POINTER_COUNT_INDEX = 6;
const SPINE_INDEX = 7;

// Append-only pointer storage: instead of one buffer we reallocate + copy + free (which would let concurrent readers
// read freed memory), chunk pointers live in a fixed spine of geometrically sized segments. Segment k holds
// SEGMENT_BASE << k pointers, so a small fixed spine covers an enormous number of chunks, existing segments are never
// moved or freed, and readers never touch memory that is being reclaimed. Appends happen under GROW_LOCK (single
// writer); reads are lock free.
const SEGMENT_BASE = 32;
const SEGMENT_BASE_LOG2 = 5;
// 32 segments cover SEGMENT_BASE * (2^32 - 1) chunks - far past the free-list's ~4.2M index cap under any chunk size
const MAX_SEGMENTS = 32;

// Packed free-list head layout: low INDEX_BITS hold the head index + 1 (0 == empty), the high bits are an ABA version
// tag bumped on every push/pop. 22 index bits caps a pool at ~4.2M live+deleted slots; the remaining 10 version bits
// (1024) only need to outlast a single thread's load->CAS window, which they do outside of pathological preemption.
const INDEX_BITS = 22;
const INDEX_MASK = (1 << INDEX_BITS) - 1;
const MAX_INDEX = INDEX_MASK - 1;
const EMPTY_HEAD = 0;

// Array with stable indexes and maximum contiguous memory sizes (necessary to fit large data sets into max 1MB buffers)
// https://plflib.org/colony.htm for future enhancements - it seems to be an optimized version of what we were aiming for with this
export default class SharedPool<T extends Uint32Array | Int32Array | Float32Array | Float64Array = Uint32Array> implements Iterable<T> {
	static readonly ALLOCATE_COUNT = SPINE_INDEX + MAX_SEGMENTS;
	private memory: MemoryHeap;

	// Current Length, Type/DataLength, MaxChunkLength, Grow lock, Free-list head, Free-list count, Chunk count, Spine
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;
	private growLock: Int32Array;
	private freeHead: Int32Array;

	private cachedFullDataBlock: { [key: number]: T } = {};
	// A raw Uint32 view of each chunk so we can read/write the free-list link in a freed slot regardless of pool type
	private cachedChunkU32: { [key: number]: Uint32Array } = {};
	// A cached view of each spine segment - once a segment pointer is published it never changes, so this is safe forever
	private cachedSegments: { [key: number]: Uint32Array } = {};

	get length(): number {
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX) - Atomics.load(this.firstBlock.data, FREE_COUNT_INDEX);
	}
	get maxChunkSize(): number {
		return this.firstBlock.data[MAX_CHUNK_SIZE_INDEX];
	}
	private set maxChunkSize(value: number) {
		Atomics.store(this.firstBlock.data, MAX_CHUNK_SIZE_INDEX, value);
	}

	get type(): number {
		return this.uint16Array[0];
	}
	private set type(value: number) {
		Atomics.store(this.uint16Array, 0, value);
	}
	get dataLength(): number {
		return Math.max(1, this.uint16Array[1]);
	}
	private set dataLength(value: number) {
		Atomics.store(this.uint16Array, 1, value);
	}

	get bufferLength(): number {
		return this.maxChunkSize * this.chunkCount;
	}
	get byteMultipler(): number {
		if(this.type === TYPE.float64) {
			return 2;
		} else {
			return 1;
		}
	}

	constructor(memory: MemoryHeap, config?: SharedPoolConfig<T> | SharedPoolMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);
		} else {
			this.firstBlock = memory.allocUI32(SharedPool.ALLOCATE_COUNT);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			let dataLength = config?.dataLength ?? 1;
			let maxLength = config?.maxChunkSize ?? 100;

			const type = config?.type ?? Uint32Array;
			if(type === Uint32Array) {
				this.type = TYPE.uint32;
			// @ts-expect-error
			} else if(type === Int32Array) {
				this.type = TYPE.int32;
			// @ts-expect-error
			} else if(type === Float32Array) {
				this.type = TYPE.float32;
			// @ts-expect-error
			} else if(type === Float64Array) {
				this.type = TYPE.float64;
			}
			this.dataLength = dataLength;
			this.maxChunkSize = maxLength;

			let firstArray = memory.allocUI32(maxLength * dataLength * this.byteMultipler);
			this.appendChunkPointer(firstArray.pointer);
		}

		this.growLock = new Int32Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + GROW_LOCK_INDEX * Uint32Array.BYTES_PER_ELEMENT, 1);
		this.freeHead = new Int32Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + FREE_HEAD_INDEX * Uint32Array.BYTES_PER_ELEMENT, 1);
	}

	at(index: number): T {
		let dataBlock = this.getFullDataBlock(index);
		return this.getDataBlock(dataBlock, index % this.maxChunkSize);
	}
	get(index: number, dataIndex = 0): number {
		const dataLength = this.dataLength;
		if(dataIndex >= dataLength) {
			throw new Error(`${dataIndex} is out of dataLength bounds ${dataLength}`);
		}

		let dataBlock = this.getFullDataBlock(index);
		return dataBlock[(index % this.maxChunkSize) * dataLength + dataIndex];
	}

	push(values: number | Array<number>): number {
		if(typeof values === 'number') {
			values = [values];
		}

		let dataLength = this.dataLength;
		if(values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}

		let newIndex = this.popFreeIndex();
		if(newIndex === undefined) {
			newIndex = Atomics.add(this.firstBlock.data, LENGTH_INDEX, 1);
		}

		let dataBlock = this.getFullDataBlock(newIndex);
		let blockIndex = newIndex % this.maxChunkSize;
		dataBlock.set(values, dataLength * blockIndex);

		return newIndex;
	}

	deleteIndex(index: number) {
		if(index > MAX_INDEX) {
			// The free-list head packs index + version into 32 bits - past this the index would corrupt the version tag
			throw new Error(`Can't delete index ${index}: SharedPool is capped at ${MAX_INDEX} indexes by the free-list packing`);
		}

		// Push onto the lock free free-list: link this slot to the current head then CAS the head to point at us. The
		// version tag in the high bits is what keeps this ABA safe - if the head changed at all our CAS fails and retries
		let indexPlus1 = index + 1;
		let oldHead: number;
		do {
			oldHead = Atomics.load(this.freeHead, 0);
			this.setFreeLink(index, oldHead & INDEX_MASK);
			let newHead = (((oldHead >>> INDEX_BITS) + 1) << INDEX_BITS | indexPlus1) | 0;
			if(Atomics.compareExchange(this.freeHead, 0, oldHead, newHead) === oldHead) {
				break;
			}
			// eslint-disable-next-line no-constant-condition
		} while(true);

		Atomics.add(this.firstBlock.data, FREE_COUNT_INDEX, 1);
	}

	clear() {
		this.firstBlock.data[LENGTH_INDEX] = 0;
		Atomics.store(this.freeHead, 0, 0);
		Atomics.store(this.firstBlock.data, FREE_COUNT_INDEX, 0);
	}

	*[Symbol.iterator]() {
		const recycledValues: { [key: number]: true } = {};
		// Walk the free-list from the head, following the links stored in each freed slot
		let raw = Atomics.load(this.freeHead, 0) & INDEX_MASK;
		while(raw !== EMPTY_HEAD) {
			let index = raw - 1;
			recycledValues[index] = true;
			raw = this.getFreeLink(index);
		}

		let dataBlock = this.getFullDataBlock(0);
		let dataBlockIndex = 0;
		for(let i = 0; i < Atomics.load(this.firstBlock.data, LENGTH_INDEX); i++) {
			if(!recycledValues[i]) {
				let newDataBlockIndex = Math.floor(i / this.maxChunkSize);
				if(newDataBlockIndex !== dataBlockIndex) {
					dataBlock = this.getFullDataBlock(i);
					dataBlockIndex = newDataBlockIndex;
				}
				yield this.getDataBlock(dataBlock, i % this.maxChunkSize);
			}
		}
	}

	// Pops an index off the lock free free-list, or returns undefined when there is nothing to recycle
	private popFreeIndex(): number | undefined {
		let freeIndex: number;
		do {
			let oldHead = Atomics.load(this.freeHead, 0);
			let raw = oldHead & INDEX_MASK;
			if(raw === EMPTY_HEAD) {
				return undefined;
			}

			freeIndex = raw - 1;
			// The next link is safe to read here: if any other thread touched the head the CAS below fails and we retry
			let next = this.getFreeLink(freeIndex);
			let newHead = (((oldHead >>> INDEX_BITS) + 1) << INDEX_BITS | next) | 0;
			if(Atomics.compareExchange(this.freeHead, 0, oldHead, newHead) === oldHead) {
				break;
			}
			// eslint-disable-next-line no-constant-condition
		} while(true);

		Atomics.sub(this.firstBlock.data, FREE_COUNT_INDEX, 1);
		return freeIndex;
	}

	private getFullDataBlock(index: number) {
		let pointerIndex = Math.floor(index / this.maxChunkSize);
		let cachedDataBlock = this.cachedFullDataBlock[pointerIndex];
		if(cachedDataBlock) {
			return cachedDataBlock;
		}
		if(pointerIndex >= this.chunkCount) {
			// Only let a single thread append a new chunk at a time - otherwise two concurrent inserts landing in a new
			// chunk would each allocate + append a buffer, orphaning one and double counting the chunk
			lock(this.growLock);
			try {
				// Re-check under the lock: another thread may have already appended the chunk while we were waiting
				while(pointerIndex >= this.chunkCount) {
					let newArray = this.memory.allocUI32(this.maxChunkSize * this.dataLength * this.byteMultipler);
					this.appendChunkPointer(newArray.pointer);
				}
			} finally {
				unlock(this.growLock);
			}
		}

		let array = new AllocatedMemory(this.memory, getPointer(this.getChunkPointer(pointerIndex)));

		let data: T;
		switch(this.type) {
			case TYPE.int32:
				data = new Int32Array(array.data.buffer, array.bufferByteOffset, this.dataLength * this.maxChunkSize) as T;
				break;
			case TYPE.uint32:
				data = new Uint32Array(array.data.buffer, array.bufferByteOffset, this.dataLength * this.maxChunkSize) as T;
				break;
			case TYPE.float32:
				data = new Float32Array(array.data.buffer, array.bufferByteOffset, this.dataLength * this.maxChunkSize) as T;
				break;
			case TYPE.float64:
				data = new Float64Array(array.data.buffer, array.bufferByteOffset, this.dataLength * this.maxChunkSize) as T;
				break;
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}

		this.cachedFullDataBlock[pointerIndex] = data;
		return data;
	}

	private getDataBlock(rawData: T, index: number): T {
		const start = index * this.dataLength;
		return rawData.subarray(start, start + this.dataLength) as T;
	}

	// Reads/writes the free-list "next" link in a freed slot. We always go through a raw Uint32 view so the link
	// round-trips exactly no matter the pool's data type (a float slot would otherwise mangle the integer link)
	private getFreeLink(index: number): number {
		return this.getChunkU32(index)[this.freeLinkOffset(index)];
	}
	private setFreeLink(index: number, value: number) {
		this.getChunkU32(index)[this.freeLinkOffset(index)] = value;
	}
	private freeLinkOffset(index: number): number {
		return (index % this.maxChunkSize) * this.dataLength * this.byteMultipler;
	}
	private getChunkU32(index: number): Uint32Array {
		let pointerIndex = Math.floor(index / this.maxChunkSize);
		let cached = this.cachedChunkU32[pointerIndex];
		if(cached) {
			return cached;
		}

		let array = new AllocatedMemory(this.memory, getPointer(this.getChunkPointer(pointerIndex)));
		let u32 = new Uint32Array(array.data.buffer, array.bufferByteOffset, this.maxChunkSize * this.dataLength * this.byteMultipler);
		this.cachedChunkU32[pointerIndex] = u32;
		return u32;
	}

	private get chunkCount(): number {
		return Atomics.load(this.firstBlock.data, POINTER_COUNT_INDEX);
	}

	// Reads the chunk pointer at pointerIndex out of the segmented spine. Segments and length are published so that any
	// pointerIndex < chunkCount is guaranteed to have its segment allocated and slot written
	private getChunkPointer(pointerIndex: number): number {
		let segment = 31 - Math.clz32((pointerIndex >>> SEGMENT_BASE_LOG2) + 1);
		let start = (SEGMENT_BASE << segment) - SEGMENT_BASE;
		return this.getSegment(segment)[pointerIndex - start];
	}

	// Appends a chunk pointer to the spine. MUST be called under growLock (single writer). Allocates the segment on its
	// first slot, writes the pointer, then publishes the new count last so readers only see fully written slots
	private appendChunkPointer(pointer: number) {
		let count = Atomics.load(this.firstBlock.data, POINTER_COUNT_INDEX);
		let segment = 31 - Math.clz32((count >>> SEGMENT_BASE_LOG2) + 1);
		let start = (SEGMENT_BASE << segment) - SEGMENT_BASE;
		let offset = count - start;
		if(offset === 0) {
			// First slot of this segment - allocate it and publish its pointer before we bump the count
			let segmentMemory = this.memory.allocUI32(SEGMENT_BASE << segment);
			Atomics.store(this.firstBlock.data, SPINE_INDEX + segment, segmentMemory.pointer);
		}
		this.getSegment(segment)[offset] = pointer;
		Atomics.add(this.firstBlock.data, POINTER_COUNT_INDEX, 1);
	}

	private getSegment(segment: number): Uint32Array {
		let cached = this.cachedSegments[segment];
		if(cached) {
			return cached;
		}

		let pointer = Atomics.load(this.firstBlock.data, SPINE_INDEX + segment);
		let memory = new AllocatedMemory(this.memory, getPointer(pointer));
		let view = new Uint32Array(memory.data.buffer, memory.bufferByteOffset, SEGMENT_BASE << segment);
		this.cachedSegments[segment] = view;
		return view;
	}

	free() {
		let count = this.chunkCount;
		for(let i = 0; i < count; i++) {
			let memory = new AllocatedMemory(this.memory, getPointer(this.getChunkPointer(i)));
			memory.free();
		}

		// Free the spine segments themselves - they are laid out contiguously from segment 0, so stop at the first empty slot
		for(let segment = 0; segment < MAX_SEGMENTS; segment++) {
			let pointer = this.firstBlock.data[SPINE_INDEX + segment];
			if(pointer === 0) {
				break;
			}
			let memory = new AllocatedMemory(this.memory, getPointer(pointer));
			memory.free();
		}

		this.firstBlock.free();
	}

	getSharedMemory(): SharedPoolMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}
}

interface SharedPoolConfig<T extends Uint32Array | Int32Array | Float32Array | Float64Array> {
	maxChunkSize?: number
	type?: TypedArrayConstructor<T>
	dataLength?: number
}
interface SharedPoolMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedPoolConfig, SharedPoolMemory };
