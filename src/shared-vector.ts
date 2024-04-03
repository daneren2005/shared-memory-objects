import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import type { TypedArrayConstructor } from './interfaces/typed-array-constructor';
import type MemoryHeap from './memory-heap';
import { getPointer, loadPointer, storePointer } from './utils/pointer';

enum TYPE {
	uint32,
	int32,
	float32
}

const LIST_LENGTH_INDEX = 1;
const BUFFER_LENGTH_INDEX = 2;
const TYPE_INDEX = 3;
const DEFAULT_SIZE = 4;
export default class SharedVector<T extends Uint32Array | Int32Array | Float32Array = Uint32Array> implements Iterable<T> {
	static readonly ALLOCATE_COUNT = 4;
	private memory: MemoryHeap;

	// Pointer, List Length, Buffer Length, Type/DataLength
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;

	get length(): number {
		return Atomics.load(this.firstBlock.data, LIST_LENGTH_INDEX);
	}
	
	get type(): number {
		return this.uint16Array[0];
	}
	private set type(value: number) {
		Atomics.store(this.uint16Array, 0, value);
	}
	get dataLength(): number {
		// Can technically be initialized by passing memory without actually every being called - need to make sure dataLength is always at least one
		return Math.max(1, this.uint16Array[1]);
	}
	private set dataLength(value: number) {
		Atomics.store(this.uint16Array, 1, value);
	}

	get bufferLength(): number {
		return Atomics.load(this.firstBlock.data, BUFFER_LENGTH_INDEX);
	}
	private set bufferLength(value: number) {
		Atomics.store(this.firstBlock.data, BUFFER_LENGTH_INDEX, value);
	}

	private cachedFullDataBlock?: T;
	private cachedPointer: number;

	constructor(memory: MemoryHeap, config?: SharedVectorConfig<T> | SharedVectorMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);
		} else {
			this.firstBlock = memory.allocUI32(SharedVector.ALLOCATE_COUNT);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			let dataLength = config?.dataLength ?? 1;
			let bufferLength = config?.bufferLength ?? DEFAULT_SIZE;
			let dataBlock = memory.allocUI32(bufferLength * dataLength);
			storePointer(this.firstBlock.data, 0, dataBlock.bufferPosition, dataBlock.bufferByteOffset);
			this.bufferLength = bufferLength;

			const type = config?.type ?? Uint32Array;
			if(type === Uint32Array) {
				this.type = TYPE.uint32;
			}
			// @ts-expect-error
			else if(type === Int32Array) {
				this.type = TYPE.int32;
			}
			// @ts-expect-error
			else if(type === Float32Array) {
				this.type = TYPE.float32;
			}
			this.dataLength = dataLength;
		}

		this.cachedPointer = this.firstBlock.data[0];
		this.cachedFullDataBlock = this.getFullDataBlock(this.dataLength);
	}

	push(values: number | Array<number>) {
		if(typeof values === 'number') {
			values = [values];
		}

		let dataLength = this.dataLength;
		if(values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}

		let dataBlock = this.getFullDataBlock(dataLength);
		let currentLength = this.length;
		dataBlock.set(values, dataLength * currentLength);

		let newLength = Atomics.add(this.firstBlock.data, LIST_LENGTH_INDEX, LIST_LENGTH_INDEX) + 1;
		if(newLength >= this.bufferLength) {
			this.growBuffer();
		}
	}

	pop(): T {
		let oldLength = Atomics.sub(this.firstBlock.data, LIST_LENGTH_INDEX, LIST_LENGTH_INDEX);

		let pointer = loadPointer(this.firstBlock.data, 0);
		let dataMemory = new AllocatedMemory(this.memory, pointer);
		return this.getDataBlock(dataMemory.data, oldLength - 1);
	}

	deleteIndex(index: number) {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}

		let dataLength = this.dataLength;
		let dataBlock = this.getFullDataBlock(dataLength);
		for(let i = index; i < length; i++) {
			for(let j = 0; j < dataLength; j++) {
				dataBlock[i * dataLength + j] = dataBlock[(i + 1) * dataLength + j];
			}
		}

		Atomics.sub(this.firstBlock.data, LIST_LENGTH_INDEX, LIST_LENGTH_INDEX);
	}

	clear() {
		this.firstBlock.data[LIST_LENGTH_INDEX] = 0;
	}

	*[Symbol.iterator]() {
		let pointer = loadPointer(this.firstBlock.data, 0);
		let dataMemory = new AllocatedMemory(this.memory, pointer);

		for(let i = 0; i < this.length; i++) {
			yield this.getDataBlock(dataMemory.data, i);
		}
	}

	private getFullDataBlock(dataLength: number): T {
		let pointerNumber = Atomics.load(this.firstBlock.data, 0);
		if(this.cachedPointer === pointerNumber && this.cachedFullDataBlock) {
			return this.cachedFullDataBlock;
		}

		let pointer = getPointer(pointerNumber);
		let rawData = new AllocatedMemory(this.memory, pointer);

		let data: T;
		switch(this.type) {
			case TYPE.int32:
				// @ts-expect-error
				data = new Int32Array(rawData.data.buffer, rawData.bufferByteOffset, dataLength * this.bufferLength);
				break;
			case TYPE.uint32:
				// @ts-expect-error
				data = new Uint32Array(rawData.data.buffer, rawData.bufferByteOffset, dataLength * this.bufferLength);
				break;
			case TYPE.float32:
				// @ts-expect-error
				data = new Float32Array(rawData.data.buffer, smemory.bufferByteOffset, dataLength * this.bufferLength);
				break;
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}

		this.cachedPointer = pointerNumber;
		this.cachedFullDataBlock = data;

		return data;
	}
	private getDataBlock(rawData: Uint32Array, index: number): T {
		switch(this.type) {
			case TYPE.int32:
				// @ts-expect-error
				return new Int32Array(rawData.buffer, rawData.byteOffset + index * this.dataLength * 4, this.dataLength);
			case TYPE.uint32:
				// @ts-expect-error
				return new Uint32Array(rawData.buffer, rawData.byteOffset + index * this.dataLength * 4, this.dataLength);
			case TYPE.float32:
				// @ts-expect-error
				return new Float32Array(rawData.buffer, smemory.byteOffset + index * this.dataLength * 4, this.dataLength);
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}
	}

	private growBuffer() {
		let oldBufferLength = this.bufferLength;
		let newBufferLength = oldBufferLength * 2;
		let dataLength = this.dataLength;

		let oldPointer = loadPointer(this.firstBlock.data, 0);
		let oldDataMemory = new AllocatedMemory(this.memory, oldPointer);
		let oldDataBlock = this.getFullDataBlock(dataLength);
		let newDataBlock = this.memory.allocUI32(newBufferLength * dataLength);
		// Copy old buffer into new buffer
		newDataBlock.data.set(oldDataBlock);

		storePointer(this.firstBlock.data, 0, newDataBlock.bufferPosition, newDataBlock.bufferByteOffset);
		this.bufferLength = newBufferLength;
		oldDataMemory.free();
	}

	free() {
		let pointer = loadPointer(this.firstBlock.data, 0);
		let dataMemory = new AllocatedMemory(this.memory, pointer);

		dataMemory.free();
		this.firstBlock.free();
	}

	getSharedMemory(): SharedVectorMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory()
		};
	}
}

interface SharedVectorConfig<T extends Uint32Array | Int32Array | Float32Array> {
	type?: TypedArrayConstructor<T>
	dataLength?: number

	bufferLength?: number
}
interface SharedVectorMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedVectorConfig, SharedVectorMemory };