const buffer = new ArrayBuffer(4);
const uint32Array = new Uint32Array(buffer);
const uint16Array = new Uint16Array(buffer);

export function load16From32Uint(data: Uint32Array, index: number): [number, number] {
	return convert32To16Uint(Atomics.load(data, index));
}

export function store16In32Uint(data: Uint32Array, index: number, value1: number, value2: number) {
	Atomics.store(data, index, convert16To32Uint(value1, value2));
}

export function convert32To16Uint(value: number): [number, number] {
	uint32Array[0] = value;

	return [uint16Array[0], uint16Array[1]];
}

export function convert16To32Uint(value1: number, value2: number): number {
	uint16Array[0] = value1;
	uint16Array[1] = value2;

	return uint32Array[0];
}
