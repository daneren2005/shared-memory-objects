import type { TypedArray } from './interfaces/typed-array';
import type { TypedArrayConstructor } from './interfaces/typed-array-constructor';
import type MemoryBuffer from './memory-buffer';
import type MemoryHeap from './memory-heap';
import { createPointer } from './utils/pointer';

export default class AllocatedMemory {
	private readonly memory: MemoryHeap;

	readonly bufferPosition: number;
	get bufferByteOffset(): number {
		return this.data.byteOffset;
	}
	get pointer(): number {
		return createPointer(this.bufferPosition, this.bufferByteOffset);
	}
	private buffer: MemoryBuffer;
	data: Uint32Array;

	constructor(memory: MemoryHeap, config: AllocatedMemoryConfig | SharedAllocatedMemory) {
		this.memory = memory;

		if('buffer' in config) {
			this.data = config.data;
			this.buffer = config.buffer;
			this.bufferPosition = this.memory.buffers.indexOf(config.buffer);
		} else {
			this.bufferPosition = config.bufferPosition;
			this.buffer = memory.buffers[config.bufferPosition];

			// Making sure these are the correct size is slow but in dev we want to make sure we aren't allowing to go out of bounds
			if(import.meta.env.MODE === 'production') {
				this.data = new Uint32Array(this.buffer.buf, config.bufferByteOffset);
			} else {
				this.data = new Uint32Array(this.buffer.buf, config.bufferByteOffset, this.buffer.lengthOf(config.bufferByteOffset));
			}
		}
	}

	getArray<T extends TypedArray>(type: TypedArrayConstructor<T>, offset: number, length: number): T {
		if(import.meta.env.MODE === 'development' || import.meta.env.MODE === 'test') {
			if((offset + length) * type.BYTES_PER_ELEMENT > this.data.byteLength) {
				const message = `Trying to grab more memory from AllocatedMemory.getArray then we have: ${offset * type.BYTES_PER_ELEMENT} + ${length * type.BYTES_PER_ELEMENT} > ${this.data.byteLength}`;
				if(import.meta.env.MODE === 'test') {
					throw new Error(message);
				} else {
					console.warn(message);
				}
			}
		}

		return new type(this.data.buffer, this.data.byteOffset + offset * type.BYTES_PER_ELEMENT, length);
	}
	getArrayMemory(offset: number, length: number): SharedAllocatedMemory {
		if(import.meta.env.MODE === 'development') {
			if(offset + length > this.data.length) {
				console.warn(`Trying to grab more memory from AllocatedMemory.getArrayMemory then we have: ${offset} + ${length} > ${this.data.length}`);
			}
		}

		return {
			bufferPosition: this.bufferPosition,
			bufferByteOffset: this.bufferByteOffset + offset * this.data.BYTES_PER_ELEMENT
		};
	}

	free() {
		// NOTE: From worker thread you can't pass the array, you have to pass an explicit address to free
		this.buffer.free(this.data.byteOffset);
	}

	getSharedMemory(): SharedAllocatedMemory {
		return {
			bufferPosition: this.bufferPosition,
			bufferByteOffset: this.bufferByteOffset
		};
	}
}

interface AllocatedMemoryConfig {
	data: Uint32Array
	buffer: MemoryBuffer
}

interface SharedAllocatedMemory {
	bufferPosition: number
	bufferByteOffset: number
}
export type { SharedAllocatedMemory };