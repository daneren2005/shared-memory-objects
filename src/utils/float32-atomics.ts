// For doing Atomic operations on floats in SharedArrayBuffers
const buffer = new ArrayBuffer(4);
const float32 = new Float32Array(buffer);
const int32 = new Int32Array(buffer);

function loadFloat32(data: Int32Array, index: number) {
	return convertInt32ToFloat32(Atomics.load(data, index));
}
function storeFloat32(data: Int32Array, index: number, value: number) {
	Atomics.store(data, index, convertFloat32ToInt32(value));
}

function convertInt32ToFloat32(value: number) {
	int32[0] = value;

	return float32[0];
}
function convertFloat32ToInt32(value: number) {
	float32[0] = value;

	return int32[0];
}

export { loadFloat32, storeFloat32, convertInt32ToFloat32, convertFloat32ToInt32 };