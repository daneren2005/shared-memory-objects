const buffer = new ArrayBuffer(8);
const float64Array = new Float64Array(buffer);
const int64Array = new BigInt64Array(buffer);
const float16Array = new Float16Array(buffer);

export function load16From64Float(data: Float64Array, index: number): [number, number, number, number] {
	const atomicData = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	int64Array[0] = Atomics.load(atomicData, index);
	return [float16Array[0], float16Array[1], float16Array[2], float16Array[3]];
}

export function store16In64Float(data: Float64Array, index: number, value1: number, value2: number, value3: number, value4: number = 0) {
	const atomicData = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	float16Array[0] = value1;
	float16Array[1] = value2;
	float16Array[2] = value3;
	float16Array[3] = value4;
	Atomics.store(atomicData, index, int64Array[0]);
}

export function convert64To16Float(value: number): [number, number, number, number] {
	float64Array[0] = value;
	return [float16Array[0], float16Array[1], float16Array[2], float16Array[3]];
}

export function convert16To64Float(value1: number, value2: number, value3: number, value4: number = 0): number {
	float16Array[0] = value1;
	float16Array[1] = value2;
	float16Array[2] = value3;
	float16Array[3] = value4;
	return float64Array[0];
}
