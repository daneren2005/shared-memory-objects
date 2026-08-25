import type { SharedAllocatedMemory } from '../allocated-memory';
import AllocatedMemory from '../allocated-memory';
import type MemoryHeap from '../memory-heap';
import SharedPool, { type SharedPoolConfig } from '../shared-pool';
import SharedMap from '../shared-map';
import { lock, unlock } from '../lock/simple-lock';
import { getPointer, loadRawPointer, storeRawPointer } from '../utils/pointer';
import { ARRAY_TYPE, getArrayTypeCode, getByteMultipler, makeArrayView } from '../utils/array-type';

// Unbounded spatial hash ("spatial multimap") built for concurrent updates from many threads. It indexes the same way
// SharedSpatialGrid does - every entity occupies each virtual cell (of side gridSize) its rect overlaps - but it drops
// the grid's fixed cols x rows extent so the world is unbounded: cells may sit at any (col, row), positive or negative.
//
// A cell (col, row) is not stored at a fixed array index (there is no finite grid to index); instead it is hashed into a
// fixed-size array of buckets - hash(col, row) % bucketCount - and every cell that lands on a bucket shares that bucket's
// intrusive singly-linked list. This is the classic lock-striped separate-chaining concurrent hash table: the bucket
// array is allocated once and never resized (a runtime rehash would race readers mid-traversal, the same hazard
// SharedQuadtree/SharedSpatialGrid avoid by never reshaping), so concurrency reduces to per-bucket content updates.
// Two threads contend only when their cells hash to the same bucket, so bucketCount trades memory for that contention.
//
// Because distinct cells collide onto one bucket, a slot must carry its own cell (col, row): a bucket walk considers only
// slots whose cell matches the cell being queried. Each (entity, cell) membership is a "slot" record in a SharedPool; the
// entity's occupied cell rectangle is stored once in a separate entity pool, keyed by an id->entityIndex SharedMap, so
// remove(id) (which only gets an id) knows which cells to unlink from.
//
// retrieve returns each entity at most once even though it spans multiple cells: every slot carries the entity's anchor
// (top-left) cell, and a slot only emits its id when its cell is the top-left cell of the entity that intersects the query
// (col == max(anchorCol, qMinCol) && row == max(anchorRow, qMinRow)). That cell is always one of the entity's cells and
// inside the query, so exactly one slot emits - no Set and no per-query mutation, so concurrent queries stay safe.
//
// Records are stored at the configured precision. Float32 (the default) keeps everything exact as long as entity ids and
// both pools' index spaces stay under 2^24 (~16.7M) - every id, pool index, and the NULL sentinel is Float32 exact there
// - and cell (col, row) stay within [-2^24, 2^24]. Need more (or ids >= 2^24)? Pass type: Float64Array.

// Header (firstBlock) u32 layout
const BUCKET_POINTER_INDEX = 0;
const ENTITY_POOL_POINTER_INDEX = 1;
const SLOT_POOL_POINTER_INDEX = 2;
const MAP_POINTER_INDEX = 3;
const BUCKET_COUNT_INDEX = 4;
const TYPE_INDEX = 5;
// config view starts at slot 6 (offset 24 bytes is 8-byte aligned, so a Float64 view is valid): [gridSize]
const CONFIG_INDEX = 6;

// Per-bucket record: [lock, head]
const BUCKET_LOCK_OFFSET = 0;
const BUCKET_HEAD_OFFSET = 1;
const BUCKET_SIZE = 2;

// Slot record fields (one per entity-cell membership). The cell (col, row) is stored explicitly because a bucket mixes
// slots from every cell that hashes to it, so a walk must filter to the cell it is looking at.
const SLOT_ID = 0;
const SLOT_COL = 1;
const SLOT_ROW = 2;
const SLOT_ANCHOR_COL = 3;
const SLOT_ANCHOR_ROW = 4;
const SLOT_NEXT = 5;
const SLOT_FIELDS = 6;

// Entity record fields: the occupied cell rectangle
const ENTITY_MIN_COL = 0;
const ENTITY_MIN_ROW = 1;
const ENTITY_MAX_COL = 2;
const ENTITY_MAX_ROW = 3;
const ENTITY_FIELDS = 4;

// Largest exact integer range for Float32 coordinates: [0, 2^24). Ids and pool indices must stay under this to survive a
// Float32 round-trip, so it doubles as the Float32 entity cap and the value just past every valid index.
const FLOAT32_LIMIT = 0x1000000;
// End-of-list / empty-bucket sentinel, chosen per element type so it is exact in the pool's view and above every valid
// index: 2^24 for Float32 (its first non-representable index), 0xffffffff for Float64 (well within its exact range).
const FLOAT32_NULL_INDEX = FLOAT32_LIMIT;
const FLOAT64_NULL_INDEX = 0xffffffff;

// Odd primes for the spatial hash (Teschner et al.): mixing col and row through Math.imul then xor scatters neighbouring
// cells across buckets so a query's cells rarely collide on one bucket.
const HASH_PRIME_COL = 73856093;
const HASH_PRIME_ROW = 19349663;

const DEFAULT_GRID_SIZE = 50;
const DEFAULT_BUCKET_COUNT = 8192;
const DEFAULT_MAX_ENTITIES = 1_000_000;
// A spatial-map entity can span several cells, so the slot pool needs headroom over the entity count
const DEFAULT_SLOTS_PER_ENTITY = 4;
const DEFAULT_COORD_TYPE = Float32Array;

type CoordArray = Float32Array | Float64Array;
type CoordArrayConstructor = Float32ArrayConstructor | Float64ArrayConstructor;

export default class SharedSpatialMap {
	static readonly ALLOCATE_COUNT = 8;

	private memory: MemoryHeap;
	private firstBlock: AllocatedMemory;
	private entityPool: SharedPool<CoordArray>;
	private slotPool: SharedPool<CoordArray>;
	private idMap: SharedMap<number>;

	// Reused to hand a full record to pool.push without allocating a fresh array per operation (single writer per id)
	private entityScratch: Array<number> = [0, 0, 0, 0];
	private slotScratch: Array<number> = [0, 0, 0, 0, 0, 0];

	// Bucket block views over one contiguous region: Int32 for the per-bucket locks, Uint32 for the head indexes.
	private bucketInts: Int32Array;
	private bucketHeads: Uint32Array;

	private readonly coordType: number;
	// Empty-bucket / end-of-list sentinel for this instance's element type (see FLOAT32_NULL_INDEX)
	private readonly nullIndex: number;
	private readonly bucketCount: number;
	// bucketCount-1 when bucketCount is a power of two, else -1. Lets bucketOf mask (hash & mask) instead of taking a
	// variable integer modulo (hash % bucketCount) on the hot path - every insert/update/remove/query cell hashes a bucket.
	private readonly bucketMask: number;
	// Virtual cell size, read once (stored at the configured precision, math done in float64)
	private readonly cellSize: number;

	// Number of entities currently tracked
	get size(): number {
		return this.idMap.length;
	}

	get gridSize(): number {
		return this.cellSize;
	}
	get buckets(): number {
		return this.bucketCount;
	}

	// Element type the records are stored in (an ARRAY_TYPE code: float32 or float64)
	get type(): number {
		return this.coordType;
	}

	constructor(memory: MemoryHeap, config?: SharedSpatialMapConfig | SharedSpatialMapMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.coordType = this.firstBlock.data[TYPE_INDEX];
			this.entityPool = new SharedPool<CoordArray>(memory, {
				firstBlock: getPointer(loadRawPointer(this.firstBlock.data, ENTITY_POOL_POINTER_INDEX), memory.positionBits),
			});
			this.slotPool = new SharedPool<CoordArray>(memory, {
				firstBlock: getPointer(loadRawPointer(this.firstBlock.data, SLOT_POOL_POINTER_INDEX), memory.positionBits),
			});
			this.idMap = new SharedMap<number>(memory, {
				firstBlock: getPointer(loadRawPointer(this.firstBlock.data, MAP_POINTER_INDEX), memory.positionBits),
			});
			this.bucketCount = this.firstBlock.data[BUCKET_COUNT_INDEX];
			this.nullIndex = nullIndexFor(this.coordType);
		} else {
			let gridSize = config?.gridSize ?? DEFAULT_GRID_SIZE;
			this.bucketCount = Math.max(1, config?.buckets ?? DEFAULT_BUCKET_COUNT);
			let maxEntities = config?.maxEntities ?? DEFAULT_MAX_ENTITIES;
			let maxSlots = config?.maxSlots ?? maxEntities * DEFAULT_SLOTS_PER_ENTITY;
			this.coordType = getCoordTypeCode(config?.type);
			this.nullIndex = nullIndexFor(this.coordType);

			if(this.coordType === ARRAY_TYPE.float32 && (maxEntities > FLOAT32_LIMIT || maxSlots > FLOAT32_LIMIT)) {
				throw new Error(`Float32 SharedSpatialMap supports at most ${FLOAT32_LIMIT} entities and slots; pass type: Float64Array for more`);
			}

			// Inline the two pools' and the id-map's firstBlocks right after the header so the whole spine is one contiguous
			// allocation. The bucket block stays separate: it is large and sized independently of these headers.
			let entityPoolConfig: SharedPoolConfig<CoordArray> = {
				type: getCoordTypeConstructor(this.coordType),
				dataLength: ENTITY_FIELDS,
				maxLength: maxEntities,
			};
			let slotPoolConfig: SharedPoolConfig<CoordArray> = {
				type: getCoordTypeConstructor(this.coordType),
				dataLength: SLOT_FIELDS,
				maxLength: maxSlots,
			};
			let entityPoolAllocateCount = SharedPool.getAllocateCount(memory, entityPoolConfig);
			let slotPoolAllocateCount = SharedPool.getAllocateCount(memory, slotPoolConfig);
			let mapAllocateCount = SharedMap.ALLOCATE_COUNT;
			this.firstBlock = memory.allocUI32(SharedSpatialMap.ALLOCATE_COUNT + entityPoolAllocateCount + slotPoolAllocateCount + mapAllocateCount);
			this.firstBlock.data[BUCKET_COUNT_INDEX] = this.bucketCount;
			this.firstBlock.data[TYPE_INDEX] = this.coordType;

			let configView = this.getConfigView();
			configView[0] = gridSize;

			// Bucket block must fit one allocation - it is never resized. Every head starts as NULL (calloc leaves them 0, a
			// valid slot index, so they must be initialized explicitly).
			let bucketBlock = memory.allocUI32(this.bucketCount * BUCKET_SIZE);
			let heads = new Uint32Array(bucketBlock.data.buffer, bucketBlock.bufferByteOffset, this.bucketCount * BUCKET_SIZE);
			for(let i = 0; i < this.bucketCount; i++) {
				heads[i * BUCKET_SIZE + BUCKET_HEAD_OFFSET] = this.nullIndex;
			}
			storeRawPointer(this.firstBlock.data, BUCKET_POINTER_INDEX, bucketBlock.pointer);

			let entityPoolBlock = this.firstBlock.getSubAllocation(SharedSpatialMap.ALLOCATE_COUNT, entityPoolAllocateCount);
			this.entityPool = new SharedPool<CoordArray>(memory, { firstBlock: entityPoolBlock, ...entityPoolConfig });
			storeRawPointer(this.firstBlock.data, ENTITY_POOL_POINTER_INDEX, entityPoolBlock.pointer);

			let slotPoolBlock = this.firstBlock.getSubAllocation(SharedSpatialMap.ALLOCATE_COUNT + entityPoolAllocateCount, slotPoolAllocateCount);
			this.slotPool = new SharedPool<CoordArray>(memory, { firstBlock: slotPoolBlock, ...slotPoolConfig });
			storeRawPointer(this.firstBlock.data, SLOT_POOL_POINTER_INDEX, slotPoolBlock.pointer);

			let mapBlock = this.firstBlock.getSubAllocation(SharedSpatialMap.ALLOCATE_COUNT + entityPoolAllocateCount + slotPoolAllocateCount, mapAllocateCount);
			this.idMap = new SharedMap<number>(memory, { firstBlock: mapBlock });
			storeRawPointer(this.firstBlock.data, MAP_POINTER_INDEX, mapBlock.pointer);
		}

		this.bucketMask = (this.bucketCount & (this.bucketCount - 1)) === 0 ? this.bucketCount - 1 : -1;

		let configView = this.getConfigView();
		this.cellSize = configView[0];

		let bucketBlock = new AllocatedMemory(memory, getPointer(loadRawPointer(this.firstBlock.data, BUCKET_POINTER_INDEX), memory.positionBits));
		this.bucketInts = new Int32Array(bucketBlock.data.buffer, bucketBlock.bufferByteOffset, this.bucketCount * BUCKET_SIZE);
		this.bucketHeads = new Uint32Array(bucketBlock.data.buffer, bucketBlock.bufferByteOffset, this.bucketCount * BUCKET_SIZE);
	}

	get pointer(): number {
		return this.firstBlock.pointer;
	}

	get usedMemory(): number {
		let bucketBlock = new AllocatedMemory(this.memory, getPointer(loadRawPointer(this.firstBlock.data, BUCKET_POINTER_INDEX), this.memory.positionBits));
		return this.firstBlock.usedMemory + bucketBlock.usedMemory + this.entityPool.usedMemory + this.slotPool.usedMemory + this.idMap.usedMemory;
	}

	insert(id: number, x: number, y: number, width = 0, height = 0) {
		let minCol = this.colOf(x);
		let minRow = this.rowOf(y);
		let maxCol = this.colOf(x + width);
		let maxRow = this.rowOf(y + height);

		let entity = this.entityScratch;
		entity[ENTITY_MIN_COL] = minCol;
		entity[ENTITY_MIN_ROW] = minRow;
		entity[ENTITY_MAX_COL] = maxCol;
		entity[ENTITY_MAX_ROW] = maxRow;
		let entityIndex = this.entityPool.push(entity);
		this.idMap.set(id, entityIndex);

		this.linkRange(id, minCol, minRow, maxCol, maxRow);
	}

	// Move an entity to a new position. Assumes a single writer per entity id (the standard shared-memory pattern - each
	// worker owns a disjoint set of entities), so this entity's record is stable until we lock its bucket(s).
	update(id: number, x: number, y: number, width = 0, height = 0) {
		let entityIndex = this.idMap.get(id);
		if(entityIndex === undefined) {
			this.insert(id, x, y, width, height);
			return;
		}

		let block = this.entityPool.blockFor(entityIndex);
		let off = this.entityPool.blockOffset(entityIndex);
		let oldMinCol = block[off + ENTITY_MIN_COL];
		let oldMinRow = block[off + ENTITY_MIN_ROW];
		let oldMaxCol = block[off + ENTITY_MAX_COL];
		let oldMaxRow = block[off + ENTITY_MAX_ROW];

		let minCol = this.colOf(x);
		let minRow = this.rowOf(y);
		let maxCol = this.colOf(x + width);
		let maxRow = this.rowOf(y + height);

		// Same cell rectangle: membership is unchanged (query results depend only on which cells the entity occupies, not on
		// its exact coordinates), so there is nothing to relink.
		if(minCol === oldMinCol && minRow === oldMinRow && maxCol === oldMaxCol && maxRow === oldMaxRow) {
			return;
		}

		// Link the new cells before unlinking the old ones so a query racing the move sees the entity in its old or new
		// cells (or briefly both), never neither. The anchor is refreshed on the new slots.
		this.linkRange(id, minCol, minRow, maxCol, maxRow);
		this.unlinkRange(id, oldMinCol, oldMinRow, oldMaxCol, oldMaxRow);

		block[off + ENTITY_MIN_COL] = minCol;
		block[off + ENTITY_MIN_ROW] = minRow;
		block[off + ENTITY_MAX_COL] = maxCol;
		block[off + ENTITY_MAX_ROW] = maxRow;
	}

	remove(id: number): boolean {
		let entityIndex = this.idMap.get(id);
		if(entityIndex === undefined) {
			return false;
		}

		let block = this.entityPool.blockFor(entityIndex);
		let off = this.entityPool.blockOffset(entityIndex);
		this.unlinkRange(id, block[off + ENTITY_MIN_COL], block[off + ENTITY_MIN_ROW], block[off + ENTITY_MAX_COL], block[off + ENTITY_MAX_ROW]);

		this.entityPool.deleteIndex(entityIndex);
		this.idMap.delete(id);
		return true;
	}

	has(id: number): boolean {
		return this.idMap.get(id) !== undefined;
	}

	// Broad-phase query: ids of every entity occupying a cell that overlaps the query rect. Each entity is returned at most
	// once (see the anchor-cell dedup in collectBucket); the caller does the narrow-phase overlap check.
	retrieve(x: number, y: number, width: number, height: number): Array<number> {
		let out: Array<number> = [];
		this.retrieveInto(out, x, y, width, height);
		return out;
	}
	// Same as retrieve but appends into a caller-owned array so hot loops can reuse it. Returns the array.
	retrieveInto(out: Array<number>, x: number, y: number, width: number, height: number): Array<number> {
		let qMinCol = this.colOf(x);
		let qMinRow = this.rowOf(y);
		let qMaxCol = this.colOf(x + width);
		let qMaxRow = this.rowOf(y + height);

		let bucketHeads = this.bucketHeads;
		let nullIndex = this.nullIndex;
		for(let row = qMinRow; row <= qMaxRow; row++) {
			for(let col = qMinCol; col <= qMaxCol; col++) {
				let bucket = this.bucketOf(col, row);
				// Inline the empty-bucket peek (the common case) so an empty bucket never pays for a method call - most cells in
				// a typical query hash to empty buckets, so this skip dominates query cost.
				if(bucketHeads[bucket * BUCKET_SIZE + BUCKET_HEAD_OFFSET] === nullIndex) {
					continue;
				}
				this.collectBucket(out, bucket, col, row, qMinCol, qMinRow);
			}
		}
		return out;
	}

	clear() {
		for(let i = 0; i < this.bucketCount; i++) {
			this.bucketHeads[i * BUCKET_SIZE + BUCKET_HEAD_OFFSET] = this.nullIndex;
		}
		this.entityPool.clear();
		this.slotPool.clear();
		// SharedMap has no clear(); drop every key. Not safe to run concurrently with writers (documented on clear()).
		let keys: Array<number> = [];
		for(let [key] of this.idMap) {
			keys.push(key);
		}
		for(let key of keys) {
			this.idMap.delete(key);
		}
	}

	free() {
		let bucketBlock = new AllocatedMemory(this.memory, getPointer(loadRawPointer(this.firstBlock.data, BUCKET_POINTER_INDEX), this.memory.positionBits));
		bucketBlock.free();
		this.entityPool.free();
		this.slotPool.free();
		this.idMap.free();
		this.firstBlock.free();
	}

	getSharedMemory(): SharedSpatialMapMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}

	private getConfigView(): CoordArray {
		return makeArrayView(
			this.coordType,
			this.firstBlock.data.buffer,
			this.firstBlock.bufferByteOffset + CONFIG_INDEX * Uint32Array.BYTES_PER_ELEMENT,
			1,
		) as CoordArray;
	}

	private colOf(x: number): number {
		return Math.floor(x / this.cellSize);
	}
	private rowOf(y: number): number {
		return Math.floor(y / this.cellSize);
	}
	// Hash a virtual cell to one of the fixed buckets. col/row may be negative, so keep the mix unsigned before the modulo.
	private bucketOf(col: number, row: number): number {
		let hash = (Math.imul(col, HASH_PRIME_COL) ^ Math.imul(row, HASH_PRIME_ROW)) >>> 0;
		let mask = this.bucketMask;
		return mask >= 0 ? hash & mask : hash % this.bucketCount;
	}

	// Push one slot into each cell of the rectangle, carrying the cell's own (col, row) and the entity's top-left cell as
	// the dedup anchor. Every slot shares the id and anchor, so those are filled once before the loop.
	private linkRange(id: number, minCol: number, minRow: number, maxCol: number, maxRow: number) {
		let slot = this.slotScratch;
		slot[SLOT_ID] = id;
		slot[SLOT_ANCHOR_COL] = minCol;
		slot[SLOT_ANCHOR_ROW] = minRow;
		slot[SLOT_NEXT] = this.nullIndex;

		let pool = this.slotPool;
		let bucketInts = this.bucketInts;
		let bucketHeads = this.bucketHeads;
		for(let row = minRow; row <= maxRow; row++) {
			for(let col = minCol; col <= maxCol; col++) {
				slot[SLOT_COL] = col;
				slot[SLOT_ROW] = row;
				let slotIndex = pool.push(slot);
				let bucket = this.bucketOf(col, row);
				let lockIndex = bucket * BUCKET_SIZE + BUCKET_LOCK_OFFSET;
				lock(bucketInts, lockIndex);
				let headIndex = bucket * BUCKET_SIZE + BUCKET_HEAD_OFFSET;
				pool.set(slotIndex, SLOT_NEXT, bucketHeads[headIndex]);
				bucketHeads[headIndex] = slotIndex;
				unlock(bucketInts, lockIndex);
			}
		}
	}

	// Remove and recycle this entity's slot from each cell of the rectangle.
	private unlinkRange(id: number, minCol: number, minRow: number, maxCol: number, maxRow: number) {
		let nullIndex = this.nullIndex;
		let pool = this.slotPool;
		for(let row = minRow; row <= maxRow; row++) {
			for(let col = minCol; col <= maxCol; col++) {
				let slotIndex = this.unlinkFromBucket(this.bucketOf(col, row), id, col, row);
				if(slotIndex !== nullIndex) {
					pool.deleteIndex(slotIndex);
				}
			}
		}
	}

	// Caller has already peeked the head unlocked and skipped empty buckets (an empty bucket has nothing to read, so the
	// lock and its atomics would be pure overhead). Taking the lock only to walk a non-empty bucket preserves the snapshot
	// guarantee - a concurrent insert we race is simply not in this snapshot.
	private collectBucket(out: Array<number>, bucket: number, col: number, row: number, qMinCol: number, qMinRow: number) {
		let nullIndex = this.nullIndex;
		let bucketInts = this.bucketInts;
		let headIndex = bucket * BUCKET_SIZE + BUCKET_HEAD_OFFSET;
		let lockIndex = bucket * BUCKET_SIZE + BUCKET_LOCK_OFFSET;
		lock(bucketInts, lockIndex);
		let index = this.bucketHeads[headIndex];
		let pool = this.slotPool;
		while(index !== nullIndex) {
			// One chunk resolve per slot covers every field it reads
			let block = pool.blockFor(index);
			let off = pool.blockOffset(index);
			// Other cells hash to this bucket too; only slots living in the cell being queried count.
			if(block[off + SLOT_COL] === col && block[off + SLOT_ROW] === row) {
				// Emit only from the entity's top-left cell that intersects this query, so a multi-cell entity is returned once.
				let anchorCol = block[off + SLOT_ANCHOR_COL];
				let anchorRow = block[off + SLOT_ANCHOR_ROW];
				let tlCol = anchorCol > qMinCol ? anchorCol : qMinCol;
				let tlRow = anchorRow > qMinRow ? anchorRow : qMinRow;
				if(col === tlCol && row === tlRow) {
					out.push(block[off + SLOT_ID]);
				}
			}
			index = block[off + SLOT_NEXT];
		}
		unlock(bucketInts, lockIndex);
	}

	// Splice this entity's slot for exactly cell (col, row) out of the bucket and return its index (nullIndex if absent).
	// Matching on id and cell is required: two of an entity's own cells can hash to the same bucket, so id alone is ambiguous.
	private unlinkFromBucket(bucket: number, id: number, col: number, row: number): number {
		let nullIndex = this.nullIndex;
		let bucketInts = this.bucketInts;
		let bucketHeads = this.bucketHeads;
		let lockIndex = bucket * BUCKET_SIZE + BUCKET_LOCK_OFFSET;
		lock(bucketInts, lockIndex);
		let headIndex = bucket * BUCKET_SIZE + BUCKET_HEAD_OFFSET;
		let pool = this.slotPool;

		let prev = nullIndex;
		let index = bucketHeads[headIndex];
		while(index !== nullIndex) {
			// One chunk resolve per slot covers every field it reads
			let block = pool.blockFor(index);
			let off = pool.blockOffset(index);
			let next = block[off + SLOT_NEXT];
			if(block[off + SLOT_ID] === id && block[off + SLOT_COL] === col && block[off + SLOT_ROW] === row) {
				if(prev === nullIndex) {
					bucketHeads[headIndex] = next;
				} else {
					pool.set(prev, SLOT_NEXT, next);
				}
				unlock(bucketInts, lockIndex);
				return index;
			}
			prev = index;
			index = next;
		}

		unlock(bucketInts, lockIndex);
		return nullIndex;
	}
}

function getCoordTypeCode(type: CoordArrayConstructor | undefined): number {
	let code = getArrayTypeCode(type ?? DEFAULT_COORD_TYPE);
	if(code !== ARRAY_TYPE.float32 && code !== ARRAY_TYPE.float64) {
		throw new Error('SharedSpatialMap must be Float32Array or Float64Array');
	}
	return code;
}
function getCoordTypeConstructor(typeCode: number): CoordArrayConstructor {
	return getByteMultipler(typeCode) === 2 ? Float64Array : Float32Array;
}
function nullIndexFor(typeCode: number): number {
	return typeCode === ARRAY_TYPE.float32 ? FLOAT32_NULL_INDEX : FLOAT64_NULL_INDEX;
}

interface SharedSpatialMapConfig {
	gridSize?: number
	buckets?: number
	maxEntities?: number
	maxSlots?: number
	type?: CoordArrayConstructor
}
interface SharedSpatialMapMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedSpatialMapConfig, SharedSpatialMapMemory };
