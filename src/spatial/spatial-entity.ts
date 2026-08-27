interface SpatialEntity {
	id: number
	x: number
	y: number
	width?: number
	height?: number
}

const DEFAULT_POOL_CHUNK_SIZE = 100;
const MAX_PACKED_POOL_LENGTH = 16_384;

function getSpatialPoolChunkSize(maxLength: number, fields: number, byteMultiplier: number, maxAllocationLength: number): number {
	if(maxLength < DEFAULT_POOL_CHUNK_SIZE || maxLength > MAX_PACKED_POOL_LENGTH) {
		return DEFAULT_POOL_CHUNK_SIZE;
	}
	let allocationLimit = Math.floor(maxAllocationLength / (fields * byteMultiplier));
	return Math.max(1, Math.min(maxLength, allocationLimit));
}

function getSpatialMapCapacity(maxEntities: number, maxAllocationLength: number): number {
	if(maxEntities > MAX_PACKED_POOL_LENGTH) {
		return 16;
	}
	let needed = Math.ceil(maxEntities * 4 / 3);
	let capacity = 16;
	while(capacity < needed) {
		capacity *= 2;
	}
	let allocationLimit = 16;
	while(allocationLimit * 2 * 3 <= maxAllocationLength) {
		allocationLimit *= 2;
	}
	return Math.min(capacity, allocationLimit);
}

export { getSpatialMapCapacity, getSpatialPoolChunkSize };
export type { SpatialEntity };
