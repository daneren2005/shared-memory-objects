const buffer = new ArrayBuffer(4);
const int32Array = new Int32Array(buffer);
const int16Array = new Int16Array(buffer);

export function load16From32Int(data: Int32Array, index: number): [number, number] {
	return convert32To16Int(Atomics.load(data, index));
}

export function store16In32Int(data: Int32Array, index: number, value1: number, value2: number) {
	Atomics.store(data, index, convert16To32Int(value1, value2));
}

export function convert32To16Int(value: number): [number, number] {
	int32Array[0] = value;

	return [int16Array[0], int16Array[1]];
}

export function convert16To32Int(value1: number, value2: number): number {
	int16Array[0] = value1;
	int16Array[1] = value2;

	return int32Array[0];
}
