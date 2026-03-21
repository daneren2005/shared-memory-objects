import AllocatedMemory from './allocated-memory';
import type { TypedArrayConstructor } from './interfaces/typed-array-constructor';
import type MemoryHeap from './memory-heap';
import { getPointer } from './utils/pointer';

// Array with stable indexes and maximum contiguous memory sizes (necessary to fit large data sets into max 1MB buffers)
// Can only do insert/deletions from a single thread - useful if other threads are known to be read-only
export default class LocalPool<T extends Uint32Array | Int32Array | Float32Array | Float64Array = Uint32Array> implements Iterable<T> {
	private memory: MemoryHeap;
	private pointers: Array<number> = [];
	private recycledIndexes: Array<number> = [];
	private totalLength = 0;
	readonly maxChunkSize: number = 100;
	readonly dataLength: number = 1;
	readonly byteMultipler: number = 1;
	private typeConstructor: TypedArrayConstructor<T>;
	private fullDataBlocks: { [key: number]: T } = {};

	get length(): number {
		return this.totalLength - this.recycledIndexes.length;
	}
	get bufferLength(): number {
		return this.maxChunkSize * this.pointers.length;
	}

	constructor(memory: MemoryHeap, config: LocalPoolConfig<T>) {
		this.memory = memory;

		const dataLength = config?.dataLength ?? 1;
		const maxLength = config?.maxChunkSize ?? 100;
		this.dataLength = dataLength;
		this.maxChunkSize = maxLength;

		this.typeConstructor = config.type;
		// @ts-expect-error
		if(this.typeConstructor === Float64Array) {
			this.byteMultipler = 2;
		}

		let firstArray = memory.allocUI32(maxLength * dataLength * this.byteMultipler);
		this.pointers.push(firstArray.pointer);
		let data: T = new this.typeConstructor(firstArray.data.buffer, firstArray.bufferByteOffset, this.dataLength * this.maxChunkSize) as T;
		this.fullDataBlocks[0] = data;
	}

	at(index: number): T {
		let dataBlock = this.fullDataBlocks[Math.floor(index / this.maxChunkSize)];
		return this.getDataBlock(dataBlock, index % this.maxChunkSize);
	}
	get(index: number, dataIndex = 0): number {
		const dataLength = this.dataLength;
		if(dataIndex >= dataLength) {
			throw new Error(`${dataIndex} is out of dataLength bounds ${dataLength}`);
		}

		let dataBlock = this.fullDataBlocks[Math.floor(index / this.maxChunkSize)];
		return dataBlock[(index % this.maxChunkSize) * dataLength + dataIndex];
	}

	push(values: number | Array<number>): number {
		const isSingleNumber = typeof values === 'number';
		if(!isSingleNumber && values.length > this.dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${this.dataLength} dataLength`);
		}

		let newIndex = this.recycledIndexes.pop();
		if(newIndex === undefined) {
			newIndex = this.totalLength++;
		}
		
		
		let pointerIndex = Math.floor(newIndex / this.maxChunkSize);
		if(pointerIndex >= this.pointers.length) {
			let newArray = this.memory.allocUI32(this.maxChunkSize * this.dataLength * this.byteMultipler);
			this.pointers.push(newArray.pointer);
			let data: T = new this.typeConstructor(newArray.data.buffer, newArray.bufferByteOffset, this.dataLength * this.maxChunkSize) as T;
			this.fullDataBlocks[pointerIndex] = data;
		}

		let dataBlock = this.fullDataBlocks[pointerIndex];
		let blockIndex = newIndex % this.maxChunkSize;
		let startIndex = this.dataLength * blockIndex;
		if(isSingleNumber) {
			dataBlock[startIndex] = values;
		} else {
			dataBlock.set(values, startIndex);
		}

		return newIndex;
	}

	deleteIndex(index: number) {
		this.recycledIndexes.push(index);
	}

	clear() {
		this.totalLength = 0;
		this.recycledIndexes = [];
	}

	*[Symbol.iterator]() {
		const recycledValues: { [key: number]: true } = {};
		for(let value of this.recycledIndexes) {
			recycledValues[value] = true;
		}

		let dataBlock = this.getFullDataBlock(0);
		let dataBlockIndex = 0;
		for(let i = 0; i < this.totalLength; i++) {
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

	private getFullDataBlock(index: number) {
		let pointerIndex = Math.floor(index / this.maxChunkSize);
		let cachedDataBlock = this.fullDataBlocks[pointerIndex];
		if(cachedDataBlock) {
			return cachedDataBlock;
		}
		if(pointerIndex >= this.pointers.length) {
			let newArray = this.memory.allocUI32(this.maxChunkSize * this.dataLength * this.byteMultipler);
			this.pointers.push(newArray.pointer);
		}

		let array = new AllocatedMemory(this.memory, getPointer(this.pointers[pointerIndex]));
		let data: T = new this.typeConstructor(array.data.buffer, array.bufferByteOffset, this.dataLength * this.maxChunkSize) as T;
		this.fullDataBlocks[pointerIndex] = data;
		return data;
	}

	private getDataBlock(rawData: T, index: number): T {
		const start = index * this.dataLength;
		return rawData.subarray(start, start + this.dataLength) as T;
	}

	free() {
		for(let pointer of this.pointers) {
			let memory = new AllocatedMemory(this.memory, getPointer(pointer));
			memory.free();
		}
		this.pointers = [];
		this.recycledIndexes = [];
		this.totalLength = 0;
		this.fullDataBlocks = {};
	}
}

interface LocalPoolConfig<T extends Uint32Array | Int32Array | Float32Array | Float64Array> {
	maxChunkSize?: number
	type: TypedArrayConstructor<T>
	dataLength?: number
}
export type { LocalPoolConfig };