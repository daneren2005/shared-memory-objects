const buffer = new ArrayBuffer(8);
const int64Array = new BigInt64Array(buffer);
const int32Array = new Int32Array(buffer);

export function load32From64Int(data: BigInt64Array, index: number): [number, number] {
	return convert64To32Int(Atomics.load(data, index));
}

export function store32In64Int(data: BigInt64Array, index: number, value1: number, value2: number) {
	Atomics.store(data, index, convert32To64Int(value1, value2));
}

export function convert64To32Int(value: bigint): [number, number] {
	int64Array[0] = value;

	return [int32Array[0], int32Array[1]];
}

export function convert32To64Int(value1: number, value2: number): bigint {
	int32Array[0] = value1;
	int32Array[1] = value2;

	return int64Array[0];
}
