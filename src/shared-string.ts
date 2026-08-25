import AllocatedMemory from './allocated-memory';
import type { SharedAllocatedMemory } from './allocated-memory';
import { lock, unlock } from './lock/simple-lock';
import type MemoryHeap from './memory-heap';
import { getPointer, loadPointer, loadRawPointer, storeRawPointer } from './utils/pointer';

enum CHAR_TYPE {
	UNDEFINED,
	ASCII,
	UTF16,
}
const TYPED_ARRAY_MAP = {
	[CHAR_TYPE.ASCII]: Uint8Array,
	[CHAR_TYPE.UTF16]: Uint16Array,
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
				charType: CHAR_TYPE.ASCII,
			};
		}

		// NOTE: Scan with a loop instead of Math.max(...charCodes) which blows the stack for large strings
		let maxCharCode = 0;
		for(let i = 0; i < value.length; i++) {
			let charCode = value.charCodeAt(i);
			if(charCode > maxCharCode) {
				maxCharCode = charCode;
			}
		}
		let charType = maxCharCode > 255 ? CHAR_TYPE.UTF16 : CHAR_TYPE.ASCII;

		let typedArray = TYPED_ARRAY_MAP[charType];
		let allocatedMemory = this.memory.allocUI32(Math.ceil(value.length / (4 / typedArray.BYTES_PER_ELEMENT)));
		let data = new typedArray(allocatedMemory.data.buffer as ArrayBuffer, allocatedMemory.data.byteOffset, value.length);
		for(let i = 0; i < value.length; i++) {
			data[i] = value.charCodeAt(i);
		}

		return {
			pointer: allocatedMemory.pointer,
			charType,
		};
	}

	get value(): string {
		let pointer = loadRawPointer(this.allocatedMemory.data, POINTER_INDEX);
		if(this.cachedPointer === pointer && this.cachedString !== undefined) {
			return this.cachedString;
		} else if(pointer === 0) {
			return '';
		}
		let { bufferPosition, bufferByteOffset } = getPointer(pointer, this.memory.positionBits);

		lock(this.lock);
		let charType = Atomics.load(this.allocatedMemory.data, TYPE_INDEX);
		// @ts-expect-error
		let typedArray = TYPED_ARRAY_MAP[charType];
		let bufferLength = Atomics.load(this.allocatedMemory.data, LENGTH_INDEX);

		let data = new typedArray(this.memory.buffers[bufferPosition].buf, bufferByteOffset, bufferLength);
		let string = fromCharCodes(data);
		// NOTE: Do not unlock until after transforming the data since the second this is done it can free that memory block
		unlock(this.lock);

		this.cachedPointer = pointer;
		this.cachedString = string;

		return string;
	}
	set value(value: string) {
		let { bufferPosition: oldBufferPosition, bufferByteOffset: oldBufferByteOffset } = loadPointer(this.allocatedMemory.data, POINTER_INDEX, this.memory.positionBits);
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
		let { bufferPosition, bufferByteOffset } = loadPointer(this.allocatedMemory.data, POINTER_INDEX, this.memory.positionBits);
		if(bufferByteOffset) {
			this.memory.buffers[bufferPosition].free(bufferByteOffset);
		}
		this.allocatedMemory.free();
	}
}

// String.fromCharCode.apply throws a RangeError (Maximum call stack size exceeded) when handed too many
// arguments at once, so decode large buffers in chunks to support arbitrarily long strings
function fromCharCodes(data: Uint8Array | Uint16Array): string {
	const CHUNK_SIZE = 8192;
	if(data.length <= CHUNK_SIZE) {
		return String.fromCharCode.apply(null, data as unknown as Array<number>);
	}

	let string = '';
	for(let i = 0; i < data.length; i += CHUNK_SIZE) {
		string += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK_SIZE) as unknown as Array<number>);
	}

	return string;
}

interface SharedStringConfig extends SharedStringMemory {
	value: string
}
type SharedStringMemory = SharedAllocatedMemory;