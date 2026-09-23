const buffer = new ArrayBuffer(8);
const int64Array = new BigInt64Array(buffer);
const int16Array = new Int16Array(buffer);

export function load16From64Int(data: BigInt64Array, index: number): [number, number, number, number] {
	return convert64To16Int(Atomics.load(data, index));
}

export function store16In64Int(data: BigInt64Array, index: number, value1: number, value2: number, value3: number, value4: number = 0) {
	Atomics.store(data, index, convert16To64Int(value1, value2, value3, value4));
}

export function convert64To16Int(value: bigint): [number, number, number, number] {
	int64Array[0] = value;

	return [int16Array[0], int16Array[1], int16Array[2], int16Array[3]];
}

export function convert16To64Int(value1: number, value2: number, value3: number, value4: number = 0): bigint {
	int16Array[0] = value1;
	int16Array[1] = value2;
	int16Array[2] = value3;
	int16Array[3] = value4;

	return int64Array[0];
}
