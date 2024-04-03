const buffer = new ArrayBuffer(8);
const uint64Array = new BigUint64Array(buffer);
const uint16Array = new Uint16Array(buffer);

export function load16From64(data: BigUint64Array, index: number): [number, number, number, number] {
	uint64Array[0] = Atomics.load(data, index);
	
	return [uint16Array[0], uint16Array[1], uint16Array[2], uint16Array[3]];
}

export function store16In64(data: BigUint64Array, index: number, value1: number, value2: number, value3: number, value4: number = 0) {
	uint16Array[0] = value1;
	uint16Array[1] = value2;
	uint16Array[2] = value3;
	uint16Array[3] = value4;

	Atomics.store(data, index, uint64Array[0]);
}