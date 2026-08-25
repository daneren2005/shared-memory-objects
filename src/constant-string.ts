import AllocatedMemory from './allocated-memory';
import type { SharedAllocatedMemory } from './allocated-memory';
import type MemoryHeap from './memory-heap';
import { getPointer, loadRawPointer, storeRawPointer } from './utils/pointer';

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

// An immutable SharedString: the value is written once at construction and never changes
export default class ConstantString {
	static readonly ALLOCATE_COUNT = 3;

	private memory: MemoryHeap;
	private allocatedMemory: AllocatedMemory;

	readonly value: string;

	constructor(memory: MemoryHeap, value: string | SharedAllocatedMemory) {
		this.memory = memory;

		if(typeof value === 'string') {
			this.allocatedMemory = this.memory.allocUI32(ConstantString.ALLOCATE_COUNT);
			this.writeString(value);
			this.value = value;
		} else {
			// A read-only view over a header another thread already wrote.
			this.allocatedMemory = new AllocatedMemory(memory, value);
			this.value = this.readString();
		}
	}

	private writeString(value: string) {
		const stringMemory = this.createString(value);

		storeRawPointer(this.allocatedMemory.data, POINTER_INDEX, stringMemory.pointer);
		Atomics.store(this.allocatedMemory.data, LENGTH_INDEX, value.length);
		Atomics.store(this.allocatedMemory.data, TYPE_INDEX, stringMemory.charType);
	}

	private readString(): string {
		let pointer = loadRawPointer(this.allocatedMemory.data, POINTER_INDEX);
		if(pointer === 0) {
			return '';
		}
		let { bufferPosition, bufferByteOffset } = getPointer(pointer, this.memory.positionBits);

		// No lock: the value never changes after it is written once, so the memory it points at is never freed or
		// rewritten underneath us.
		let charType = Atomics.load(this.allocatedMemory.data, TYPE_INDEX);
		// @ts-expect-error
		let typedArray = TYPED_ARRAY_MAP[charType];
		let bufferLength = Atomics.load(this.allocatedMemory.data, LENGTH_INDEX);

		let data = new typedArray(this.memory.buffers[bufferPosition].buf, bufferByteOffset, bufferLength);
		return fromCharCodes(data);
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

	getSharedMemory(): SharedAllocatedMemory {
		return this.allocatedMemory.getSharedMemory();
	}

	get pointer() {
		return this.allocatedMemory.pointer;
	}

	free() {
		let pointer = loadRawPointer(this.allocatedMemory.data, POINTER_INDEX);
		if(pointer) {
			let { bufferPosition, bufferByteOffset } = getPointer(pointer, this.memory.positionBits);
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
