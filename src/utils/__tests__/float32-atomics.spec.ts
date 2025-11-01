import { compareExchangeFloat32, exchangeFloat32, loadFloat32, storeFloat32 } from '../float32-atomics';

describe('float32-atomics', () => {
	it('converting back and forth with int32', () => {
		const data = new Int32Array(10);

		storeFloat32(data, 2, 5.5);
		expect(loadFloat32(data, 2)).toEqual(5.5);

		storeFloat32(data, 1, -4.5);
		expect(loadFloat32(data, 1)).toEqual(-4.5);
		expect(loadFloat32(data, 2)).toEqual(5.5);

		expect(exchangeFloat32(data, 2, 8.5)).toEqual(5.5);
		expect(loadFloat32(data, 1)).toEqual(-4.5);
		expect(loadFloat32(data, 2)).toEqual(8.5);

		expect(compareExchangeFloat32(data, 2, 5, 10)).toEqual(8.5);
		expect(loadFloat32(data, 2)).toEqual(8.5);
		expect(compareExchangeFloat32(data, 2, 8.5, 10)).toEqual(8.5);
		expect(loadFloat32(data, 2)).toEqual(10);
	});

	it('converting back and forth with uint32', () => {
		const data = new Uint32Array(10);

		storeFloat32(data, 2, 5.5);
		expect(loadFloat32(data, 2)).toEqual(5.5);

		storeFloat32(data, 1, -4.5);
		expect(loadFloat32(data, 1)).toEqual(-4.5);
		expect(loadFloat32(data, 2)).toEqual(5.5);

		expect(exchangeFloat32(data, 2, 8.5)).toEqual(5.5);
		expect(loadFloat32(data, 1)).toEqual(-4.5);
		expect(loadFloat32(data, 2)).toEqual(8.5);
		
		expect(compareExchangeFloat32(data, 2, 5, 10)).toEqual(8.5);
		expect(loadFloat32(data, 2)).toEqual(8.5);
		expect(compareExchangeFloat32(data, 2, 8.5, 10)).toEqual(8.5);
		expect(loadFloat32(data, 2)).toEqual(10);
	});

	it('converting back and forth with float32', () => {
		const data = new Float32Array(10);

		storeFloat32(data, 2, 5.5);
		expect(loadFloat32(data, 2)).toEqual(5.5);

		storeFloat32(data, 1, -4.5);
		expect(loadFloat32(data, 1)).toEqual(-4.5);
		expect(loadFloat32(data, 2)).toEqual(5.5);

		expect(exchangeFloat32(data, 2, 8.5)).toEqual(5.5);
		expect(loadFloat32(data, 1)).toEqual(-4.5);
		expect(loadFloat32(data, 2)).toEqual(8.5);

		expect(compareExchangeFloat32(data, 2, 5, 10)).toEqual(8.5);
		expect(loadFloat32(data, 2)).toEqual(8.5);
		expect(compareExchangeFloat32(data, 2, 8.5, 10)).toEqual(8.5);
		expect(loadFloat32(data, 2)).toEqual(10);
	});
});