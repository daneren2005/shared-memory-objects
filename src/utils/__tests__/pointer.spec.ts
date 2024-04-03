import { MAX_BYTE_OFFSET_LENGTH, MAX_POSITION_LENGTH, createPointer, getPointer } from '../pointer';

describe('pointer', () => {
	it('check all numbers', () => {
		const SKIP_POSITIONS = 10;
		const SKIP_BYTE_OFFSETS = 10;

		for(let position = 0; position < MAX_POSITION_LENGTH; position += SKIP_POSITIONS) {
			for(let byteOffset = 1; byteOffset < MAX_BYTE_OFFSET_LENGTH; byteOffset *= SKIP_BYTE_OFFSETS) {
				let pointer = createPointer(position, byteOffset);

				let { bufferPosition, bufferByteOffset } = getPointer(pointer);
				expect(bufferPosition).toEqual(position);
				expect(bufferByteOffset).toEqual(byteOffset);
			}
		}
	});
});