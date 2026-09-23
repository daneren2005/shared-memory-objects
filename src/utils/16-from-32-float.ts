const buffer = new ArrayBuffer(4);
const float32Array = new Float32Array(buffer);
const int32Array = new Int32Array(buffer);
const float16Array = new Float16Array(buffer);

export function load16From32Float(data: Float32Array, index: number): [number, number] {
	const atomicData = new Int32Array(data.buffer, data.byteOffset, data.length);
	int32Array[0] = Atomics.load(atomicData, index);
	return [float16Array[0], float16Array[1]];
}

export function store16In32Float(data: Float32Array, index: number, value1: number, value2: number) {
	const atomicData = new Int32Array(data.buffer, data.byteOffset, data.length);
	float16Array[0] = value1;
	float16Array[1] = value2;
	Atomics.store(atomicData, index, int32Array[0]);
}

export function convert32To16Float(value: number): [number, number] {
	float32Array[0] = value;
	return [float16Array[0], float16Array[1]];
}

export function convert16To32Float(value1: number, value2: number): number {
	float16Array[0] = value1;
	float16Array[1] = value2;
	return float32Array[0];
}
