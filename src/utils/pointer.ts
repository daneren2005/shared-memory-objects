// A pointer packs (bufferByteOffset, bufferPosition) into one u32: the low `positionBits` bits hold the buffer position,
// the high `32 - positionBits` bits hold the byte offset within that buffer. The split is per-heap (derived from the
// heap's bufferSize) so a heap with larger buffers trades buffer count for buffer size while keeping the full 32-bit
// (4GB) address space. `positionBits` defaults to DEFAULT_POSITION_BITS so callers that predate the per-heap split keep
// working on default-sized heaps.

// bottom 12 bits (4096) for bufferPosition, top 20 bits (1MB) for bufferByteOffset
const BYTE_OFFSET_BIT_COUNT = 20;
const POSITION_BIT_COUNT = 32 - BYTE_OFFSET_BIT_COUNT;
const DEFAULT_POSITION_BITS = POSITION_BIT_COUNT;
const MAX_BYTE_OFFSET_LENGTH = Math.pow(2, BYTE_OFFSET_BIT_COUNT);
const MAX_POSITION_LENGTH = Math.pow(2, POSITION_BIT_COUNT);

// Smallest byte-offset bit count that can address a buffer of `bufferSize` bytes, and the resulting position bits.
export function positionBitsForBufferSize(bufferSize: number): number {
	let offsetBits = bufferSize <= 1 ? 0 : 32 - Math.clz32(bufferSize - 1);
	let positionBits = 32 - offsetBits;
	if(positionBits < 1) {
		throw new Error(`Buffer size ${bufferSize} leaves no bits for buffer position (max ${Math.pow(2, 31)})`);
	}
	return positionBits;
}

export function loadPointer(data: Uint32Array, index: number = 0, positionBits: number = DEFAULT_POSITION_BITS) {
	return getPointer(Atomics.load(data, index), positionBits);
}
export function loadRawPointer(data: Uint32Array, index: number = 0) {
	return Atomics.load(data, index);
}

export function storePointer(data: Uint32Array, index: number = 0, bufferPosition: number, bufferByteOffset: number, positionBits: number = DEFAULT_POSITION_BITS) {
	Atomics.store(data, index, createPointer(bufferPosition, bufferByteOffset, positionBits));
}
export function storeRawPointer(data: Uint32Array, index: number = 0, pointer: number) {
	Atomics.store(data, index, pointer);
}

export function replacePointer(
	data: Uint32Array,
	index: number,
	newBufferPosition: number,
	newBufferByteOffset: number,
	oldBufferPosition: number,
	oldBufferByteOffset: number,
	positionBits: number = DEFAULT_POSITION_BITS,
) {
	let oldPointer = createPointer(oldBufferPosition, oldBufferByteOffset, positionBits);
	return Atomics.compareExchange(data, index, oldPointer, createPointer(newBufferPosition, newBufferByteOffset, positionBits)) === oldPointer;
}
export function replaceRawPointer(data: Uint32Array, index: number, newPointer: number, oldPointer: number): boolean {
	return Atomics.compareExchange(data, index, oldPointer, newPointer) === oldPointer;
}

export function getPointer(value: number, positionBits: number = DEFAULT_POSITION_BITS) {
	return {
		bufferPosition: value & ((1 << positionBits) - 1),
		bufferByteOffset: value >>> positionBits,
	};
}
export function createPointer(bufferPosition: number, bufferByteOffset: number, positionBits: number = DEFAULT_POSITION_BITS) {
	return bufferPosition + (bufferByteOffset << positionBits);
}

export { BYTE_OFFSET_BIT_COUNT, POSITION_BIT_COUNT, DEFAULT_POSITION_BITS, MAX_BYTE_OFFSET_LENGTH, MAX_POSITION_LENGTH };
