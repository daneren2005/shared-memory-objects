import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import type { TypedArrayConstructor } from './interfaces/typed-array-constructor';
import type MemoryHeap from './memory-heap';
import SharedVector from './shared-vector';
import { getPointer } from './utils/pointer';

enum TYPE {
	uint32,
	int32,
	float32
}

const LENGTH_INDEX = 0;
const BUFFER_LENGTH_INDEX = 1;
const TYPE_INDEX = 2;
const MAX_CHUNK_SIZE_INDEX = 3;
const POINTERS_INDEX = 4;
const RECYCLE_INDEX = POINTERS_INDEX + SharedVector.ALLOCATE_COUNT;
const DEFAULT_SIZE = 4;

// Array with stable indexes and maximum contiguous memory sizes (necessary to fit large data sets into max 1MB buffers)
export default class SharedPool<T extends Uint32Array | Int32Array | Float32Array = Uint32Array> implements Iterable<T> {
	static readonly ALLOCATE_COUNT = 4 + SharedVector.ALLOCATE_COUNT * 2;
	private memory: MemoryHeap;

	// Current Length, Buffer Length, Type/DataLength, MaxChunkLength, Pointer vector
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;
	private pointerVector: SharedVector<Uint32Array>;
	private recycleVector: SharedVector<Uint32Array>;

	get length(): number {
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX) - this.recycleVector.length;
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

	// TODO: Does buffer length do anything here?
	get bufferLength(): number {
		return Atomics.load(this.firstBlock.data, BUFFER_LENGTH_INDEX);
	}
	private set bufferLength(value: number) {
		Atomics.store(this.firstBlock.data, BUFFER_LENGTH_INDEX, value);
	}

	constructor(memory: MemoryHeap, config?: SharedPoolConfig<T> | SharedPoolMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);
			this.pointerVector = new SharedVector(memory, {
				firstBlock: {
					bufferPosition: this.firstBlock.bufferPosition,
					bufferByteOffset: this.firstBlock.bufferByteOffset + POINTERS_INDEX * Uint32Array.BYTES_PER_ELEMENT
				}
			});
			this.recycleVector = new SharedVector(memory, {
				firstBlock: {
					bufferPosition: this.firstBlock.bufferPosition,
					bufferByteOffset: this.firstBlock.bufferByteOffset + RECYCLE_INDEX * Uint32Array.BYTES_PER_ELEMENT
				}
			});
		} else {
			this.firstBlock = memory.allocUI32(SharedPool.ALLOCATE_COUNT);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			let dataLength = config?.dataLength ?? 1;
			let bufferLength = DEFAULT_SIZE;
			let maxLength = config?.maxChunkSize ?? 1_000;

			this.pointerVector = new SharedVector(memory, {
				type: Uint32Array,
				firstBlock: {
					bufferPosition: this.firstBlock.bufferPosition,
					bufferByteOffset: this.firstBlock.bufferByteOffset + POINTERS_INDEX * Uint32Array.BYTES_PER_ELEMENT
				}
			});
			this.recycleVector = new SharedVector(memory, {
				type: Uint32Array,
				firstBlock: {
					bufferPosition: this.firstBlock.bufferPosition,
					bufferByteOffset: this.firstBlock.bufferByteOffset + RECYCLE_INDEX * Uint32Array.BYTES_PER_ELEMENT
				}
			});

			// TODO: Dynamically grow sub-vectors insted of using fixed length versions
			let firstArray = memory.allocUI32(maxLength * dataLength);
			this.pointerVector.push(firstArray.pointer);
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
			this.maxChunkSize = maxLength;
		}
	}

	at(index: number): T {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}

		let dataBlock = this.getFullDataBlock(index);
		return this.getDataBlock(dataBlock, index % this.maxChunkSize);
	}
	get(index: number, dataIndex = 0): number {
		if(dataIndex >= this.dataLength) {
			throw new Error(`${dataIndex} is out of dataLength bounds ${this.dataLength}`);
		}
		return this.at(index)[dataIndex];
	}

	push(values: number | Array<number>): number {
		if(typeof values === 'number') {
			values = [values];
		}

		let dataLength = this.dataLength;
		if(values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}

		let newIndex;
		if(this.recycleVector.length) {
			newIndex = this.recycleVector.pop()[0];
		} else {
			newIndex = Atomics.add(this.firstBlock.data, LENGTH_INDEX, 1);
		}
		
		let dataBlock = this.getFullDataBlock(newIndex);
		let blockIndex = newIndex % this.maxChunkSize;
		dataBlock.set(values, dataLength * blockIndex);

		return newIndex;
	}

	deleteIndex(index: number) {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}
		
		this.recycleVector.push(index);
	}

	clear() {
		this.firstBlock.data[LENGTH_INDEX] = 0;
	}

	*[Symbol.iterator]() {
		let recycledValues = [...this.recycleVector].reduce((array, value) => {
			array.push(...value);
			return array;
		}, [] as Array<number>);

		let dataBlock = this.getFullDataBlock(0);
		let dataBlockIndex = 0;
		for(let i = 0; i < Atomics.load(this.firstBlock.data, LENGTH_INDEX); i++) {
			if(!recycledValues.includes(i)) {
				let newDataBlockIndex = Math.floor(i / this.maxChunkSize);
				if(newDataBlockIndex !== dataBlockIndex) {
					dataBlock = this.getFullDataBlock(i);
					dataBlockIndex = newDataBlockIndex;
				}
				yield this.getDataBlock(dataBlock, i % this.maxChunkSize);
			}
		}
	}

	private getFullDataBlock(index: number) {
		let pointerIndex = Math.floor(index / this.maxChunkSize);
		if(pointerIndex >= this.pointerVector.length) {
			let newArray = this.memory.allocUI32(this.maxChunkSize * this.dataLength);
			this.pointerVector.push(newArray.pointer);
		}

		let array = new AllocatedMemory(this.memory, getPointer(this.pointerVector.get(pointerIndex)));

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
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}
		
		return data;
	}

	private getDataBlock(rawData: T, index: number): T {
		switch(this.type) {
			case TYPE.int32:
				return new Int32Array(rawData.buffer, rawData.byteOffset + index * this.dataLength * 4, this.dataLength) as T;
			case TYPE.uint32:
				return new Uint32Array(rawData.buffer, rawData.byteOffset + index * this.dataLength * 4, this.dataLength) as T;
			case TYPE.float32:
				return new Float32Array(rawData.buffer, rawData.byteOffset + index * this.dataLength * 4, this.dataLength) as T;
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}
	}

	free() {
		this.recycleVector.free();

		for(let pointerArray of this.pointerVector) {
			let pointer = pointerArray[0];
			let memory = new AllocatedMemory(this.memory, getPointer(pointer));
			memory.free();
		}
		this.pointerVector.free();
		this.firstBlock.free();
	}

	getSharedMemory(): SharedPoolMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory()
		};
	}
}

interface SharedPoolConfig<T extends Uint32Array | Int32Array | Float32Array> {
	maxChunkSize?: number
	type?: TypedArrayConstructor<T>
	dataLength?: number
}
interface SharedPoolMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedPoolConfig, SharedPoolMemory };