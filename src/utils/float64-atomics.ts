// For doing Atomic operations on floats in SharedArrayBuffers
const buffer = new ArrayBuffer(8);
const float64 = new Float64Array(buffer);
const int64 = new BigInt64Array(buffer);

export function loadFloat64(data: BigInt64Array | Float64Array, index: number) {
	if(data instanceof Float64Array) {
		data = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	}

	return convertInt64ToFloat64(Atomics.load(data, index));
}
export function storeFloat64(data: BigInt64Array | Float64Array, index: number, value: number) {
	if(data instanceof Float64Array) {
		data = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	}

	Atomics.store(data, index, convertFloat64ToInt64(value));
}

export function convertInt64ToFloat64(value: bigint) {
	int64[0] = value;

	return float64[0];
}
export function convertFloat64ToInt64(value: number) {
	float64[0] = value;

	return int64[0];
}

export function exchangeFloat64(data: BigInt64Array | Float64Array, index: number, value: number) {
	if(data instanceof Float64Array) {
		data = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	}

	return convertInt64ToFloat64(Atomics.exchange(data, index, convertFloat64ToInt64(value)));
}

export function compareExchangeFloat64(data: BigInt64Array | Float64Array, index: number, expectedValue: number, replacementValue: number) {
	if(data instanceof Float64Array) {
		data = new BigInt64Array(data.buffer, data.byteOffset, data.length);
	}

	return convertInt64ToFloat64(Atomics.compareExchange(data, index, convertFloat64ToInt64(expectedValue), convertFloat64ToInt64(replacementValue)));
}