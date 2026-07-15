import { compareExchangeFloat32, loadFloat32 } from './float32-atomics';

export function addAtomicInt(array: Uint32Array | Int32Array, index: number, amount: number, max: number) {
	let oldValue;
	let newValue;
	do {
		oldValue = Atomics.load(array, index);
		newValue = Math.min(oldValue + amount, max);
	} while(Atomics.compareExchange(array, index, oldValue, newValue) !== oldValue);

	return newValue;
}

export function subtractAtomicInt(array: Uint32Array | Int32Array, index: number, amount: number, min: number) {
	let oldValue;
	let newValue;
	do {
		oldValue = Atomics.load(array, index);
		newValue = Math.max(oldValue - amount, min);
	} while(Atomics.compareExchange(array, index, oldValue, newValue) !== oldValue);

	return newValue;
}

export function addAtomicFloat32(array: Float32Array, index: number, amount: number, max: number) {
	let oldValue;
	let newValue;
	do {
		oldValue = loadFloat32(array, index);
		newValue = Math.min(oldValue + amount, max);
	} while(compareExchangeFloat32(array, index, oldValue, newValue) !== oldValue);

	return newValue;
}

export function subtractAtomicFloat(array: Float32Array, index: number, amount: number, min: number) {
	let oldValue;
	let newValue;
	do {
		oldValue = loadFloat32(array, index);
		newValue = Math.max(oldValue - amount, min);
	} while(compareExchangeFloat32(array, index, oldValue, newValue) !== oldValue);

	return newValue;
}