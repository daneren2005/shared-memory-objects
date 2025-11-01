// For doing Atomic operations on floats in SharedArrayBuffers
const buffer = new ArrayBuffer(4);
const float32 = new Float32Array(buffer);
const int32 = new Int32Array(buffer);

export function loadFloat32(data: Int32Array | Uint32Array | Float32Array, index: number) {
	if(data instanceof Float32Array) {
		data = new Int32Array(data.buffer, data.byteOffset, data.length);
	}

	return convertInt32ToFloat32(Atomics.load(data, index));
}
export function storeFloat32(data: Int32Array | Uint32Array | Float32Array, index: number, value: number) {
	if(data instanceof Float32Array) {
		data = new Int32Array(data.buffer, data.byteOffset, data.length);
	}

	Atomics.store(data, index, convertFloat32ToInt32(value));
}

export function convertInt32ToFloat32(value: number) {
	int32[0] = value;

	return float32[0];
}
export function convertFloat32ToInt32(value: number) {
	float32[0] = value;

	return int32[0];
}

export function exchangeFloat32(data: Int32Array | Uint32Array | Float32Array, index: number, value: number) {
	if(data instanceof Float32Array) {
		data = new Int32Array(data.buffer, data.byteOffset, data.length);
	}

	return convertInt32ToFloat32(Atomics.exchange(data, index, convertFloat32ToInt32(value)));
}

export function compareExchangeFloat32(data: Int32Array | Uint32Array | Float32Array, index: number, expectedValue: number, replacementValue: number) {
	if(data instanceof Float32Array) {
		data = new Int32Array(data.buffer, data.byteOffset, data.length);
	}

	return convertInt32ToFloat32(Atomics.compareExchange(data, index, convertFloat32ToInt32(expectedValue), convertFloat32ToInt32(replacementValue)));
}