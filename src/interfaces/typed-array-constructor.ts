interface TypedArrayConstructor<T> {
	new(buffer: ArrayBufferLike, byteOffset: number, length: number): T
	BYTES_PER_ELEMENT: number
}

export type { TypedArrayConstructor };