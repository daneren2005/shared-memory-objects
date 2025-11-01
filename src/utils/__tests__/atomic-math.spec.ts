import { addAtomicFloat32, addAtomicInt, subtractAtomicFloat, subtractAtomicInt } from '../atomic-math';

describe('atomic math', () => {
	it('atomicAdd int', () => {
		const data = new Uint32Array(1);

		addAtomicInt(data, 0, 5, 10);
		expect(data[0]).toEqual(5);
		addAtomicInt(data, 0, 3, 10);
		expect(data[0]).toEqual(8);
		addAtomicInt(data, 0, 3, 10);
		expect(data[0]).toEqual(10);
	});

	it('atomicSubtract int', () => {
		const data = new Uint32Array(1);
		data[0] = 10;

		subtractAtomicInt(data, 0, 5, 0);
		expect(data[0]).toEqual(5);
		subtractAtomicInt(data, 0, 3, 0);
		expect(data[0]).toEqual(2);
		subtractAtomicInt(data, 0, 3, 0);
		expect(data[0]).toEqual(0);
	});

	it('atomicAdd float', () => {
		const data = new Float32Array(1);

		addAtomicFloat32(data, 0, 5.5, 10);
		expect(data[0]).toEqual(5.5);
		addAtomicFloat32(data, 0, 3, 10);
		expect(data[0]).toEqual(8.5);
		addAtomicFloat32(data, 0, 3, 10.5);
		expect(data[0]).toEqual(10.5);
	});

	it('atomicSubtract float', () => {
		const data = new Float32Array(1);
		data[0] = 10;

		subtractAtomicFloat(data, 0, 5.5, 0);
		expect(data[0]).toEqual(4.5);
		subtractAtomicFloat(data, 0, 3, 0);
		expect(data[0]).toEqual(1.5);
		subtractAtomicFloat(data, 0, 3, 0.5);
		expect(data[0]).toEqual(0.5);
	});
});