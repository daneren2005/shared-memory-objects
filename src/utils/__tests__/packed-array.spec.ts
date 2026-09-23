import { describe, expect, it } from 'vitest';
import * as int16From32 from '../16-from-32-int';
import { convert16To32, convert32To16, load16From32, store16In32 } from '../16-from-32-array';
import * as uint16From32 from '../16-from-32-uint';
import * as float16From32 from '../16-from-32-float';
import * as int16From64 from '../16-from-64-int';
import { load16From64, store16In64 } from '../16-from-64-array';
import * as uint16From64 from '../16-from-64-uint';
import * as float16From64 from '../16-from-64-float';
import * as int32From64 from '../32-from-64-int';
import * as uint32From64 from '../32-from-64-uint';
import * as float32From64 from '../32-from-64-float';

describe('packed array variants', () => {
	it('keeps the legacy 32-bit functions unsigned', () => {
		const data = new Uint32Array(new SharedArrayBuffer(4));
		store16In32(data, 0, -32768, 32767);
		expect(load16From32(data, 0)).toEqual([32768, 32767]);
		expect(convert32To16(convert16To32(1, 2))).toEqual([1, 2]);
	});

	it('packs signed and unsigned 16-bit values into 32-bit arrays', () => {
		const signed = new Int32Array(new SharedArrayBuffer(4));
		int16From32.store16In32Int(signed, 0, -32768, 32767);
		expect(int16From32.load16From32Int(signed, 0)).toEqual([-32768, 32767]);
		expect(int16From32.convert32To16Int(int16From32.convert16To32Int(-1, -2))).toEqual([-1, -2]);

		const unsigned = new Uint32Array(new SharedArrayBuffer(4));
		uint16From32.store16In32Uint(unsigned, 0, 65535, 32768);
		expect(uint16From32.load16From32Uint(unsigned, 0)).toEqual([65535, 32768]);
		expect(uint16From32.convert32To16Uint(uint16From32.convert16To32Uint(65535, 65535))).toEqual([65535, 65535]);
	});

	it('packs signed and unsigned 16-bit values into 64-bit arrays', () => {
		const signed = new BigInt64Array(new SharedArrayBuffer(8));
		int16From64.store16In64Int(signed, 0, -32768, -1, 0, 32767);
		expect(int16From64.load16From64Int(signed, 0)).toEqual([-32768, -1, 0, 32767]);
		expect(int16From64.convert64To16Int(int16From64.convert16To64Int(-1, -2, -3, -4))).toEqual([-1, -2, -3, -4]);

		const unsigned = new BigUint64Array(new SharedArrayBuffer(8));
		uint16From64.store16In64Uint(unsigned, 0, 65535, 32768, 123, 456);
		expect(uint16From64.load16From64Uint(unsigned, 0)).toEqual([65535, 32768, 123, 456]);
		expect(uint16From64.convert64To16Uint(uint16From64.convert16To64Uint(1, 2, 3, 4))).toEqual([1, 2, 3, 4]);
	});

	it('keeps the legacy 64-bit functions signed', () => {
		const data = new BigUint64Array(new SharedArrayBuffer(8));
		store16In64(data, 0, -1, 5, 70, -4);
		expect(load16From64(data, 0)).toEqual([65535, 5, 70, 65532]);
	});

	it('packs signed and unsigned 32-bit values into 64-bit arrays', () => {
		const signed = new BigInt64Array(new SharedArrayBuffer(8));
		int32From64.store32In64Int(signed, 0, -2147483648, 2147483647);
		expect(int32From64.load32From64Int(signed, 0)).toEqual([-2147483648, 2147483647]);
		expect(int32From64.convert64To32Int(int32From64.convert32To64Int(-1, -2))).toEqual([-1, -2]);

		const unsigned = new BigUint64Array(new SharedArrayBuffer(8));
		uint32From64.store32In64Uint(unsigned, 0, 4294967295, 2147483648);
		expect(uint32From64.load32From64Uint(unsigned, 0)).toEqual([4294967295, 2147483648]);
		expect(uint32From64.convert64To32Uint(uint32From64.convert32To64Uint(1, 4294967295))).toEqual([1, 4294967295]);
	});

	it('packs half-precision values into float arrays', () => {
		const float32 = new Float32Array(new SharedArrayBuffer(4));
		float16From32.store16In32Float(float32, 0, -2.5, 0.5);
		expect(float16From32.load16From32Float(float32, 0)).toEqual([-2.5, 0.5]);
		expect(float16From32.convert32To16Float(float16From32.convert16To32Float(1.5, -0.25))).toEqual([1.5, -0.25]);

		const float64 = new Float64Array(new SharedArrayBuffer(8));
		float16From64.store16In64Float(float64, 0, 1.5, -2.5, 0.25, -0.5);
		expect(float16From64.load16From64Float(float64, 0)).toEqual([1.5, -2.5, 0.25, -0.5]);
		expect(float16From64.convert64To16Float(float16From64.convert16To64Float(1, 2, 3, 4))).toEqual([1, 2, 3, 4]);
	});

	it('rounds half-precision values and preserves signed zero', () => {
		const data = new Float32Array(new SharedArrayBuffer(4));
		float16From32.store16In32Float(data, 0, 1 + 2 ** -11, -0);
		const [rounded, zero] = float16From32.load16From32Float(data, 0);
		expect(rounded).toBe(1);
		expect(Object.is(zero, -0)).toBe(true);

		float16From32.store16In32Float(data, 0, 2 ** -24, 65504);
		expect(float16From32.load16From32Float(data, 0)).toEqual([2 ** -24, 65504]);
		float16From32.store16In32Float(data, 0, Infinity, NaN);
		const [infinity, nan] = float16From32.load16From32Float(data, 0);
		expect(infinity).toBe(Infinity);
		expect(Number.isNaN(nan)).toBe(true);
	});

	it('packs 32-bit floats into a 64-bit float array', () => {
		const data = new Float64Array(new SharedArrayBuffer(8));
		float32From64.store32In64Float(data, 0, -2.5, 1.25);
		expect(float32From64.load32From64Float(data, 0)).toEqual([-2.5, 1.25]);
		expect(float32From64.convert64To32Float(float32From64.convert32To64Float(0.5, -1.5))).toEqual([0.5, -1.5]);
	});
});
