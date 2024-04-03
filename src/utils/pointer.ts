// bottom 12 bits (4096) for bufferPosition
// top 20 bits (1MB) for bufferByteOffset
const BYTE_OFFSET_BIT_COUNT = 20;
const POSITION_BIT_COUNT = 32 - BYTE_OFFSET_BIT_COUNT;
const MAX_BYTE_OFFSET_LENGTH = Math.pow(2, BYTE_OFFSET_BIT_COUNT);
const MAX_POSITION_LENGTH = Math.pow(2, POSITION_BIT_COUNT);

export function loadPointer(data: Uint32Array, index: number = 0) {
	return getPointer(Atomics.load(data, index));
}
export function loadRawPointer(data: Uint32Array, index: number = 0) {
	return Atomics.load(data, index);
}

export function storePointer(data: Uint32Array, index: number = 0, bufferPosition: number, bufferByteOffset: number) {
	Atomics.store(data, index, createPointer(bufferPosition, bufferByteOffset));
}
export function storeRawPointer(data: Uint32Array, index: number = 0, pointer: number) {
	Atomics.store(data, index, pointer);
}

export function replacePointer(data: Uint32Array, index: number, newBufferPosition: number, newBufferByteOffset: number, oldBufferPosition: number, oldBufferByteOffset: number) {
	let oldPointer = createPointer(oldBufferPosition, oldBufferByteOffset);
	return Atomics.compareExchange(data, index, oldPointer, createPointer(newBufferPosition, newBufferByteOffset)) === oldPointer;
}
export function replaceRawPointer(data: Uint32Array, index: number, newPointer: number, oldPointer: number): boolean {
	return Atomics.compareExchange(data, index, oldPointer, newPointer) === oldPointer;
}

export function getPointer(value: number) {
	return {
		bufferPosition: value & 0b00000000000000000000111111111111,
		bufferByteOffset: value >>> POSITION_BIT_COUNT
	};
}
export function createPointer(bufferPosition: number, bufferByteOffset: number) {
	return bufferPosition + (bufferByteOffset << POSITION_BIT_COUNT);
}

export { BYTE_OFFSET_BIT_COUNT, POSITION_BIT_COUNT, MAX_BYTE_OFFSET_LENGTH, MAX_POSITION_LENGTH };