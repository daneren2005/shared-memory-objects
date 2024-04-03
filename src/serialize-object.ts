import AllocatedMemory from './allocated-memory';
import type MemoryHeap from './memory-heap';
import { getPointer } from './utils/pointer';

enum VALUE_TYPE {
	UNDEFINED,
	NUMBER,
	STRING
}

// Be able to serialize a simple object into memory and re-create the object in another thread
// This does NOT support updating objects across threads
const MAGIC_NUMBER = 52361700;
export function serializeObjectToMemory<T extends object>(heap: MemoryHeap, object: T): AllocatedMemory {
	const data: Array<number> = [];
	const keys = Object.keys(object);
	data.push(MAGIC_NUMBER);
	data.push(keys.length);

	// Create index first so we can quickly construct index
	let keyIndexes: { [key:string]:number } = {};
	keys.forEach(key => {
		data.push(key.length);
		addCharCodes(data, key);

		keyIndexes[key] = data.length;
		data.push(0);
	});

	keys.forEach(key => {
		let keyIndex = keyIndexes[key];
		// @ts-expect-error
		let value = object[key];
		if(Number.isFinite(value)) {
			data[keyIndex] = data.length;
			data.push(VALUE_TYPE.NUMBER);
			data.push(value);
		} else if(typeof value === 'string') {
			data[keyIndex] = data.length;
			data.push(VALUE_TYPE.STRING);
			data.push(value.length);
			addCharCodes(data, value);
		}
	});
	
	let memory = heap.allocUI32(data.length);
	let sharedData = memory.getArray(Float32Array, 0, data.length);
	sharedData.set(data);

	return memory;
}

export function createObjectFromPointer<T extends object>(heap: MemoryHeap, pointer: number) {
	let memory = new AllocatedMemory(heap, getPointer(pointer));
	return createObjectFromMemory<T>(memory);
}
export function createObjectFromMemory<T extends object>(memory: AllocatedMemory): T {
	let sharedData = new Float32Array(memory.data.buffer, memory.bufferByteOffset);
	if(sharedData[0] !== MAGIC_NUMBER) {
		throw new Error('Trying to create object from invalid memory location');
	}

	const sharedObject: { [key:string]:any } = {};
	const keyCount = sharedData[1];
	let keyStartIndex = 2;
	for(let i = 0; i < keyCount; i++) {
		let keyLength = sharedData[keyStartIndex];
		let keyData = new Float32Array(memory.data.buffer, memory.bufferByteOffset + (keyStartIndex + 1) * sharedData.BYTES_PER_ELEMENT, keyLength);
		let key = String.fromCharCode.apply(null, [...keyData]);
		let valueIndex = sharedData[keyStartIndex + keyLength + 1];
		let valueType = sharedData[valueIndex];
		switch(valueType) {
			case VALUE_TYPE.NUMBER: {
				sharedObject[key] = sharedData[valueIndex + 1];
				break;
			}
			case VALUE_TYPE.STRING: {
				let length = sharedData[valueIndex + 1];
				let valueData = new Float32Array(memory.data.buffer, memory.bufferByteOffset + (valueIndex + 2) * sharedData.BYTES_PER_ELEMENT, length);
				sharedObject[key] = String.fromCharCode.apply(null, [...valueData]);
				break;
			}
		}

		keyStartIndex += 2 + keyLength;
	}

	return sharedObject as T;
}

function addCharCodes(data: Array<number>, value: string) {
	for(let i = 0; i < value.length; i++) {
		data.push(value.charCodeAt(i));
	}
}