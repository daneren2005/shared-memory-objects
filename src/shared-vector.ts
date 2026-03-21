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

const VECTOR_INDEX = 0;
const LENGTH_INDEX = 1;
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
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX);
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

	get pointer() {
		return this.firstBlock.pointer;
	}

	private cachedFullDataBlock?: T;
	private cachedPointer: number;

	constructor(memory: MemoryHeap, config?: SharedVectorConfig<T> | SharedVectorMemory | SharedVectorMemory & SharedVectorConfig<T>) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			// Pre-allocating memory and setting up in specific memory location
			if('type' in config || 'dataLength' in config) {
				const bufferLength = config.bufferLength ?? DEFAULT_SIZE;
				let dataBlock = memory.allocUI32(bufferLength * (config.dataLength ?? 1));
				storePointer(this.firstBlock.data, VECTOR_INDEX, dataBlock.bufferPosition, dataBlock.bufferByteOffset);
				this.bufferLength = bufferLength;
				this.dataLength = (config.dataLength ?? 1);
			}
			if('type' in config) {
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
			}
		} else {
			this.firstBlock = memory.allocUI32(SharedVector.ALLOCATE_COUNT);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			let dataLength = config?.dataLength ?? 1;
			let bufferLength = config?.bufferLength ?? DEFAULT_SIZE;
			let dataBlock = memory.allocUI32(bufferLength * dataLength);
			storePointer(this.firstBlock.data, VECTOR_INDEX, dataBlock.bufferPosition, dataBlock.bufferByteOffset);
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
		this.cachedFullDataBlock = this.getFullDataBlock();
	}

	at(index: number): T {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}

		let dataBlock = this.getFullDataBlock();
		return this.getDataBlock(dataBlock, index);
	}
	get(index: number, dataIndex = 0): number {
		if(dataIndex >= this.dataLength) {
			throw new Error(`${dataIndex} is out of dataLength bounds ${this.dataLength}`);
		} else if(index >= this.length || index < 0) {
			throw new Error(`${index} is out of bounds ${this.length}`);
		}

		let dataBlock = this.getFullDataBlock();
		return dataBlock[index * this.dataLength + dataIndex];
	}

	push(values: number | Array<number>): number {
		if(typeof values === 'number') {
			values = [values];
		}

		let dataLength = this.dataLength;
		if(values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}

		let dataBlock = this.getFullDataBlock();
		let currentLength = this.length;
		dataBlock.set(values, dataLength * currentLength);

		let newLength = Atomics.add(this.firstBlock.data, LENGTH_INDEX, 1) + 1;
		if(newLength >= this.bufferLength) {
			this.growBuffer();
		}

		return currentLength;
	}

	pop(): T {
		let oldLength = Atomics.sub(this.firstBlock.data, LENGTH_INDEX, LENGTH_INDEX);

		let dataBlock = this.getFullDataBlock();
		return this.getDataBlock(dataBlock, oldLength - 1);
	}

	deleteIndex(index: number) {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}

		let dataLength = this.dataLength;
		let dataBlock = this.getFullDataBlock();
		for(let i = index; i < length; i++) {
			for(let j = 0; j < dataLength; j++) {
				dataBlock[i * dataLength + j] = dataBlock[(i + 1) * dataLength + j];
			}
		}

		Atomics.sub(this.firstBlock.data, LENGTH_INDEX, LENGTH_INDEX);
	}

	clear() {
		this.firstBlock.data[LENGTH_INDEX] = 0;
	}

	*[Symbol.iterator]() {
		let dataBlock = this.getFullDataBlock();

		for(let i = 0; i < this.length; i++) {
			yield this.getDataBlock(dataBlock, i);
		}
	}

	private getFullDataBlock(): T {
		let pointerNumber = Atomics.load(this.firstBlock.data, VECTOR_INDEX);
		if(this.cachedPointer === pointerNumber && this.cachedFullDataBlock) {
			return this.cachedFullDataBlock;
		}

		let pointer = getPointer(pointerNumber);
		let rawData = new AllocatedMemory(this.memory, pointer);

		let data: T;
		switch(this.type) {
			case TYPE.int32:
				data = new Int32Array(rawData.data.buffer, rawData.bufferByteOffset, this.dataLength * this.bufferLength) as T;
				break;
			case TYPE.uint32:
				data = new Uint32Array(rawData.data.buffer, rawData.bufferByteOffset, this.dataLength * this.bufferLength) as T;
				break;
			case TYPE.float32:
				data = new Float32Array(rawData.data.buffer, rawData.bufferByteOffset, this.dataLength * this.bufferLength) as T;
				break;
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}

		this.cachedPointer = pointerNumber;
		this.cachedFullDataBlock = data;

		return data;
	}
	private getDataBlock(rawData: T, index: number): T {
		const start = index * this.dataLength;
		return rawData.subarray(start, start + this.dataLength) as T;
	}

	private growBuffer() {
		let oldBufferLength = this.bufferLength;
		let newBufferLength = oldBufferLength * 2;
		let dataLength = this.dataLength;

		let oldPointer = loadPointer(this.firstBlock.data, VECTOR_INDEX);
		let oldDataMemory = new AllocatedMemory(this.memory, oldPointer);
		let oldDataBlock = this.getFullDataBlock();
		let newDataBlock = this.memory.allocUI32(newBufferLength * dataLength);

		let newData: T;
		switch(this.type) {
			case TYPE.int32:
				newData = new Int32Array(newDataBlock.data.buffer, newDataBlock.bufferByteOffset, dataLength * this.bufferLength) as T;
				break;
			case TYPE.uint32:
				newData = new Uint32Array(newDataBlock.data.buffer, newDataBlock.bufferByteOffset, dataLength * this.bufferLength) as T;
				break;
			case TYPE.float32:
				newData = new Float32Array(newDataBlock.data.buffer, newDataBlock.bufferByteOffset, dataLength * this.bufferLength) as T;
				break;
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}

		// Copy old buffer into new buffer
		newData.set(oldDataBlock);

		storePointer(this.firstBlock.data, VECTOR_INDEX, newDataBlock.bufferPosition, newDataBlock.bufferByteOffset);
		this.bufferLength = newBufferLength;
		oldDataMemory.free();
	}

	free() {
		let pointer = loadPointer(this.firstBlock.data, VECTOR_INDEX);
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