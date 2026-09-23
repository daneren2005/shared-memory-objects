const buffer = new ArrayBuffer(8);
const uint64Array = new BigUint64Array(buffer);
const uint32Array = new Uint32Array(buffer);

export function load32From64Uint(data: BigUint64Array, index: number): [number, number] {
	return convert64To32Uint(Atomics.load(data, index));
}

export function store32In64Uint(data: BigUint64Array, index: number, value1: number, value2: number) {
	Atomics.store(data, index, convert32To64Uint(value1, value2));
}

export function convert64To32Uint(value: bigint): [number, number] {
	uint64Array[0] = value;

	return [uint32Array[0], uint32Array[1]];
}

export function convert32To64Uint(value1: number, value2: number): bigint {
	uint32Array[0] = value1;
	uint32Array[1] = value2;

	return uint64Array[0];
}
