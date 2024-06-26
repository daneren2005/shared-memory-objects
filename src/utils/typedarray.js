// Copied from @thi.ng/api/typedarray
// TODO: rewrite without this but for now just forked in order to add Atomics to base library

var GLType = /* @__PURE__ */ ((GLType2) => {
	GLType2[GLType2['I8'] = 5120] = 'I8';
	GLType2[GLType2['U8'] = 5121] = 'U8';
	GLType2[GLType2['I16'] = 5122] = 'I16';
	GLType2[GLType2['U16'] = 5123] = 'U16';
	GLType2[GLType2['I32'] = 5124] = 'I32';
	GLType2[GLType2['U32'] = 5125] = 'U32';
	GLType2[GLType2['F32'] = 5126] = 'F32';
	return GLType2;
})(GLType || {});
const GL2TYPE = {
	[5120 /* I8 */]: 'i8',
	[5121 /* U8 */]: 'u8',
	[5122 /* I16 */]: 'i16',
	[5123 /* U16 */]: 'u16',
	[5124 /* I32 */]: 'i32',
	[5125 /* U32 */]: 'u32',
	[5126 /* F32 */]: 'f32'
};
const TYPE2GL = {
	i8: 5120 /* I8 */,
	u8: 5121 /* U8 */,
	u8c: 5121 /* U8 */,
	i16: 5122 /* I16 */,
	u16: 5123 /* U16 */,
	i32: 5124 /* I32 */,
	u32: 5125 /* U32 */,
	f32: 5126 /* F32 */,
	f64: void 0
};
const SIZEOF = {
	u8: 1,
	u8c: 1,
	i8: 1,
	u16: 2,
	i16: 2,
	u32: 4,
	i32: 4,
	i64: 8,
	u64: 8,
	f32: 4,
	f64: 8
};
const BIT_SHIFTS = {
	i8: 0,
	u8: 0,
	u8c: 0,
	i16: 1,
	u16: 1,
	i32: 2,
	u32: 2,
	i64: 3,
	u64: 3,
	f32: 2,
	f64: 3
};
const FLOAT_ARRAY_CTORS = {
	f32: Float32Array,
	f64: Float64Array
};
const INT_ARRAY_CTORS = {
	i8: Int8Array,
	i16: Int16Array,
	i32: Int32Array
};
const UINT_ARRAY_CTORS = {
	u8: Uint8Array,
	u8c: Uint8ClampedArray,
	u16: Uint16Array,
	u32: Uint32Array
};
const BIGINT_ARRAY_CTORS = {
	// eslint-disable-next-line
	i64: BigInt64Array,
	// eslint-disable-next-line
	u64: BigUint64Array
};
const TYPEDARRAY_CTORS = {
	...FLOAT_ARRAY_CTORS,
	...INT_ARRAY_CTORS,
	...UINT_ARRAY_CTORS
};
const asNativeType = (type) => {
	const t = GL2TYPE[type];
	return t !== void 0 ? t : type;
};
const asGLType = (type) => {
	const t = TYPE2GL[type];
	return t !== void 0 ? t : type;
};
const asInt = (...args) => args.map((x) => x | 0);
const sizeOf = (type) => SIZEOF[type] || SIZEOF[asNativeType(type)];
function typedArray(type, ...xs) {
	const ctor = BIGINT_ARRAY_CTORS[type];
	return new (ctor || TYPEDARRAY_CTORS[asNativeType(type)])(...xs);
}
function typedArrayOfVec(type, data, stride) {
	const $data = Array.isArray(data) ? data : [...data];
	if(stride === void 0)
		stride = $data[0].length;
	const num = $data.length;
	const res = typedArray(type, num * stride);
	for(let i = 0, j = 0; i < num; i++, j += stride) {
		res.set($data[i], j);
	}
	return res;
}
const typedArrayType = (x) => {
	if(Array.isArray(x))
		return 'f64';
	for(let id in TYPEDARRAY_CTORS) {
		if(x instanceof TYPEDARRAY_CTORS[id])
			return id;
	}
	return 'f64';
};
const uintTypeForSize = (x) => x <= 256 ? 'u8' : x <= 65536 ? 'u16' : 'u32';
const intTypeForSize = (x) => x >= -128 && x < 128 ? 'i8' : x >= -32768 && x < 32768 ? 'i16' : 'i32';
const uintTypeForBits = (x) => x > 16 ? 'u32' : x > 8 ? 'u16' : 'u8';
const intTypeForBits = (x) => x > 16 ? 'i32' : x > 8 ? 'i16' : 'i8';
const narrowInt = (t) => t === 'i64' ? 'i32' : t === 'i32' ? 'i16' : t === 'i16' ? 'i8' : 'i8';
const widenInt = (t) => t === 'i8' ? 'i16' : t === 'i16' ? 'i32' : t === 'i32' ? 'i64' : 'i64';
const narrowUint = (t) => t === 'u64' ? 'u32' : t === 'u32' ? 'u16' : t === 'u16' ? 'u8' : 'u8';
const widenUint = (t) => t === 'u8' || t === 'u8c' ? 'u16' : t === 'u16' ? 'u32' : t === 'u32' ? 'u64' : 'u64';
const narrowFloat = (t) => t === 'f64' ? 'f32' : 'f32';
const widenFloat = (t) => t === 'f32' ? 'f64' : 'f64';
const narrowType = (t) => t[0] === 'i' ? narrowInt(t) : t[0] === 'u' ? narrowUint(t) : narrowFloat(t);
const widenType = (t) => t[0] === 'i' ? widenInt(t) : t[0] === 'u' ? widenUint(t) : widenFloat(t);
export {
	BIGINT_ARRAY_CTORS,
	BIT_SHIFTS,
	FLOAT_ARRAY_CTORS,
	GL2TYPE,
	GLType,
	INT_ARRAY_CTORS,
	SIZEOF,
	TYPE2GL,
	TYPEDARRAY_CTORS,
	UINT_ARRAY_CTORS,
	asGLType,
	asInt,
	asNativeType,
	intTypeForBits,
	intTypeForSize,
	narrowFloat,
	narrowInt,
	narrowType,
	narrowUint,
	sizeOf,
	typedArray,
	typedArrayOfVec,
	typedArrayType,
	uintTypeForBits,
	uintTypeForSize,
	widenFloat,
	widenInt,
	widenType,
	widenUint
};
