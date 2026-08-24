import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import { lock, unlock } from './lock/simple-lock';
import type MemoryHeap from './memory-heap';
import SharedStack from './shared-stack';
import { getPointer, loadRawPointer, storeRawPointer } from './utils/pointer';
import { getArrayTypeCode, getByteMultipler, makeArrayView, type NumericArray, type NumericArrayIO, type TypedArrayConstructor } from './utils/array-type';

const LENGTH_INDEX = 0;
const TYPE_INDEX = 1;
const MAX_CHUNK_SIZE_INDEX = 2;
// Guards appending a chunk pointer so only one thread grows the pointer stack at a time
const GROW_LOCK_INDEX = 3;
// Pointers to the two backing SharedStacks (their own firstBlocks): the chunk pointers and the recycled indexes
const POINTER_STACK_INDEX = 4;
const RECYCLE_STACK_INDEX = 5;

const DEFAULT_MAX_CHUNK_SIZE = 100;
const DEFAULT_MAX_LENGTH = 1_000_000;
const DEFAULT_MAX_RECYCLED_LENGTH = 100_000;

// Array with stable indexes and maximum contiguous memory sizes (necessary to fit large data sets into max 1MB buffers).
// The chunk pointers and the recycled indexes both live in SharedStacks, whose segments are never moved or freed once
// published, so concurrent readers never touch memory that is being reclaimed.
// https://plflib.org/colony.htm for future enhancements - it seems to be an optimized version of what we were aiming for with this
export default class SharedPool<T extends NumericArray = Uint32Array> implements Iterable<T> {
	static readonly ALLOCATE_COUNT = 6;
	private memory: MemoryHeap;

	// Current Length, Type/DataLength, MaxChunkLength, Grow lock, Pointer stack, Recycle stack
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;
	private growLock: Int32Array;
	private pointerStack: SharedStack;
	private recycleStack: SharedStack;
	readonly maxLength: number;

	private cachedFullDataBlock: { [key: number]: T } = {};

	// Config is written once at construction and never mutated, so it is cached in plain fields
	private readonly cachedMaxChunkSize: number;
	private readonly cachedDataLength: number;
	private readonly cachedType: number;
	private readonly cachedByteMultipler: number;

	get length(): number {
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX) - this.recycleStack.length;
	}
	get maxChunkSize(): number {
		return this.cachedMaxChunkSize;
	}
	private set maxChunkSize(value: number) {
		Atomics.store(this.firstBlock.data, MAX_CHUNK_SIZE_INDEX, value);
	}

	get type(): number {
		return this.cachedType;
	}
	private set type(value: number) {
		Atomics.store(this.uint16Array, 0, value);
	}
	get dataLength(): number {
		return this.cachedDataLength;
	}
	private set dataLength(value: number) {
		Atomics.store(this.uint16Array, 1, value);
	}

	get bufferLength(): number {
		return this.cachedMaxChunkSize * this.pointerStack.length;
	}
	get byteMultipler(): number {
		return this.cachedByteMultipler;
	}

	// Own internal memory (which already includes both stacks' inlined firstBlocks) plus every chunk buffer and the
	// segments each stack has grown. The stacks' usedMemory excludes their inlined firstBlocks, so they aren't double-counted.
	get usedMemory(): number {
		let total = this.firstBlock.usedMemory;
		for(let pointer of this.pointerStack) {
			total += new AllocatedMemory(this.memory, getPointer(pointer)).usedMemory;
		}
		return total + this.pointerStack.usedMemory + this.recycleStack.usedMemory;
	}

	constructor(memory: MemoryHeap, config?: SharedPoolConfig<T> | SharedPoolMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);
			this.pointerStack = new SharedStack(memory, {
				firstBlock: getPointer(loadRawPointer(this.firstBlock.data, POINTER_STACK_INDEX)),
			});
			this.recycleStack = new SharedStack(memory, {
				firstBlock: getPointer(loadRawPointer(this.firstBlock.data, RECYCLE_STACK_INDEX)),
			});
		} else {
			let dataLength = config?.dataLength ?? 1;
			let maxChunkSize = config?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
			let maxLength = config?.maxLength ?? DEFAULT_MAX_LENGTH;
			let maxRecycledLength = config?.maxRecycledLength ?? DEFAULT_MAX_RECYCLED_LENGTH;

			// Each stack sizes its inlined firstBlock from its own maxLength, so compute both up front to lay them out. The
			// stacks cap their segments at what a buffer can hold, so size the inlined blocks against that same cap.
			let maxSegmentLength = SharedStack.getMaxSegmentLength(memory.maxAllocationLength);
			let pointerStackMaxLength = maxLength / maxChunkSize;
			let pointerStackAllocateCount = SharedStack.getAllocateCount(pointerStackMaxLength, undefined, maxSegmentLength);
			let recycleStackAllocateCount = SharedStack.getAllocateCount(maxRecycledLength, undefined, maxSegmentLength);

			// Inline both stacks' firstBlocks right after the pool header so the whole spine is one contiguous allocation
			this.firstBlock = memory.allocUI32(SharedPool.ALLOCATE_COUNT + pointerStackAllocateCount + recycleStackAllocateCount);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			this.pointerStack = new SharedStack(memory, {
				firstBlock: this.firstBlock.getSubAllocation(SharedPool.ALLOCATE_COUNT, pointerStackAllocateCount),
				type: Uint32Array,
				maxLength: pointerStackMaxLength,
			});
			storeRawPointer(this.firstBlock.data, POINTER_STACK_INDEX, this.pointerStack.pointer);
			this.recycleStack = new SharedStack(memory, {
				firstBlock: this.firstBlock.getSubAllocation(SharedPool.ALLOCATE_COUNT + pointerStackAllocateCount, recycleStackAllocateCount),
				type: Uint32Array,
				maxLength: maxRecycledLength,
			});
			storeRawPointer(this.firstBlock.data, RECYCLE_STACK_INDEX, this.recycleStack.pointer);

			let typeCode = getArrayTypeCode(config?.type ?? Uint32Array);
			this.type = typeCode;
			this.dataLength = dataLength;
			this.maxChunkSize = maxChunkSize;

			let byteMultipler = getByteMultipler(typeCode);
			let firstArray = memory.allocUI32(maxChunkSize * dataLength * byteMultipler);
			this.pointerStack.push(firstArray.pointer);
		}

		this.cachedType = this.uint16Array[0];
		this.cachedDataLength = Math.max(1, this.uint16Array[1]);
		this.cachedMaxChunkSize = this.firstBlock.data[MAX_CHUNK_SIZE_INDEX];
		this.cachedByteMultipler = getByteMultipler(this.cachedType);
		this.maxLength = this.cachedMaxChunkSize * this.pointerStack.maxLength;

		this.growLock = new Int32Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + GROW_LOCK_INDEX * Uint32Array.BYTES_PER_ELEMENT, 1);
	}

	at(index: number): T {
		let dataBlock = this.getFullDataBlock(index);
		return this.getDataBlock(dataBlock, index % this.cachedMaxChunkSize);
	}
	get(index: number, dataIndex = 0): T[number] {
		const dataLength = this.cachedDataLength;
		if(dataIndex >= dataLength) {
			throw new Error(`${dataIndex} is out of dataLength bounds ${dataLength}`);
		}

		let dataBlock = this.getFullDataBlock(index) as NumericArrayIO;
		return dataBlock[(index % this.cachedMaxChunkSize) * dataLength + dataIndex];
	}

	push(values: T[number] | Array<T[number]>): number {
		let dataLength = this.cachedDataLength;
		const isSingleValue = typeof values !== 'object';
		if(!isSingleValue && values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}

		// Reuse a recycled index if one is available. pop() can come back undefined when another thread drained the last
		// slot between our two calls, so fall through to a fresh index rather than trusting a length() read
		let newIndex = this.recycleStack.pop();
		if(newIndex === undefined) {
			newIndex = Atomics.add(this.firstBlock.data, LENGTH_INDEX, 1);
		}

		let dataBlock = this.getFullDataBlock(newIndex) as NumericArrayIO;
		let startIndex = dataLength * (newIndex % this.cachedMaxChunkSize);
		if(isSingleValue) {
			dataBlock[startIndex] = values;
		} else {
			for(let i = 0; i < values.length; i++) {
				dataBlock[startIndex + i] = values[i];
			}
		}

		return newIndex;
	}

	deleteIndex(index: number) {
		this.recycleStack.push(index);
	}

	clear() {
		this.firstBlock.data[LENGTH_INDEX] = 0;
		this.recycleStack.clear();
	}

	*[Symbol.iterator]() {
		const recycledValues: { [key: number]: true } = {};
		for(let value of this.recycleStack) {
			recycledValues[value] = true;
		}

		const maxChunkSize = this.cachedMaxChunkSize;
		// Snapshot the length once - iteration over a concurrently mutated pool is a snapshot anyway, and re-loading the
		// atomic every step is pure overhead
		const length = Atomics.load(this.firstBlock.data, LENGTH_INDEX);
		let dataBlock = this.getFullDataBlock(0);
		let dataBlockIndex = 0;
		for(let i = 0; i < length; i++) {
			if(!recycledValues[i]) {
				let newDataBlockIndex = Math.floor(i / maxChunkSize);
				if(newDataBlockIndex !== dataBlockIndex) {
					dataBlock = this.getFullDataBlock(i);
					dataBlockIndex = newDataBlockIndex;
				}
				yield this.getDataBlock(dataBlock, i % maxChunkSize);
			}
		}
	}

	private getFullDataBlock(index: number) {
		let pointerIndex = Math.floor(index / this.cachedMaxChunkSize);
		let cachedDataBlock = this.cachedFullDataBlock[pointerIndex];
		if(cachedDataBlock) {
			return cachedDataBlock;
		}
		if(pointerIndex >= this.pointerStack.length) {
			// Only let a single thread append a new chunk at a time - otherwise two concurrent inserts landing in a new
			// chunk would each allocate + push a buffer, orphaning one and leaking memory
			lock(this.growLock);
			try {
				// Re-check under the lock: another thread may have already appended the chunk while we were waiting
				while(pointerIndex >= this.pointerStack.length) {
					let newArray = this.memory.allocUI32(this.cachedMaxChunkSize * this.cachedDataLength * this.cachedByteMultipler);
					this.pointerStack.push(newArray.pointer);
				}
			} finally {
				unlock(this.growLock);
			}
		}

		let array = new AllocatedMemory(this.memory, getPointer(this.pointerStack.at(pointerIndex)));

		let blockLength = this.cachedDataLength * this.cachedMaxChunkSize;
		let data = makeArrayView(this.cachedType, array.data.buffer, array.bufferByteOffset, blockLength) as T;

		this.cachedFullDataBlock[pointerIndex] = data;
		return data;
	}

	private getDataBlock(rawData: T, index: number): T {
		const dataLength = this.cachedDataLength;
		const start = index * dataLength;
		return rawData.subarray(start, start + dataLength) as T;
	}

	free() {
		this.recycleStack.free();

		for(let pointer of this.pointerStack) {
			let memory = new AllocatedMemory(this.memory, getPointer(pointer));
			memory.free();
		}
		this.pointerStack.free();
		this.firstBlock.free();
	}

	getSharedMemory(): SharedPoolMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}
}

interface SharedPoolConfig<T extends NumericArray> {
	maxChunkSize?: number
	maxLength?: number
	maxRecycledLength?: number
	type?: TypedArrayConstructor<T>
	dataLength?: number
}
interface SharedPoolMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedPoolConfig, SharedPoolMemory };
