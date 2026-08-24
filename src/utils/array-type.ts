import type { TypedArrayConstructor } from '../interfaces/typed-array-constructor';

// Every numeric view a data structure can store values in. The BigInt views (int64/uint64) carry bigint elements;
// all others carry number. A view's scalar type is T[number], so public signatures derive it straight from T.
type NumericArray = Uint32Array | Int32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array;

// Persisted in shared memory (the TYPE slot), so the order is append-only - never renumber an existing entry.
const ARRAY_TYPE = {
	uint32: 0,
	int32: 1,
	float32: 2,
	float64: 3,
	int64: 4,
	uint64: 5,
} as const;

// A numeric view whose element getter/setter accepts number or bigint. TypeScript can't prove `view[i] = value` on a
// generic (possibly-bigint) view because the union's index signatures collapse to `never`; going through this alias
// keeps the write type-safe at the boundary. Types are erased, so the emitted store is identical to a direct one.
type NumericArrayIO = { [index: number]: number | bigint };

function getArrayTypeCode(type: unknown): number {
	if(type === Int32Array) {
		return ARRAY_TYPE.int32;
	} else if(type === Float32Array) {
		return ARRAY_TYPE.float32;
	} else if(type === Float64Array) {
		return ARRAY_TYPE.float64;
	} else if(type === BigInt64Array) {
		return ARRAY_TYPE.int64;
	} else if(type === BigUint64Array) {
		return ARRAY_TYPE.uint64;
	} else {
		return ARRAY_TYPE.uint32;
	}
}

// 64-bit elements occupy two u32 allocation units; everything else occupies one. Callers size blocks as count * this.
function getByteMultipler(typeCode: number): number {
	return typeCode >= ARRAY_TYPE.float64 ? 2 : 1;
}

function isBigIntType(typeCode: number): boolean {
	return typeCode === ARRAY_TYPE.int64 || typeCode === ARRAY_TYPE.uint64;
}

// Float views don't support Atomics; callers that publish elements atomically must fall back to a plain store for these.
function isFloatType(typeCode: number): boolean {
	return typeCode === ARRAY_TYPE.float32 || typeCode === ARRAY_TYPE.float64;
}

// Builds the typed view for a resolved type code. `length` is the element count (not u32 units); for 64-bit types the
// backing block must already reserve length * getByteMultipler(typeCode) u32s.
function makeArrayView(typeCode: number, buffer: ArrayBufferLike, byteOffset: number, length: number): NumericArray {
	switch(typeCode) {
		case ARRAY_TYPE.int32:
			return new Int32Array(buffer, byteOffset, length);
		case ARRAY_TYPE.float32:
			return new Float32Array(buffer, byteOffset, length);
		case ARRAY_TYPE.float64:
			return new Float64Array(buffer, byteOffset, length);
		case ARRAY_TYPE.int64:
			return new BigInt64Array(buffer, byteOffset, length);
		case ARRAY_TYPE.uint64:
			return new BigUint64Array(buffer, byteOffset, length);
		case ARRAY_TYPE.uint32:
			return new Uint32Array(buffer, byteOffset, length);
		default:
			throw new Error(`Unknown data block type ${typeCode}`);
	}
}

export { ARRAY_TYPE, getArrayTypeCode, getByteMultipler, isBigIntType, isFloatType, makeArrayView };
export type { NumericArray, NumericArrayIO, TypedArrayConstructor };
