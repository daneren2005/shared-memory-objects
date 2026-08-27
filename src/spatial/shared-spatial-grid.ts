import type { SharedAllocatedMemory } from '../allocated-memory';
import AllocatedMemory from '../allocated-memory';
import type MemoryHeap from '../memory-heap';
import SharedPool, { type SharedPoolConfig } from '../shared-pool';
import SharedMap from '../shared-map';
import { lock, unlock } from '../lock/simple-lock';
import { getPointer, loadRawPointer, storeRawPointer } from '../utils/pointer';
import { ARRAY_TYPE, getArrayTypeCode, getByteMultipler, makeArrayView } from '../utils/array-type';
import {
	MinPriorityQueue, addCandidate, candidateLimit, distanceSquaredToRect,
	type NeighborCandidate, type NearestNeighbor,
} from './spatial-neighbors';
import { getSpatialMapCapacity, getSpatialPoolChunkSize, type SpatialEntity } from './spatial-entity';

// Uniform fixed-grid spatial index ("spatial hash grid") built for concurrent updates from many threads. Like
// SharedQuadtree it avoids any runtime reshaping - the cols x rows array of cells is allocated once and never changes
// shape, so concurrency reduces to per-cell content updates and different cells never contend. Locating a cell is O(1)
// arithmetic instead of a tree descent, which tends to beat the quadtree for evenly distributed, similarly-sized entities.
//
// Unlike the quadtree (each entity in exactly one node), a grid entity occupies every cell its rect overlaps - so a large
// or straddling entity is linked into several cells at once. Each (entity, cell) membership is a "slot" record living in a
// SharedPool; each cell owns an intrusive singly-linked bucket of slots (cell record holds a lock and the head slot index,
// each slot carries the next index). The entity's occupied cell rectangle is stored once in a separate entity pool, keyed
// by an id->entityIndex SharedMap, so remove(id) (which only gets an id) knows which cells to unlink from.
//
// search returns each entity at most once even though it spans multiple cells: every slot carries the entity's anchor
// (top-left) cell, and a slot only emits its id when its cell is the top-left cell of the entity that intersects the query
// (col == max(anchorCol, qMinCol) && row == max(anchorRow, qMinRow)). That cell is always one of the entity's cells and
// inside the query, so exactly one slot emits - no Set and no per-query mutation, so concurrent queries stay safe.
//
// Records are stored at the configured precision. Float32 (the default) keeps everything exact as long as entity ids and
// both pools' index spaces stay under 2^24 (~16.7M) - every id, pool index, cell index and the NULL sentinel is Float32
// exact there. Need more (or ids >= 2^24)? Pass type: Float64Array.

// Header (firstBlock) u32 layout
const CELL_POINTER_INDEX = 0;
const ENTITY_POOL_POINTER_INDEX = 1;
const SLOT_POOL_POINTER_INDEX = 2;
const MAP_POINTER_INDEX = 3;
const COLS_INDEX = 4;
const ROWS_INDEX = 5;
const CELL_COUNT_INDEX = 6;
const TYPE_INDEX = 7;
// bounds view starts at slot 8 (offset 32 bytes is 8-byte aligned, so a Float64 view is valid): [x, y, width, height, gridSize]
const BOUNDS_INDEX = 8;

// Per-cell record: [lock, head]
const CELL_LOCK_OFFSET = 0;
const CELL_HEAD_OFFSET = 1;
const CELL_SIZE = 2;

// Slot record fields (one per entity-cell membership)
const SLOT_ID = 0;
const SLOT_ANCHOR_COL = 1;
const SLOT_ANCHOR_ROW = 2;
const SLOT_NEXT = 3;
const SLOT_FIELDS = 4;

// Entity record fields: the occupied cell rectangle
const ENTITY_MIN_COL = 0;
const ENTITY_MIN_ROW = 1;
const ENTITY_MAX_COL = 2;
const ENTITY_MAX_ROW = 3;
const ENTITY_X = 4;
const ENTITY_Y = 5;
const ENTITY_WIDTH = 6;
const ENTITY_HEIGHT = 7;
const ENTITY_FIELDS = 8;

// Largest exact integer range for Float32 coordinates: [0, 2^24). Ids and pool indices must stay under this to survive a
// Float32 round-trip, so it doubles as the Float32 entity cap and the value just past every valid index.
const FLOAT32_LIMIT = 0x1000000;
// End-of-list / empty-bucket sentinel, chosen per element type so it is exact in the pool's view and above every valid
// index: 2^24 for Float32 (its first non-representable index), 0xffffffff for Float64 (well within its exact range).
const FLOAT32_NULL_INDEX = FLOAT32_LIMIT;
const FLOAT64_NULL_INDEX = 0xffffffff;

const DEFAULT_GRID_SIZE = 50;
const DEFAULT_MAX_ENTITIES = 1_000_000;
// A grid entity can span several cells, so the slot pool needs headroom over the entity count
const DEFAULT_SLOTS_PER_ENTITY = 4;
const DEFAULT_COORD_TYPE = Float32Array;

type CoordArray = Float32Array | Float64Array;
type CoordArrayConstructor = Float32ArrayConstructor | Float64ArrayConstructor;

export default class SharedSpatialGrid {
	static readonly ALLOCATE_COUNT = 18;

	private memory: MemoryHeap;
	private firstBlock: AllocatedMemory;
	private entityPool: SharedPool<CoordArray>;
	private slotPool: SharedPool<CoordArray>;
	private idMap: SharedMap<number>;

	// Reused to hand a full record to pool.push without allocating a fresh array per operation (single writer per id)
	private entityScratch: Array<number> = [0, 0, 0, 0, 0, 0, 0, 0];
	private slotScratch: Array<number> = [0, 0, 0, 0];

	// Cell block views over one contiguous region: Int32 for the per-cell locks, Uint32 for the head indexes.
	private cellInts: Int32Array;
	private cellHeads: Uint32Array;

	private readonly coordType: number;
	// Empty-bucket / end-of-list sentinel for this instance's element type (see FLOAT32_NULL_INDEX)
	private readonly nullIndex: number;
	private readonly cols: number;
	private readonly rows: number;
	private readonly cellCount: number;
	// Grid origin and cell size, read once (stored at the configured precision, math done in float64)
	private readonly originX: number;
	private readonly originY: number;
	private readonly rootWidth: number;
	private readonly rootHeight: number;
	private readonly cellSize: number;

	// Number of entities currently tracked
	get size(): number {
		return this.idMap.length;
	}

	get bounds(): SpatialGridBounds {
		return { x: this.originX, y: this.originY, width: this.rootWidth, height: this.rootHeight };
	}

	get gridSize(): number {
		return this.cellSize;
	}
	get columns(): number {
		return this.cols;
	}
	get rowCount(): number {
		return this.rows;
	}

	// Element type the records are stored in (an ARRAY_TYPE code: float32 or float64)
	get type(): number {
		return this.coordType;
	}

	constructor(memory: MemoryHeap, config?: SharedSpatialGridConfig | SharedSpatialGridMemory) {
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
			this.cols = this.firstBlock.data[COLS_INDEX];
			this.rows = this.firstBlock.data[ROWS_INDEX];
			this.cellCount = this.firstBlock.data[CELL_COUNT_INDEX];
			this.nullIndex = nullIndexFor(this.coordType);
		} else {
			let bounds = config?.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
			let gridSize = config?.gridSize ?? DEFAULT_GRID_SIZE;
			let maxEntities = config?.maxEntities ?? DEFAULT_MAX_ENTITIES;
			let maxSlots = config?.maxSlots ?? maxEntities * DEFAULT_SLOTS_PER_ENTITY;
			this.coordType = getCoordTypeCode(config?.type);
			this.nullIndex = nullIndexFor(this.coordType);

			this.cols = Math.max(1, Math.ceil(bounds.width / gridSize));
			this.rows = Math.max(1, Math.ceil(bounds.height / gridSize));
			this.cellCount = this.cols * this.rows;

			if(this.coordType === ARRAY_TYPE.float32 && (maxEntities > FLOAT32_LIMIT || maxSlots > FLOAT32_LIMIT)) {
				throw new Error(`Float32 SharedSpatialGrid supports at most ${FLOAT32_LIMIT} entities and slots; pass type: Float64Array for more`);
			}

			// Inline the two pools' and the id-map's firstBlocks right after the header so the whole spine is one contiguous
			// allocation. The cell block stays separate: it is large and sized independently of these headers.
			let entityPoolConfig: SharedPoolConfig<CoordArray> = {
				type: getCoordTypeConstructor(this.coordType),
				dataLength: ENTITY_FIELDS,
				maxLength: maxEntities,
				maxChunkSize: getSpatialPoolChunkSize(maxEntities, ENTITY_FIELDS, getByteMultipler(this.coordType), memory.maxAllocationLength),
			};
			let slotPoolConfig: SharedPoolConfig<CoordArray> = {
				type: getCoordTypeConstructor(this.coordType),
				dataLength: SLOT_FIELDS,
				maxLength: maxSlots,
				maxChunkSize: getSpatialPoolChunkSize(maxSlots, SLOT_FIELDS, getByteMultipler(this.coordType), memory.maxAllocationLength),
			};
			let entityPoolAllocateCount = SharedPool.getAllocateCount(memory, entityPoolConfig);
			let slotPoolAllocateCount = SharedPool.getAllocateCount(memory, slotPoolConfig);
			let mapAllocateCount = SharedMap.ALLOCATE_COUNT;
			this.firstBlock = memory.allocUI32(SharedSpatialGrid.ALLOCATE_COUNT + entityPoolAllocateCount + slotPoolAllocateCount + mapAllocateCount);
			this.firstBlock.data[COLS_INDEX] = this.cols;
			this.firstBlock.data[ROWS_INDEX] = this.rows;
			this.firstBlock.data[CELL_COUNT_INDEX] = this.cellCount;
			this.firstBlock.data[TYPE_INDEX] = this.coordType;

			let boundsView = this.getBoundsView();
			boundsView[0] = bounds.x;
			boundsView[1] = bounds.y;
			boundsView[2] = bounds.width;
			boundsView[3] = bounds.height;
			boundsView[4] = gridSize;

			// Cell block must fit one allocation - it is never resized. Every head starts as NULL (calloc leaves them 0, a
			// valid slot index, so they must be initialized explicitly).
			let cellBlock = memory.allocUI32(this.cellCount * CELL_SIZE);
			let heads = new Uint32Array(cellBlock.data.buffer, cellBlock.bufferByteOffset, this.cellCount * CELL_SIZE);
			for(let i = 0; i < this.cellCount; i++) {
				heads[i * CELL_SIZE + CELL_HEAD_OFFSET] = this.nullIndex;
			}
			storeRawPointer(this.firstBlock.data, CELL_POINTER_INDEX, cellBlock.pointer);

			let entityPoolBlock = this.firstBlock.getSubAllocation(SharedSpatialGrid.ALLOCATE_COUNT, entityPoolAllocateCount);
			this.entityPool = new SharedPool<CoordArray>(memory, { firstBlock: entityPoolBlock, ...entityPoolConfig });
			storeRawPointer(this.firstBlock.data, ENTITY_POOL_POINTER_INDEX, entityPoolBlock.pointer);

			let slotPoolBlock = this.firstBlock.getSubAllocation(SharedSpatialGrid.ALLOCATE_COUNT + entityPoolAllocateCount, slotPoolAllocateCount);
			this.slotPool = new SharedPool<CoordArray>(memory, { firstBlock: slotPoolBlock, ...slotPoolConfig });
			storeRawPointer(this.firstBlock.data, SLOT_POOL_POINTER_INDEX, slotPoolBlock.pointer);

			let mapBlock = this.firstBlock.getSubAllocation(SharedSpatialGrid.ALLOCATE_COUNT + entityPoolAllocateCount + slotPoolAllocateCount, mapAllocateCount);
			this.idMap = new SharedMap<number>(memory, { firstBlock: mapBlock, capacity: getSpatialMapCapacity(maxEntities, memory.maxAllocationLength) });
			storeRawPointer(this.firstBlock.data, MAP_POINTER_INDEX, mapBlock.pointer);
		}

		let boundsView = this.getBoundsView();
		this.originX = boundsView[0];
		this.originY = boundsView[1];
		this.rootWidth = boundsView[2];
		this.rootHeight = boundsView[3];
		this.cellSize = boundsView[4];

		let cellBlock = new AllocatedMemory(memory, getPointer(loadRawPointer(this.firstBlock.data, CELL_POINTER_INDEX), memory.positionBits));
		this.cellInts = new Int32Array(cellBlock.data.buffer, cellBlock.bufferByteOffset, this.cellCount * CELL_SIZE);
		this.cellHeads = new Uint32Array(cellBlock.data.buffer, cellBlock.bufferByteOffset, this.cellCount * CELL_SIZE);
	}

	get pointer(): number {
		return this.firstBlock.pointer;
	}

	get usedMemory(): number {
		let cellBlock = new AllocatedMemory(this.memory, getPointer(loadRawPointer(this.firstBlock.data, CELL_POINTER_INDEX), this.memory.positionBits));
		return this.firstBlock.usedMemory + cellBlock.usedMemory + this.entityPool.usedMemory + this.slotPool.usedMemory + this.idMap.usedMemory;
	}

	insert(id: number, x: number, y: number, width = 0, height = 0) {
		if(this.idMap.get(id) !== undefined) {
			this.update(id, x, y, width, height);
			return;
		}

		let minCol = this.colOf(x);
		let minRow = this.rowOf(y);
		let maxCol = this.colOf(x + width);
		let maxRow = this.rowOf(y + height);

		let entity = this.entityScratch;
		entity[ENTITY_MIN_COL] = minCol;
		entity[ENTITY_MIN_ROW] = minRow;
		entity[ENTITY_MAX_COL] = maxCol;
		entity[ENTITY_MAX_ROW] = maxRow;
		entity[ENTITY_X] = x;
		entity[ENTITY_Y] = y;
		entity[ENTITY_WIDTH] = width;
		entity[ENTITY_HEIGHT] = height;
		let entityIndex = this.entityPool.push(entity);
		this.idMap.set(id, entityIndex);

		this.linkRange(id, minCol, minRow, maxCol, maxRow);
	}

	bulkInsert(entities: Iterable<SpatialEntity>) {
		let byId = new Map<number, SpatialEntity>();
		for(let entity of entities) {
			byId.set(entity.id, entity);
		}
		let unique = Array.from(byId.values());
		let existing = this.idMap.getAll(unique.map(entity => entity.id));
		let mappings: Array<readonly [number, number]> = [];
		let newCount = 0;
		let newSlotCount = 0;
		for(let i = 0; i < unique.length; i++) {
			if(existing[i] === undefined) {
				let entity = unique[i];
				newCount++;
				newSlotCount += (this.colOf(entity.x + (entity.width ?? 0)) - this.colOf(entity.x) + 1)
					* (this.rowOf(entity.y + (entity.height ?? 0)) - this.rowOf(entity.y) + 1);
			}
		}
		let nextEntityIndex = this.entityPool.reserveContiguous(newCount);
		let nextSlotIndex = this.slotPool.reserveContiguous(newSlotCount);
		for(let i = 0; i < unique.length; i++) {
			let entity = unique[i];
			let width = entity.width ?? 0;
			let height = entity.height ?? 0;
			if(existing[i] !== undefined) {
				this.update(entity.id, entity.x, entity.y, width, height);
				continue;
			}

			let minCol = this.colOf(entity.x);
			let minRow = this.rowOf(entity.y);
			let maxCol = this.colOf(entity.x + width);
			let maxRow = this.rowOf(entity.y + height);
			let entityIndex = nextEntityIndex++;
			let block = this.entityPool.blockFor(entityIndex);
			let offset = this.entityPool.blockOffset(entityIndex);
			block[offset + ENTITY_MIN_COL] = minCol;
			block[offset + ENTITY_MIN_ROW] = minRow;
			block[offset + ENTITY_MAX_COL] = maxCol;
			block[offset + ENTITY_MAX_ROW] = maxRow;
			block[offset + ENTITY_X] = entity.x;
			block[offset + ENTITY_Y] = entity.y;
			block[offset + ENTITY_WIDTH] = width;
			block[offset + ENTITY_HEIGHT] = height;
			mappings.push([entity.id, entityIndex]);
			for(let row = minRow; row <= maxRow; row++) {
				let rowBase = row * this.cols;
				for(let col = minCol; col <= maxCol; col++) {
					this.linkReservedCell(rowBase + col, nextSlotIndex++, entity.id, minCol, minRow);
				}
			}
		}
		this.idMap.setAll(mappings);
	}

	// Move an entity to a new position. Assumes a single writer per entity id (the standard shared-memory pattern - each
	// worker owns a disjoint set of entities), so this entity's record is stable until we lock its cell(s).
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

		// Same cell rectangle: membership is unchanged, but neighbors still needs the new exact rectangle.
		if(minCol === oldMinCol && minRow === oldMinRow && maxCol === oldMaxCol && maxRow === oldMaxRow) {
			block[off + ENTITY_X] = x;
			block[off + ENTITY_Y] = y;
			block[off + ENTITY_WIDTH] = width;
			block[off + ENTITY_HEIGHT] = height;
			return;
		}

		this.relinkRange(id, minCol, minRow, maxCol, maxRow, oldMinCol, oldMinRow, oldMaxCol, oldMaxRow);

		block[off + ENTITY_MIN_COL] = minCol;
		block[off + ENTITY_MIN_ROW] = minRow;
		block[off + ENTITY_MAX_COL] = maxCol;
		block[off + ENTITY_MAX_ROW] = maxRow;
		block[off + ENTITY_X] = x;
		block[off + ENTITY_Y] = y;
		block[off + ENTITY_WIDTH] = width;
		block[off + ENTITY_HEIGHT] = height;
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
	// once (see the anchor-cell dedup in collectCell); the caller does the narrow-phase overlap check.
	search(x: number, y: number, width: number, height: number, filter?: (id: number) => boolean): Array<number> {
		let out: Array<number> = [];
		this.searchInto(out, x, y, width, height, filter);
		return out;
	}
	// Same as search but appends into a caller-owned array so hot loops can reuse it. Returns the array.
	searchInto(out: Array<number>, x: number, y: number, width: number, height: number, filter?: (id: number) => boolean): Array<number> {
		let start = out.length;
		let qMinCol = this.colOf(x);
		let qMinRow = this.rowOf(y);
		let qMaxCol = this.colOf(x + width);
		let qMaxRow = this.rowOf(y + height);

		let cols = this.cols;
		let cellHeads = this.cellHeads;
		let nullIndex = this.nullIndex;
		for(let row = qMinRow; row <= qMaxRow; row++) {
			let rowBase = row * cols;
			for(let col = qMinCol; col <= qMaxCol; col++) {
				let cell = rowBase + col;
				// Inline the empty-bucket peek (the common case) so an empty cell never pays for a method call - most cells in
				// a typical query are empty, so this skip dominates query cost.
				if(cellHeads[cell * CELL_SIZE + CELL_HEAD_OFFSET] === nullIndex) {
					continue;
				}
				this.collectCell(out, cell, col, row, qMinCol, qMinRow);
			}
		}
		if(filter !== undefined) {
			let write = start;
			for(let read = start; read < out.length; read++) {
				let id = out[read];
				if(filter(id)) {
					out[write++] = id;
				}
			}
			out.length = write;
		}
		return out;
	}

	neighbors(x: number, y: number, maxResults: number, maxDistance: number, filter?: (id: number) => boolean): Array<number> {
		if(maxResults <= 0 || maxDistance < 0 || Number.isNaN(maxResults) || Number.isNaN(maxDistance)) {
			return [];
		}

		maxResults = Math.floor(maxResults);
		if(maxResults === 0) {
			return [];
		}
		let maxDistanceSquared = maxDistance * maxDistance;
		if(maxResults > 1) {
			return this.neighborsBestFirst(x, y, maxResults, maxDistanceSquared, filter);
		}
		let cellIds: Array<number> = [];
		let startCol = this.colOf(x);
		let startRow = this.rowOf(y);
		let nearest: NearestNeighbor = { id: undefined, distance: maxDistanceSquared };
		let visit = (col: number, row: number) => {
			let cell = row * this.cols + col;
			if(filter === undefined) {
				this.collectNearestCell(nearest, cell, x, y);
				return;
			}
			cellIds.length = 0;
			this.collectNeighborCell(cellIds, cell);
			for(let id of cellIds) {
				if(!filter(id)) {
					continue;
				}
				let entityIndex = this.idMap.get(id);
				if(entityIndex !== undefined) {
					let entity = this.entityPool.blockFor(entityIndex);
					let entityOffset = this.entityPool.blockOffset(entityIndex);
					let minX = entity[entityOffset + ENTITY_X];
					let minY = entity[entityOffset + ENTITY_Y];
					let distance = distanceSquaredToRect(
						x, y, minX, minY,
						minX + entity[entityOffset + ENTITY_WIDTH], minY + entity[entityOffset + ENTITY_HEIGHT],
					);
					if(distance < nearest.distance || (distance === nearest.distance && (nearest.id === undefined || id < nearest.id))) {
						nearest.id = id;
						nearest.distance = distance;
					}
				}
			}
		};

		let maxRadius = Math.max(startCol, this.cols - 1 - startCol, startRow, this.rows - 1 - startRow);
		for(let radius = 0; radius <= maxRadius; radius++) {
			if(this.gridRingDistanceSquared(x, y, startCol, startRow, radius) > nearest.distance) {
				break;
			}
			if(radius === 0) {
				visit(startCol, startRow);
				continue;
			}
			let minCol = Math.max(0, startCol - radius);
			let maxCol = Math.min(this.cols - 1, startCol + radius);
			let top = startRow - radius;
			let bottom = startRow + radius;
			if(top >= 0) {
				for(let col = minCol; col <= maxCol; col++) {
					visit(col, top);
				}
			}
			if(bottom < this.rows) {
				for(let col = minCol; col <= maxCol; col++) {
					visit(col, bottom);
				}
			}
			let minRow = Math.max(0, startRow - radius + 1);
			let maxRow = Math.min(this.rows - 1, startRow + radius - 1);
			let left = startCol - radius;
			let right = startCol + radius;
			if(left >= 0) {
				for(let row = minRow; row <= maxRow; row++) {
					visit(left, row);
				}
			}
			if(right < this.cols) {
				for(let row = minRow; row <= maxRow; row++) {
					visit(right, row);
				}
			}
		}

		return nearest.id === undefined ? [] : [nearest.id];
	}

	private neighborsBestFirst(
		x: number, y: number, maxResults: number, maxDistanceSquared: number,
		filter: ((id: number) => boolean) | undefined,
	): Array<number> {
		let candidates: Array<NeighborCandidate> = [];
		let cellIds: Array<number> = [];
		let seenEntities = new Set<number>();
		let seenCells = new Uint8Array(this.cellCount);
		let queue = new MinPriorityQueue<number>();
		let enqueue = (col: number, row: number) => {
			if(col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
				return;
			}
			let cell = row * this.cols + col;
			if(seenCells[cell] !== 0) {
				return;
			}
			seenCells[cell] = 1;
			let minX = this.originX + col * this.cellSize;
			let minY = this.originY + row * this.cellSize;
			queue.push(cell, distanceSquaredToRect(x, y, minX, minY, minX + this.cellSize, minY + this.cellSize));
		};
		enqueue(this.colOf(x), this.rowOf(y));
		while(queue.length > 0 && queue.priority <= candidateLimit(candidates, maxResults, maxDistanceSquared)) {
			let cell = queue.pop();
			if(cell === undefined) {
				break;
			}
			cellIds.length = 0;
			this.collectNeighborCell(cellIds, cell);
			for(let id of cellIds) {
				if(seenEntities.has(id)) {
					continue;
				}
				seenEntities.add(id);
				if(filter !== undefined && !filter(id)) {
					continue;
				}
				let entityIndex = this.idMap.get(id);
				if(entityIndex === undefined) {
					continue;
				}
				let entity = this.entityPool.blockFor(entityIndex);
				let entityOffset = this.entityPool.blockOffset(entityIndex);
				let minX = entity[entityOffset + ENTITY_X];
				let minY = entity[entityOffset + ENTITY_Y];
				let distance = distanceSquaredToRect(
					x, y, minX, minY,
					minX + entity[entityOffset + ENTITY_WIDTH], minY + entity[entityOffset + ENTITY_HEIGHT],
				);
				if(distance <= maxDistanceSquared) {
					addCandidate(candidates, id, distance, maxResults);
				}
			}
			let col = cell % this.cols;
			let row = Math.floor(cell / this.cols);
			enqueue(col - 1, row);
			enqueue(col + 1, row);
			enqueue(col, row - 1);
			enqueue(col, row + 1);
		}
		return candidates.map(candidate => candidate.id);
	}

	clear() {
		for(let i = 0; i < this.cellCount; i++) {
			this.cellHeads[i * CELL_SIZE + CELL_HEAD_OFFSET] = this.nullIndex;
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
		let cellBlock = new AllocatedMemory(this.memory, getPointer(loadRawPointer(this.firstBlock.data, CELL_POINTER_INDEX), this.memory.positionBits));
		cellBlock.free();
		this.entityPool.free();
		this.slotPool.free();
		this.idMap.free();
		this.firstBlock.free();
	}

	getSharedMemory(): SharedSpatialGridMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}

	private getBoundsView(): CoordArray {
		return makeArrayView(
			this.coordType,
			this.firstBlock.data.buffer,
			this.firstBlock.bufferByteOffset + BOUNDS_INDEX * Uint32Array.BYTES_PER_ELEMENT,
			5,
		) as CoordArray;
	}

	private colOf(x: number): number {
		let col = Math.floor((x - this.originX) / this.cellSize);
		return col < 0 ? 0 : col >= this.cols ? this.cols - 1 : col;
	}
	private rowOf(y: number): number {
		let row = Math.floor((y - this.originY) / this.cellSize);
		return row < 0 ? 0 : row >= this.rows ? this.rows - 1 : row;
	}

	private gridRingDistanceSquared(x: number, y: number, centerCol: number, centerRow: number, radius: number): number {
		if(radius === 0) {
			let minX = this.originX + centerCol * this.cellSize;
			let minY = this.originY + centerRow * this.cellSize;
			return distanceSquaredToRect(x, y, minX, minY, minX + this.cellSize, minY + this.cellSize);
		}

		let minDistance = Infinity;
		let minCol = Math.max(0, centerCol - radius);
		let maxCol = Math.min(this.cols - 1, centerCol + radius);
		let minRow = Math.max(0, centerRow - radius);
		let maxRow = Math.min(this.rows - 1, centerRow + radius);
		let left = centerCol - radius;
		let right = centerCol + radius;
		let top = centerRow - radius;
		let bottom = centerRow + radius;
		let cellSize = this.cellSize;
		let originX = this.originX;
		let originY = this.originY;
		if(top >= 0) {
			minDistance = distanceSquaredToRect(
				x, y, originX + minCol * cellSize, originY + top * cellSize,
				originX + (maxCol + 1) * cellSize, originY + (top + 1) * cellSize,
			);
		}
		if(bottom < this.rows) {
			minDistance = Math.min(minDistance, distanceSquaredToRect(
				x, y, originX + minCol * cellSize, originY + bottom * cellSize,
				originX + (maxCol + 1) * cellSize, originY + (bottom + 1) * cellSize,
			));
		}
		if(left >= 0) {
			minDistance = Math.min(minDistance, distanceSquaredToRect(
				x, y, originX + left * cellSize, originY + minRow * cellSize,
				originX + (left + 1) * cellSize, originY + (maxRow + 1) * cellSize,
			));
		}
		if(right < this.cols) {
			minDistance = Math.min(minDistance, distanceSquaredToRect(
				x, y, originX + right * cellSize, originY + minRow * cellSize,
				originX + (right + 1) * cellSize, originY + (maxRow + 1) * cellSize,
			));
		}
		return minDistance;
	}

	// Push one slot into each cell of the rectangle, carrying the entity's top-left cell as the dedup anchor. Every slot
	// carries the same record, so the scratch is filled once before the loop.
	private linkRange(id: number, minCol: number, minRow: number, maxCol: number, maxRow: number) {
		let slot = this.slotScratch;
		slot[SLOT_ID] = id;
		slot[SLOT_ANCHOR_COL] = minCol;
		slot[SLOT_ANCHOR_ROW] = minRow;
		slot[SLOT_NEXT] = this.nullIndex;

		let cols = this.cols;
		for(let row = minRow; row <= maxRow; row++) {
			let rowBase = row * cols;
			for(let col = minCol; col <= maxCol; col++) {
				this.linkIntoCell(rowBase + col, slot);
			}
		}
	}

	// Push a fresh slot carrying the given record onto the head of one cell's bucket.
	private linkIntoCell(cell: number, slot: Array<number>) {
		let pool = this.slotPool;
		let cellInts = this.cellInts;
		let cellHeads = this.cellHeads;
		let slotIndex = pool.push(slot);
		let lockIndex = cell * CELL_SIZE + CELL_LOCK_OFFSET;
		let headIndex = cell * CELL_SIZE + CELL_HEAD_OFFSET;
		lock(cellInts, lockIndex);
		pool.set(slotIndex, SLOT_NEXT, cellHeads[headIndex]);
		cellHeads[headIndex] = slotIndex;
		unlock(cellInts, lockIndex);
	}

	// Move an entity's slots from its old cell rectangle to a new one, touching only the cells that actually change. A cell
	// in both rectangles keeps its slot and just gets its anchor refreshed; new-only cells are linked before old-only cells
	// are unlinked, so a query racing the move never sees the entity in neither rectangle. Doing it this way (rather than
	// linkRange(new) + unlinkRange(old)) is what keeps overlap cells correct: unlinkRange matches by id and would splice out
	// the freshly linked slot in an overlap cell, leaving the stale one behind and corrupting the dedup anchor.
	private relinkRange(id: number, minCol: number, minRow: number, maxCol: number, maxRow: number, oldMinCol: number, oldMinRow: number, oldMaxCol: number, oldMaxRow: number) {
		let ovMinCol = minCol > oldMinCol ? minCol : oldMinCol;
		let ovMaxCol = maxCol < oldMaxCol ? maxCol : oldMaxCol;
		let ovMinRow = minRow > oldMinRow ? minRow : oldMinRow;
		let ovMaxRow = maxRow < oldMaxRow ? maxRow : oldMaxRow;
		let hasOverlap = ovMinCol <= ovMaxCol && ovMinRow <= ovMaxRow;

		let slot = this.slotScratch;
		slot[SLOT_ID] = id;
		slot[SLOT_ANCHOR_COL] = minCol;
		slot[SLOT_ANCHOR_ROW] = minRow;
		slot[SLOT_NEXT] = this.nullIndex;

		let cols = this.cols;
		for(let row = minRow; row <= maxRow; row++) {
			let inOverlapRow = hasOverlap && row >= ovMinRow && row <= ovMaxRow;
			let rowBase = row * cols;
			for(let col = minCol; col <= maxCol; col++) {
				let cell = rowBase + col;
				if(inOverlapRow && col >= ovMinCol && col <= ovMaxCol) {
					this.refreshAnchorInCell(cell, id, minCol, minRow);
				} else {
					this.linkIntoCell(cell, slot);
				}
			}
		}

		let nullIndex = this.nullIndex;
		let pool = this.slotPool;
		for(let row = oldMinRow; row <= oldMaxRow; row++) {
			let inOverlapRow = hasOverlap && row >= ovMinRow && row <= ovMaxRow;
			let rowBase = row * cols;
			for(let col = oldMinCol; col <= oldMaxCol; col++) {
				if(inOverlapRow && col >= ovMinCol && col <= ovMaxCol) {
					continue;
				}
				let slotIndex = this.unlinkFromCell(rowBase + col, id);
				if(slotIndex !== nullIndex) {
					pool.deleteIndex(slotIndex);
				}
			}
		}
	}

	// Refresh the anchor on this entity's slot already linked into the cell (single writer per id, so it is present).
	private refreshAnchorInCell(cell: number, id: number, anchorCol: number, anchorRow: number) {
		let nullIndex = this.nullIndex;
		let cellInts = this.cellInts;
		let lockIndex = cell * CELL_SIZE + CELL_LOCK_OFFSET;
		lock(cellInts, lockIndex);
		let pool = this.slotPool;
		let index = this.cellHeads[cell * CELL_SIZE + CELL_HEAD_OFFSET];
		while(index !== nullIndex) {
			let block = pool.blockFor(index);
			let off = pool.blockOffset(index);
			if(block[off + SLOT_ID] === id) {
				block[off + SLOT_ANCHOR_COL] = anchorCol;
				block[off + SLOT_ANCHOR_ROW] = anchorRow;
				break;
			}
			index = block[off + SLOT_NEXT];
		}
		unlock(cellInts, lockIndex);
	}

	// Remove and recycle this entity's slot from each cell of the rectangle.
	private unlinkRange(id: number, minCol: number, minRow: number, maxCol: number, maxRow: number) {
		let cols = this.cols;
		let nullIndex = this.nullIndex;
		let pool = this.slotPool;
		for(let row = minRow; row <= maxRow; row++) {
			let rowBase = row * cols;
			for(let col = minCol; col <= maxCol; col++) {
				let slotIndex = this.unlinkFromCell(rowBase + col, id);
				if(slotIndex !== nullIndex) {
					pool.deleteIndex(slotIndex);
				}
			}
		}
	}

	// Caller has already peeked the head unlocked and skipped empty cells (an empty bucket has nothing to read, so the lock
	// and its atomics would be pure overhead). Taking the lock only to walk a non-empty bucket preserves the snapshot
	// guarantee - a concurrent insert we race is simply not in this snapshot.
	private collectCell(out: Array<number>, cell: number, col: number, row: number, qMinCol: number, qMinRow: number) {
		let nullIndex = this.nullIndex;
		let cellInts = this.cellInts;
		let headIndex = cell * CELL_SIZE + CELL_HEAD_OFFSET;
		let lockIndex = cell * CELL_SIZE + CELL_LOCK_OFFSET;
		lock(cellInts, lockIndex);
		let index = this.cellHeads[headIndex];
		let pool = this.slotPool;
		while(index !== nullIndex) {
			// One chunk resolve per slot covers every field it reads
			let block = pool.blockFor(index);
			let off = pool.blockOffset(index);
			// Emit only from the entity's top-left cell that intersects this query, so a multi-cell entity is returned once.
			let anchorCol = block[off + SLOT_ANCHOR_COL];
			let anchorRow = block[off + SLOT_ANCHOR_ROW];
			let tlCol = anchorCol > qMinCol ? anchorCol : qMinCol;
			let tlRow = anchorRow > qMinRow ? anchorRow : qMinRow;
			if(col === tlCol && row === tlRow) {
				out.push(block[off + SLOT_ID]);
			}
			index = block[off + SLOT_NEXT];
		}
		unlock(cellInts, lockIndex);
	}

	private linkReservedCell(cell: number, slotIndex: number, id: number, anchorCol: number, anchorRow: number) {
		let pool = this.slotPool;
		let block = pool.blockFor(slotIndex);
		let offset = pool.blockOffset(slotIndex);
		block[offset + SLOT_ID] = id;
		block[offset + SLOT_ANCHOR_COL] = anchorCol;
		block[offset + SLOT_ANCHOR_ROW] = anchorRow;
		let lockIndex = cell * CELL_SIZE + CELL_LOCK_OFFSET;
		lock(this.cellInts, lockIndex);
		let headIndex = cell * CELL_SIZE + CELL_HEAD_OFFSET;
		block[offset + SLOT_NEXT] = this.cellHeads[headIndex];
		this.cellHeads[headIndex] = slotIndex;
		unlock(this.cellInts, lockIndex);
	}

	private collectNeighborCell(out: Array<number>, cell: number) {
		let headIndex = cell * CELL_SIZE + CELL_HEAD_OFFSET;
		if(this.cellHeads[headIndex] === this.nullIndex) {
			return;
		}
		let lockIndex = cell * CELL_SIZE + CELL_LOCK_OFFSET;
		lock(this.cellInts, lockIndex);
		let index = this.cellHeads[headIndex];
		while(index !== this.nullIndex) {
			let block = this.slotPool.blockFor(index);
			let off = this.slotPool.blockOffset(index);
			out.push(block[off + SLOT_ID]);
			index = block[off + SLOT_NEXT];
		}
		unlock(this.cellInts, lockIndex);
	}

	private collectNearestCell(nearest: NearestNeighbor, cell: number, x: number, y: number) {
		let headIndex = cell * CELL_SIZE + CELL_HEAD_OFFSET;
		if(this.cellHeads[headIndex] === this.nullIndex) {
			return;
		}
		let lockIndex = cell * CELL_SIZE + CELL_LOCK_OFFSET;
		lock(this.cellInts, lockIndex);
		let index = this.cellHeads[headIndex];
		while(index !== this.nullIndex) {
			let slot = this.slotPool.blockFor(index);
			let slotOffset = this.slotPool.blockOffset(index);
			let id = slot[slotOffset + SLOT_ID];
			let entityIndex = this.idMap.get(id);
			if(entityIndex !== undefined) {
				let entity = this.entityPool.blockFor(entityIndex);
				let entityOffset = this.entityPool.blockOffset(entityIndex);
				let minX = entity[entityOffset + ENTITY_X];
				let minY = entity[entityOffset + ENTITY_Y];
				let distance = distanceSquaredToRect(
					x, y, minX, minY,
					minX + entity[entityOffset + ENTITY_WIDTH], minY + entity[entityOffset + ENTITY_HEIGHT],
				);
				if(distance < nearest.distance
					|| (distance === nearest.distance && (nearest.id === undefined || id < nearest.id))) {
					nearest.id = id;
					nearest.distance = distance;
				}
			}
			index = slot[slotOffset + SLOT_NEXT];
		}
		unlock(this.cellInts, lockIndex);
	}

	// Splice this entity's slot out of the cell's bucket and return its index (nullIndex if the cell held no slot for it).
	private unlinkFromCell(cell: number, id: number): number {
		let nullIndex = this.nullIndex;
		let cellInts = this.cellInts;
		let cellHeads = this.cellHeads;
		let lockIndex = cell * CELL_SIZE + CELL_LOCK_OFFSET;
		lock(cellInts, lockIndex);
		let headIndex = cell * CELL_SIZE + CELL_HEAD_OFFSET;
		let pool = this.slotPool;

		let prev = nullIndex;
		let index = cellHeads[headIndex];
		while(index !== nullIndex) {
			// One chunk resolve per slot covers both fields it reads
			let block = pool.blockFor(index);
			let off = pool.blockOffset(index);
			let next = block[off + SLOT_NEXT];
			if(block[off + SLOT_ID] === id) {
				if(prev === nullIndex) {
					cellHeads[headIndex] = next;
				} else {
					pool.set(prev, SLOT_NEXT, next);
				}
				unlock(cellInts, lockIndex);
				return index;
			}
			prev = index;
			index = next;
		}

		unlock(cellInts, lockIndex);
		return nullIndex;
	}
}

function getCoordTypeCode(type: CoordArrayConstructor | undefined): number {
	let code = getArrayTypeCode(type ?? DEFAULT_COORD_TYPE);
	if(code !== ARRAY_TYPE.float32 && code !== ARRAY_TYPE.float64) {
		throw new Error('SharedSpatialGrid must be Float32Array or Float64Array');
	}
	return code;
}
function getCoordTypeConstructor(typeCode: number): CoordArrayConstructor {
	return getByteMultipler(typeCode) === 2 ? Float64Array : Float32Array;
}
function nullIndexFor(typeCode: number): number {
	return typeCode === ARRAY_TYPE.float32 ? FLOAT32_NULL_INDEX : FLOAT64_NULL_INDEX;
}

interface SpatialGridBounds {
	x: number
	y: number
	width: number
	height: number
}
interface SharedSpatialGridConfig {
	bounds: SpatialGridBounds
	gridSize?: number
	maxEntities?: number
	maxSlots?: number
	type?: CoordArrayConstructor
}
interface SharedSpatialGridMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedSpatialGridConfig, SharedSpatialGridMemory, SpatialGridBounds, SpatialEntity };
