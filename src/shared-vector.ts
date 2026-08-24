import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import type MemoryHeap from './memory-heap';
import { getPointer, loadPointer, storePointer, storeRawPointer } from './utils/pointer';
import { getArrayTypeCode, getByteMultipler, makeArrayView, type NumericArray, type NumericArrayIO, type TypedArrayConstructor } from './utils/array-type';

const VECTOR_INDEX = 0;
const LENGTH_INDEX = 1;
const BUFFER_LENGTH_INDEX = 2;
const TYPE_INDEX = 3;
const DEFAULT_SIZE = 4;
export default class SharedVector<T extends NumericArray = Uint32Array> implements Iterable<T> {
	static readonly ALLOCATE_COUNT = 4;
	private memory: MemoryHeap;

	// Pointer, List Length, Buffer Length, Type/DataLength
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;
	// u32 units per element: 1 for 32-bit types, 2 for 64-bit (float64/int64/uint64). Every data-block allocation scales
	// by this; the typed view length stays in elements.
	private cachedByteMultipler = 1;

	get length(): number {
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX);
	}
	
	get type(): number {
		return this.uint16Array[0];
	}
	private set type(value: number) {
		Atomics.store(this.uint16Array, 0, value);
	}
	get byteMultipler(): number {
		return this.cachedByteMultipler;
	}
	get dataLength(): number {
		// Can technically be initialized by passing memory without actually every being called - need to make sure dataLength is always at least one
		return this.uint16Array[1] || 1;
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

	get usedMemory(): number {
		let dataMemory = new AllocatedMemory(this.memory, loadPointer(this.firstBlock.data, VECTOR_INDEX));
		return this.firstBlock.usedMemory + dataMemory.usedMemory;
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
				const typeCode = getArrayTypeCode(config.type ?? Uint32Array);
				const byteMultipler = getByteMultipler(typeCode);
				const bufferLength = config.bufferLength ?? DEFAULT_SIZE;
				let dataBlock = memory.allocUI32(bufferLength * (config.dataLength ?? 1) * byteMultipler);
				storePointer(this.firstBlock.data, VECTOR_INDEX, dataBlock.bufferPosition, dataBlock.bufferByteOffset);
				this.bufferLength = bufferLength;
				this.dataLength = (config.dataLength ?? 1);
				this.type = typeCode;
			}
		} else {
			this.firstBlock = memory.allocUI32(SharedVector.ALLOCATE_COUNT);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			let dataLength = config?.dataLength ?? 1;
			let bufferLength = config?.bufferLength ?? DEFAULT_SIZE;
			let typeCode = getArrayTypeCode(config?.type ?? Uint32Array);
			let dataBlock = memory.allocUI32(bufferLength * dataLength * getByteMultipler(typeCode));
			storePointer(this.firstBlock.data, VECTOR_INDEX, dataBlock.bufferPosition, dataBlock.bufferByteOffset);
			this.bufferLength = bufferLength;
			this.type = typeCode;
			this.dataLength = dataLength;
		}

		this.cachedByteMultipler = getByteMultipler(this.type);
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
	get(index: number, dataIndex = 0): T[number] {
		if(dataIndex >= this.dataLength) {
			throw new Error(`${dataIndex} is out of dataLength bounds ${this.dataLength}`);
		} else if(index >= this.length || index < 0) {
			throw new Error(`${index} is out of bounds ${this.length}`);
		}

		let dataBlock = this.getFullDataBlock() as NumericArrayIO;
		return dataBlock[index * this.dataLength + dataIndex];
	}

	push(values: T[number] | Array<T[number]>): number {
		let dataLength = this.dataLength;
		const isSingleValue = typeof values !== 'object';
		if(!isSingleValue && values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}

		let dataBlock = this.getFullDataBlock() as NumericArrayIO;
		let currentLength = this.length;
		let startIndex = dataLength * currentLength;
		if(isSingleValue) {
			dataBlock[startIndex] = values;
		} else {
			for(let i = 0; i < values.length; i++) {
				dataBlock[startIndex + i] = values[i];
			}
		}

		let newLength = Atomics.add(this.firstBlock.data, LENGTH_INDEX, 1) + 1;
		if(newLength >= this.bufferLength) {
			this.growBuffer();
		}

		return currentLength;
	}

	pop(): T {
		let oldLength = Atomics.sub(this.firstBlock.data, LENGTH_INDEX, 1);

		let dataBlock = this.getFullDataBlock();
		return this.getDataBlock(dataBlock, oldLength - 1);
	}

	// Returns the first number irregardless of dataLength - faster way to pop if you don't care about the rest of the data block
	popNumber(): T[number] {
		const oldLength = Atomics.sub(this.firstBlock.data, LENGTH_INDEX, 1);
		const dataBlock = this.getFullDataBlock() as NumericArrayIO;
		return dataBlock[(oldLength - 1) * this.dataLength];
	}

	deleteIndex(index: number) {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}

		let dataLength = this.dataLength;
		let dataBlock = this.getFullDataBlock() as NumericArrayIO;
		for(let i = index; i < length; i++) {
			for(let j = 0; j < dataLength; j++) {
				dataBlock[i * dataLength + j] = dataBlock[(i + 1) * dataLength + j];
			}
		}

		Atomics.sub(this.firstBlock.data, LENGTH_INDEX, 1);
	}

	clear() {
		this.firstBlock.data[LENGTH_INDEX] = 0;
	}

	*[Symbol.iterator]() {
		let dataBlock = this.getFullDataBlock();
		let dataLength = this.dataLength;
		let totalDataEntries = this.length * dataLength;

		for(let i = 0; i < totalDataEntries; i += dataLength) {
			yield dataBlock.subarray(i, i + dataLength) as T;
		}
	}

	// Significantly faster but won't be thread safe if anything is removing/adding to it during iteration
	getCurrentArray(): T {
		let dataBlock = this.getFullDataBlock();
		return dataBlock.subarray(0, this.length * this.dataLength) as T;
	}

	private getFullDataBlock(): T {
		let pointerNumber = Atomics.load(this.firstBlock.data, VECTOR_INDEX);
		if(this.cachedPointer === pointerNumber && this.cachedFullDataBlock) {
			return this.cachedFullDataBlock;
		}

		let pointer = getPointer(pointerNumber);
		let rawData = new AllocatedMemory(this.memory, pointer);

		let data = makeArrayView(this.type, rawData.data.buffer, rawData.bufferByteOffset, this.dataLength * this.bufferLength) as T;

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
		let newDataBlock = this.memory.allocUI32(newBufferLength * dataLength * this.cachedByteMultipler);

		let newData = makeArrayView(this.type, newDataBlock.data.buffer, newDataBlock.bufferByteOffset, dataLength * newBufferLength) as T;

		// newData and oldDataBlock are the same concrete view type, so a direct copy is valid; the cast only bridges the
		// union's mutually-incompatible set() overloads (number vs bigint element types)
		(newData as Float64Array).set(oldDataBlock as unknown as Float64Array);

		const newPointer = newDataBlock.pointer;
		storeRawPointer(this.firstBlock.data, VECTOR_INDEX, newPointer);
		this.bufferLength = newBufferLength;
		oldDataMemory.free();

		this.cachedPointer = newPointer;
		this.cachedFullDataBlock = newData;
	}

	free() {
		let pointer = loadPointer(this.firstBlock.data, VECTOR_INDEX);
		let dataMemory = new AllocatedMemory(this.memory, pointer);

		dataMemory.free();
		this.firstBlock.free();
	}

	getSharedMemory(): SharedVectorMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}
}

interface SharedVectorConfig<T extends NumericArray> {
	type?: TypedArrayConstructor<T>
	dataLength?: number

	bufferLength?: number
}
interface SharedVectorMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedVectorConfig, SharedVectorMemory };