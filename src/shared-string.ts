import AllocatedMemory from './allocated-memory';
import type { SharedAllocatedMemory } from './allocated-memory';
import { lock, unlock } from './lock/simple-lock';
import type MemoryHeap from './memory-heap';
import { getPointer, loadPointer, loadRawPointer, storeRawPointer } from './utils/pointer';

enum CHAR_TYPE {
	UNDEFINED,
	ASCII,
	UTF16
}
const TYPED_ARRAY_MAP = {
	[CHAR_TYPE.ASCII]: Uint8Array,
	[CHAR_TYPE.UTF16]: Uint16Array
};

const POINTER_INDEX = 0;
const LENGTH_INDEX = 1;
const TYPE_INDEX = 2;
const LOCK_INDEX = 3;
export default class SharedString {
	static readonly ALLOCATE_COUNT = 4;

	private memory: MemoryHeap;
	private allocatedMemory: AllocatedMemory;
	private lock: Int32Array;

	private cachedPointer?: number;
	private cachedString?: string;
	
	constructor(memory: MemoryHeap, value: string | SharedStringConfig | SharedStringMemory) {
		this.memory = memory;

		if(typeof value === 'string') {
			this.allocatedMemory = this.memory.allocUI32(SharedString.ALLOCATE_COUNT);
			this.lock = new Int32Array(this.allocatedMemory.data.buffer, this.allocatedMemory.bufferByteOffset + LOCK_INDEX * this.allocatedMemory.data.BYTES_PER_ELEMENT);
			this.updateString(value);
		} else {
			this.allocatedMemory = new AllocatedMemory(memory, value);
			this.lock = new Int32Array(this.allocatedMemory.data.buffer, this.allocatedMemory.bufferByteOffset + LOCK_INDEX * this.allocatedMemory.data.BYTES_PER_ELEMENT);

			// We only allocated memory but didn't initialize the string yet
			if('value' in value) {
				this.updateString(value.value);
			}
		}
	}
	
	private updateString(value: string) {
		let stringMemory = this.createString(value);

		lock(this.lock);
		storeRawPointer(this.allocatedMemory.data, POINTER_INDEX, stringMemory.pointer);
		Atomics.store(this.allocatedMemory.data, LENGTH_INDEX, value.length);
		Atomics.store(this.allocatedMemory.data, TYPE_INDEX, stringMemory.charType);
		unlock(this.lock);

		this.cachedPointer = stringMemory.pointer;
		this.cachedString = value;
	}
	private createString(value: string) {
		if(value === '') {
			return {
				pointer: 0,
				charType: CHAR_TYPE.ASCII
			};
		}

		let charCodes = [];
		for(let i = 0; i < value.length; i++) {
			charCodes.push(value.charCodeAt(i));
		}

		let maxCharCode = Math.max(...charCodes);
		let charType = maxCharCode > 255 ? CHAR_TYPE.UTF16 : CHAR_TYPE.ASCII;

		let typedArray = TYPED_ARRAY_MAP[charType];
		let allocatedMemory = this.memory.allocUI32(Math.ceil(value.length / (4 / typedArray.BYTES_PER_ELEMENT)));
		let data = new typedArray(allocatedMemory.data.buffer, allocatedMemory.data.byteOffset, value.length);
		for(let i = 0; i < value.length; i++) {
			data[i] = value.charCodeAt(i);
		}

		return {
			pointer: allocatedMemory.pointer,
			charType
		};
	}

	get value(): string {
		let pointer = loadRawPointer(this.allocatedMemory.data, POINTER_INDEX);
		if(this.cachedPointer === pointer && this.cachedString !== undefined) {
			return this.cachedString;
		} else if(pointer === 0) {
			return '';
		}
		let { bufferPosition, bufferByteOffset } = getPointer(pointer);

		lock(this.lock);
		let charType = Atomics.load(this.allocatedMemory.data, TYPE_INDEX) as number;
		// @ts-expect-error
		let typedArray = TYPED_ARRAY_MAP[charType];
		let bufferLength = Atomics.load(this.allocatedMemory.data, LENGTH_INDEX);

		let data = new typedArray(this.memory.buffers[bufferPosition].buf, bufferByteOffset, bufferLength);
		let string = String.fromCharCode.apply(null, data);
		// NOTE: Do not unlock until after transforming the data since the second this is done it can free that memory block
		unlock(this.lock);

		this.cachedPointer = pointer;
		this.cachedString = string;

		return string;
	}
	set value(value: string) {
		let { bufferPosition: oldBufferPosition, bufferByteOffset: oldBufferByteOffset } = loadPointer(this.allocatedMemory.data, POINTER_INDEX);
		this.updateString(value);

		if(oldBufferByteOffset) {
			this.memory.buffers[oldBufferPosition].free(oldBufferByteOffset);
		}
	}

	getSharedMemory(): SharedStringMemory {
		return this.allocatedMemory.getSharedMemory();
	}

	get pointer() {
		return this.allocatedMemory.pointer;
	}

	free() {
		let { bufferPosition, bufferByteOffset } = loadPointer(this.allocatedMemory.data, POINTER_INDEX);
		if(bufferByteOffset) {
			this.memory.buffers[bufferPosition].free(bufferByteOffset);
		}
		this.allocatedMemory.free();
	}
}

interface SharedStringConfig extends SharedStringMemory {
	value: string
}
type SharedStringMemory = SharedAllocatedMemory;