import { compareExchangeFloat64, exchangeFloat64, loadFloat64, storeFloat64 } from '../float64-atomics';

describe('float64-atomics', () => {
	it('converting back and forth with int64', () => {
		const data = new BigInt64Array(10);

		storeFloat64(data, 2, 5.5);
		expect(loadFloat64(data, 2)).toEqual(5.5);

		storeFloat64(data, 1, -4.5);
		expect(loadFloat64(data, 1)).toEqual(-4.5);
		expect(loadFloat64(data, 2)).toEqual(5.5);

		expect(exchangeFloat64(data, 2, 8.5)).toEqual(5.5);
		expect(loadFloat64(data, 1)).toEqual(-4.5);
		expect(loadFloat64(data, 2)).toEqual(8.5);

		expect(compareExchangeFloat64(data, 2, 5, 10)).toEqual(8.5);
		expect(loadFloat64(data, 2)).toEqual(8.5);
		expect(compareExchangeFloat64(data, 2, 8.5, 10)).toEqual(8.5);
		expect(loadFloat64(data, 2)).toEqual(10);
	});

	it('converting back and forth with float64', () => {
		const data = new Float64Array(10);

		storeFloat64(data, 2, 5.5);
		expect(loadFloat64(data, 2)).toEqual(5.5);

		storeFloat64(data, 1, -4.5);
		expect(loadFloat64(data, 1)).toEqual(-4.5);
		expect(loadFloat64(data, 2)).toEqual(5.5);

		expect(exchangeFloat64(data, 2, 8.5)).toEqual(5.5);
		expect(loadFloat64(data, 1)).toEqual(-4.5);
		expect(loadFloat64(data, 2)).toEqual(8.5);

		expect(compareExchangeFloat64(data, 2, 5, 10)).toEqual(8.5);
		expect(loadFloat64(data, 2)).toEqual(8.5);
		expect(compareExchangeFloat64(data, 2, 8.5, 10)).toEqual(8.5);
		expect(loadFloat64(data, 2)).toEqual(10);

		storeFloat64(data, 2, Number.MAX_SAFE_INTEGER);
		expect(loadFloat64(data, 2)).toEqual(Number.MAX_SAFE_INTEGER);
	});
});