import { addAtomicFloat32, addAtomicInt, subtractAtomicFloat, subtractAtomicInt } from '../atomic-math';

describe('atomic math', () => {
	it('atomicAdd int', () => {
		const data = new Uint32Array(1);

		expect(addAtomicInt(data, 0, 5, 10)).toEqual(5);
		expect(data[0]).toEqual(5);
		expect(addAtomicInt(data, 0, 3, 10)).toEqual(8);
		expect(data[0]).toEqual(8);
		expect(addAtomicInt(data, 0, 3, 10)).toEqual(10);
		expect(data[0]).toEqual(10);
	});

	it('atomicSubtract int', () => {
		const data = new Uint32Array(1);
		data[0] = 10;

		expect(subtractAtomicInt(data, 0, 5, 0)).toEqual(5);
		expect(data[0]).toEqual(5);
		expect(subtractAtomicInt(data, 0, 3, 0)).toEqual(2);
		expect(data[0]).toEqual(2);
		expect(subtractAtomicInt(data, 0, 3, 0)).toEqual(0);
		expect(data[0]).toEqual(0);
	});

	it('atomicAdd float', () => {
		const data = new Float32Array(1);

		expect(addAtomicFloat32(data, 0, 5.5, 10)).toEqual(5.5);
		expect(data[0]).toEqual(5.5);
		expect(addAtomicFloat32(data, 0, 3, 10)).toEqual(8.5);
		expect(data[0]).toEqual(8.5);
		expect(addAtomicFloat32(data, 0, 3, 10.5)).toEqual(10.5);
		expect(data[0]).toEqual(10.5);
	});

	it('atomicSubtract float', () => {
		const data = new Float32Array(1);
		data[0] = 10;

		expect(subtractAtomicFloat(data, 0, 5.5, 0)).toEqual(4.5);
		expect(data[0]).toEqual(4.5);
		expect(subtractAtomicFloat(data, 0, 3, 0)).toEqual(1.5);
		expect(data[0]).toEqual(1.5);
		expect(subtractAtomicFloat(data, 0, 3, 0.5)).toEqual(0.5);
		expect(data[0]).toEqual(0.5);
	});
});