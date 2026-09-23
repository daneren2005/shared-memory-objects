const buffer = new ArrayBuffer(8);
const uint64Array = new BigUint64Array(buffer);
const uint16Array = new Uint16Array(buffer);

export function load16From64Uint(data: BigUint64Array, index: number): [number, number, number, number] {
	return convert64To16Uint(Atomics.load(data, index));
}

export function store16In64Uint(data: BigUint64Array, index: number, value1: number, value2: number, value3: number, value4: number = 0) {
	Atomics.store(data, index, convert16To64Uint(value1, value2, value3, value4));
}

export function convert64To16Uint(value: bigint): [number, number, number, number] {
	uint64Array[0] = value;

	return [uint16Array[0], uint16Array[1], uint16Array[2], uint16Array[3]];
}

export function convert16To64Uint(value1: number, value2: number, value3: number, value4: number = 0): bigint {
	uint16Array[0] = value1;
	uint16Array[1] = value2;
	uint16Array[2] = value3;
	uint16Array[3] = value4;

	return uint64Array[0];
}
