const buffer = new ArrayBuffer(8);
const float64Array = new Float64Array(buffer);
const float32Array = new Float32Array(buffer);
const int64Array = new BigInt64Array(buffer);

export function load32From64Float(data: Float64Array, index: number): [number, number] {
	const atomicData = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	int64Array[0] = Atomics.load(atomicData, index);
	return [float32Array[0], float32Array[1]];
}

export function store32In64Float(data: Float64Array, index: number, value1: number, value2: number) {
	const atomicData = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	float32Array[0] = value1;
	float32Array[1] = value2;
	Atomics.store(atomicData, index, int64Array[0]);
}

export function convert64To32Float(value: number): [number, number] {
	float64Array[0] = value;
	return [float32Array[0], float32Array[1]];
}

export function convert32To64Float(value1: number, value2: number): number {
	float32Array[0] = value1;
	float32Array[1] = value2;
	return float64Array[0];
}
