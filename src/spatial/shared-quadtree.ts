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

// Fixed-depth region quadtree ("implicit" / hierarchical grid) built for concurrent updates from many threads. Dynamic
// subdivision is deliberately avoided: creating/redistributing/freeing nodes at runtime races with readers mid-traversal
// (the same hazard MemoryBuffer disables compaction for). Here the tree of nodes is allocated once and never changes
// shape, so concurrency reduces to per-cell content updates - different cells never contend.
//
// Node layout is implicit: node 0 is the root, the four children of node i are 4i+1..4i+4 (NW, NE, SW, SE). Bounds are
// derived from the root bounds during descent, never stored. Each node owns an intrusive singly-linked bucket: the node
// record holds a lock and the head item index, and each item record carries the next index. Items live in a SharedPool
// (stable indices, recycling) and an id->itemIndex SharedMap makes update/remove O(depth) by entity id.
//
// Each entity is stored in the single deepest node that fully contains its rect (an item too large or straddling a
// midline stays at an ancestor). search walks every node whose region intersects the query and returns a broad-phase
// superset of candidate ids - the same guarantee quadtree-js's retrieve gives, without duplicating straddlers.
//
// The whole item record (id, coords, node, bucket link) lives in one pool at the configured precision. Float32 (the
// default, matching a physics engine that keeps positions in Float32) keeps everything exact as long as entity ids and
// the pool's index space both stay under 2^24 (~16.7M) - every id, pool index, node index and the NULL sentinel is a
// Float32-exact integer there. Need more than that many entities (or ids >= 2^24)? Pass type: Float64Array.

// Header (firstBlock) u32 layout
const NODE_POINTER_INDEX = 0;
const POOL_POINTER_INDEX = 1;
const MAP_POINTER_INDEX = 2;
const MAX_LEVELS_INDEX = 3;
const NODE_COUNT_INDEX = 4;
const TYPE_INDEX = 5;
// bounds view starts at slot 6 (offset 24 bytes is 8-byte aligned, so a Float64 bounds view is valid)
const BOUNDS_INDEX = 6;

// Per-node record: [lock, head]
const NODE_LOCK_OFFSET = 0;
const NODE_HEAD_OFFSET = 1;
const NODE_SIZE = 2;

// Item record fields
const ITEM_ID = 0;
const ITEM_X = 1;
const ITEM_Y = 2;
const ITEM_W = 3;
const ITEM_H = 4;
const ITEM_NODE = 5;
const ITEM_NEXT = 6;
const ITEM_FIELDS = 7;

// Largest exact integer range for Float32 coordinates: [0, 2^24). Ids and pool indices must stay under this to survive a
// Float32 round-trip, so it doubles as the Float32 entity cap and the value just past every valid index.
const FLOAT32_LIMIT = 0x1000000;
// End-of-list / empty-bucket sentinel, chosen per element type so it is exact in the pool's view and above every valid
// index: 2^24 for Float32 (its first non-representable index), 0xffffffff for Float64 (well within its exact range).
const FLOAT32_NULL_INDEX = FLOAT32_LIMIT;
const FLOAT64_NULL_INDEX = 0xffffffff;

const DEFAULT_MAX_LEVELS = 4;
const DEFAULT_MAX_ENTITIES = 1_000_000;
const DEFAULT_COORD_TYPE = Float32Array;

type CoordArray = Float32Array | Float64Array;
type CoordArrayConstructor = Float32ArrayConstructor | Float64ArrayConstructor;

export default class SharedQuadtree {
	static readonly ALLOCATE_COUNT = 14;

	private memory: MemoryHeap;
	private firstBlock: AllocatedMemory;
	private pool: SharedPool<CoordArray>;
	private idMap: SharedMap<number>;

	// Reused to hand a full item record to pool.push without allocating a fresh array per insert (single writer per id)
	private insertScratch: Array<number> = [0, 0, 0, 0, 0, 0, 0];

	// Node block views over one contiguous region: Int32 for the per-node locks, Uint32 for the head indexes.
	private nodeInts: Int32Array;
	private nodeHeads: Uint32Array;

	private readonly maxLevels: number;
	private readonly nodeCount: number;
	private readonly coordType: number;
	// Empty-bucket / end-of-list sentinel for this instance's element type (see FLOAT32_NULL_INDEX)
	private readonly nullIndex: number;
	// Root bounds, read once (stored at the configured precision, math done in float64)
	private readonly rootX: number;
	private readonly rootY: number;
	private readonly rootWidth: number;
	private readonly rootHeight: number;

	// Number of entities currently tracked
	get size(): number {
		return this.idMap.length;
	}

	get bounds(): QuadtreeBounds {
		return { x: this.rootX, y: this.rootY, width: this.rootWidth, height: this.rootHeight };
	}

	// Element type the record is stored in (an ARRAY_TYPE code: float32 or float64)
	get type(): number {
		return this.coordType;
	}

	constructor(memory: MemoryHeap, config?: SharedQuadtreeConfig | SharedQuadtreeMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.coordType = this.firstBlock.data[TYPE_INDEX];
			this.pool = new SharedPool<CoordArray>(memory, {
				firstBlock: getPointer(loadRawPointer(this.firstBlock.data, POOL_POINTER_INDEX), memory.positionBits),
			});
			this.idMap = new SharedMap<number>(memory, {
				firstBlock: getPointer(loadRawPointer(this.firstBlock.data, MAP_POINTER_INDEX), memory.positionBits),
			});
			this.maxLevels = this.firstBlock.data[MAX_LEVELS_INDEX];
			this.nodeCount = this.firstBlock.data[NODE_COUNT_INDEX];
			this.nullIndex = nullIndexFor(this.coordType);
		} else {
			let bounds = config?.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
			let maxEntities = config?.maxEntities ?? DEFAULT_MAX_ENTITIES;
			this.maxLevels = config?.maxLevels ?? DEFAULT_MAX_LEVELS;
			this.nodeCount = SharedQuadtree.getNodeCount(this.maxLevels);
			this.coordType = getCoordTypeCode(config?.type);
			this.nullIndex = nullIndexFor(this.coordType);

			if(this.coordType === ARRAY_TYPE.float32 && maxEntities > FLOAT32_LIMIT) {
				throw new Error(`Float32 SharedQuadtree supports at most ${FLOAT32_LIMIT} entities; pass type: Float64Array for more`);
			}

			// Inline the pool and id-map firstBlocks right after the header so the whole spine is one contiguous allocation
			// (the pool's own firstBlock already inlines its two stacks). The node block stays separate: it is large and
			// sized independently of these headers.
			let poolConfig: SharedPoolConfig<CoordArray> = {
				type: getCoordTypeConstructor(this.coordType),
				dataLength: ITEM_FIELDS,
				maxLength: maxEntities,
			};
			let poolAllocateCount = SharedPool.getAllocateCount(memory, poolConfig);
			let mapAllocateCount = SharedMap.ALLOCATE_COUNT;
			this.firstBlock = memory.allocUI32(SharedQuadtree.ALLOCATE_COUNT + poolAllocateCount + mapAllocateCount);
			this.firstBlock.data[MAX_LEVELS_INDEX] = this.maxLevels;
			this.firstBlock.data[NODE_COUNT_INDEX] = this.nodeCount;
			this.firstBlock.data[TYPE_INDEX] = this.coordType;

			let boundsView = this.getBoundsView();
			boundsView[0] = bounds.x;
			boundsView[1] = bounds.y;
			boundsView[2] = bounds.width;
			boundsView[3] = bounds.height;

			// Node block must fit one allocation - it is never resized. Every head starts as NULL (calloc leaves them 0,
			// a valid item index, so they must be initialized explicitly).
			let nodeBlock = memory.allocUI32(this.nodeCount * NODE_SIZE);
			let heads = new Uint32Array(nodeBlock.data.buffer, nodeBlock.bufferByteOffset, this.nodeCount * NODE_SIZE);
			for(let i = 0; i < this.nodeCount; i++) {
				heads[i * NODE_SIZE + NODE_HEAD_OFFSET] = this.nullIndex;
			}
			storeRawPointer(this.firstBlock.data, NODE_POINTER_INDEX, nodeBlock.pointer);

			let poolBlock = this.firstBlock.getSubAllocation(SharedQuadtree.ALLOCATE_COUNT, poolAllocateCount);
			this.pool = new SharedPool<CoordArray>(memory, { firstBlock: poolBlock, ...poolConfig });
			storeRawPointer(this.firstBlock.data, POOL_POINTER_INDEX, poolBlock.pointer);

			let mapBlock = this.firstBlock.getSubAllocation(SharedQuadtree.ALLOCATE_COUNT + poolAllocateCount, mapAllocateCount);
			this.idMap = new SharedMap<number>(memory, { firstBlock: mapBlock });
			storeRawPointer(this.firstBlock.data, MAP_POINTER_INDEX, mapBlock.pointer);
		}

		let boundsView = this.getBoundsView();
		this.rootX = boundsView[0];
		this.rootY = boundsView[1];
		this.rootWidth = boundsView[2];
		this.rootHeight = boundsView[3];

		let nodeBlock = new AllocatedMemory(memory, getPointer(loadRawPointer(this.firstBlock.data, NODE_POINTER_INDEX), memory.positionBits));
		this.nodeInts = new Int32Array(nodeBlock.data.buffer, nodeBlock.bufferByteOffset, this.nodeCount * NODE_SIZE);
		this.nodeHeads = new Uint32Array(nodeBlock.data.buffer, nodeBlock.bufferByteOffset, this.nodeCount * NODE_SIZE);
	}

	// Total nodes in a complete quadtree of the given depth: sum of 4^level for level 0..maxLevels.
	static getNodeCount(maxLevels: number): number {
		return (Math.pow(4, maxLevels + 1) - 1) / 3;
	}

	get pointer(): number {
		return this.firstBlock.pointer;
	}

	get usedMemory(): number {
		let nodeBlock = new AllocatedMemory(this.memory, getPointer(loadRawPointer(this.firstBlock.data, NODE_POINTER_INDEX), this.memory.positionBits));
		return this.firstBlock.usedMemory + nodeBlock.usedMemory + this.pool.usedMemory + this.idMap.usedMemory;
	}

	insert(id: number, x: number, y: number, width = 0, height = 0) {
		if(this.idMap.get(id) !== undefined) {
			this.update(id, x, y, width, height);
			return;
		}

		let node = this.locate(x, y, width, height);
		let record = this.insertScratch;
		record[ITEM_ID] = id;
		record[ITEM_X] = x;
		record[ITEM_Y] = y;
		record[ITEM_W] = width;
		record[ITEM_H] = height;
		record[ITEM_NODE] = node;
		record[ITEM_NEXT] = this.nullIndex;
		let index = this.pool.push(record);
		this.linkIntoNode(node, index);
		this.idMap.set(id, index);
	}

	// Move an entity to a new position. Assumes a single writer per entity id (the standard shared-memory pattern - each
	// worker owns a disjoint set of entities), so this entity's item fields are stable until we lock its node(s).
	update(id: number, x: number, y: number, width = 0, height = 0) {
		let index = this.idMap.get(id);
		if(index === undefined) {
			this.insert(id, x, y, width, height);
			return;
		}

		let block = this.pool.blockFor(index);
		let off = this.pool.blockOffset(index);
		let oldNode = block[off + ITEM_NODE];
		let newNode = this.locate(x, y, width, height);

		if(oldNode === newNode) {
			// Same cell: only the coordinates change, no relinking. Lock so a concurrent reader sees a consistent record.
			lock(this.nodeInts, oldNode * NODE_SIZE + NODE_LOCK_OFFSET);
			block[off + ITEM_X] = x;
			block[off + ITEM_Y] = y;
			block[off + ITEM_W] = width;
			block[off + ITEM_H] = height;
			unlock(this.nodeInts, oldNode * NODE_SIZE + NODE_LOCK_OFFSET);
			return;
		}

		// Cross-cell move: hold both node locks, ordered by index to avoid deadlock with another thread moving the reverse way.
		let first = Math.min(oldNode, newNode);
		let second = Math.max(oldNode, newNode);
		lock(this.nodeInts, first * NODE_SIZE + NODE_LOCK_OFFSET);
		lock(this.nodeInts, second * NODE_SIZE + NODE_LOCK_OFFSET);

		this.unlinkNoLock(oldNode, index);
		block[off + ITEM_X] = x;
		block[off + ITEM_Y] = y;
		block[off + ITEM_W] = width;
		block[off + ITEM_H] = height;
		block[off + ITEM_NODE] = newNode;
		this.linkNoLock(newNode, index);

		unlock(this.nodeInts, second * NODE_SIZE + NODE_LOCK_OFFSET);
		unlock(this.nodeInts, first * NODE_SIZE + NODE_LOCK_OFFSET);
	}

	remove(id: number): boolean {
		let index = this.idMap.get(id);
		if(index === undefined) {
			return false;
		}

		let node = this.pool.get(index, ITEM_NODE);
		this.unlinkFromNode(node, index);
		this.pool.deleteIndex(index);
		this.idMap.delete(id);
		return true;
	}

	has(id: number): boolean {
		return this.idMap.get(id) !== undefined;
	}

	// Broad-phase query: ids of every entity in a node whose region intersects the given rect. Result is a superset of true
	// overlaps (the caller does the narrow-phase check), matching quadtree-js retrieve.
	search(x: number, y: number, width: number, height: number, filter?: (id: number) => boolean): Array<number> {
		let out: Array<number> = [];
		this.searchInto(out, x, y, width, height, filter);
		return out;
	}
	// Same as search but appends into a caller-owned array so hot loops can reuse it. Returns the array.
	searchInto(out: Array<number>, x: number, y: number, width: number, height: number, filter?: (id: number) => boolean): Array<number> {
		let start = out.length;
		this.collect(out, 0, this.rootX, this.rootY, this.rootWidth, this.rootHeight, 0, x, y, width, height);
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

		interface Node {
			index: number
			x: number
			y: number
			width: number
			height: number
			level: number
		}
		maxResults = Math.floor(maxResults);
		if(maxResults === 0) {
			return [];
		}
		let maxDistanceSquared = maxDistance * maxDistance;
		if(maxResults === 1) {
			return this.nearestNeighbor(x, y, maxDistanceSquared, filter);
		}
		let candidates: Array<NeighborCandidate> = [];
		let nodeCandidates: Array<NeighborCandidate> = [];
		let queue = new MinPriorityQueue<Node>();
		let root = { index: 0, x: this.rootX, y: this.rootY, width: this.rootWidth, height: this.rootHeight, level: 0 };
		queue.push(root, distanceSquaredToRect(x, y, this.rootX, this.rootY, this.rootX + this.rootWidth, this.rootY + this.rootHeight));

		while(queue.length > 0 && queue.priority <= candidateLimit(candidates, maxResults, maxDistanceSquared)) {
			let node = queue.pop();
			if(node === undefined) {
				break;
			}
			nodeCandidates.length = 0;
			this.collectNeighborNode(nodeCandidates, node.index, x, y, maxDistanceSquared);
			for(let candidate of nodeCandidates) {
				if(filter === undefined || filter(candidate.id)) {
					addCandidate(candidates, candidate.id, candidate.distance, maxResults);
				}
			}
			if(node.level >= this.maxLevels) {
				continue;
			}

			let halfWidth = node.width / 2;
			let halfHeight = node.height / 2;
			let childLevel = node.level + 1;
			let children: Array<Node> = [
				{ index: node.index * 4 + 1, x: node.x, y: node.y, width: halfWidth, height: halfHeight, level: childLevel },
				{ index: node.index * 4 + 2, x: node.x + halfWidth, y: node.y, width: halfWidth, height: halfHeight, level: childLevel },
				{ index: node.index * 4 + 3, x: node.x, y: node.y + halfHeight, width: halfWidth, height: halfHeight, level: childLevel },
				{ index: node.index * 4 + 4, x: node.x + halfWidth, y: node.y + halfHeight, width: halfWidth, height: halfHeight, level: childLevel },
			];
			for(let child of children) {
				let distance = distanceSquaredToRect(x, y, child.x, child.y, child.x + child.width, child.y + child.height);
				if(distance <= candidateLimit(candidates, maxResults, maxDistanceSquared)) {
					queue.push(child, distance);
				}
			}
		}

		return candidates.map(candidate => candidate.id);
	}

	private nearestNeighbor(
		x: number, y: number, maxDistanceSquared: number, filter: ((id: number) => boolean) | undefined,
	): Array<number> {
		let nearest: NearestNeighbor = { id: undefined, distance: maxDistanceSquared };
		let nodeCandidates: Array<NeighborCandidate> = [];
		this.findNearest(
			0, this.rootX, this.rootY, this.rootWidth, this.rootHeight, 0,
			x, y, nearest, nodeCandidates, filter,
		);
		return nearest.id === undefined ? [] : [nearest.id];
	}

	private findNearest(
		node: number, nodeX: number, nodeY: number, width: number, height: number, level: number,
		x: number, y: number, nearest: NearestNeighbor,
		nodeCandidates: Array<NeighborCandidate>, filter: ((id: number) => boolean) | undefined,
	) {
		if(distanceSquaredToRect(x, y, nodeX, nodeY, nodeX + width, nodeY + height) > nearest.distance) {
			return;
		}
		if(filter === undefined) {
			this.collectNearestNode(nearest, node, x, y);
		} else {
			nodeCandidates.length = 0;
			this.collectNeighborNode(nodeCandidates, node, x, y, nearest.distance);
			for(let candidate of nodeCandidates) {
				if(filter(candidate.id)
					&& (candidate.distance < nearest.distance
						|| (candidate.distance === nearest.distance && (nearest.id === undefined || candidate.id < nearest.id)))) {
					nearest.id = candidate.id;
					nearest.distance = candidate.distance;
				}
			}
		}
		if(level >= this.maxLevels) {
			return;
		}

		let halfWidth = width / 2;
		let halfHeight = height / 2;
		let midX = nodeX + halfWidth;
		let midY = nodeY + halfHeight;
		let base = node * 4;
		let nextLevel = level + 1;
		let east = x >= midX;
		let south = y >= midY;
		let visit = (index: number, childX: number, childY: number) => {
			this.findNearest(
				index, childX, childY, halfWidth, halfHeight, nextLevel,
				x, y, nearest, nodeCandidates, filter,
			);
		};
		if(south) {
			if(east) {
				visit(base + 4, midX, midY);
				visit(base + 3, nodeX, midY);
				visit(base + 2, midX, nodeY);
				visit(base + 1, nodeX, nodeY);
			} else {
				visit(base + 3, nodeX, midY);
				visit(base + 4, midX, midY);
				visit(base + 1, nodeX, nodeY);
				visit(base + 2, midX, nodeY);
			}
		} else if(east) {
			visit(base + 2, midX, nodeY);
			visit(base + 1, nodeX, nodeY);
			visit(base + 4, midX, midY);
			visit(base + 3, nodeX, midY);
		} else {
			visit(base + 1, nodeX, nodeY);
			visit(base + 2, midX, nodeY);
			visit(base + 3, nodeX, midY);
			visit(base + 4, midX, midY);
		}
	}

	clear() {
		for(let i = 0; i < this.nodeCount; i++) {
			this.nodeHeads[i * NODE_SIZE + NODE_HEAD_OFFSET] = this.nullIndex;
		}
		this.pool.clear();
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
		let nodeBlock = new AllocatedMemory(this.memory, getPointer(loadRawPointer(this.firstBlock.data, NODE_POINTER_INDEX), this.memory.positionBits));
		nodeBlock.free();
		this.pool.free();
		this.idMap.free();
		this.firstBlock.free();
	}

	getSharedMemory(): SharedQuadtreeMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}

	private getBoundsView(): CoordArray {
		return makeArrayView(
			this.coordType,
			this.firstBlock.data.buffer,
			this.firstBlock.bufferByteOffset + BOUNDS_INDEX * Uint32Array.BYTES_PER_ELEMENT,
			4,
		) as CoordArray;
	}

	// Deepest node index that fully contains the rect. Descends into the one child that still fully contains it; stops at a
	// straddle or at max depth.
	private locate(x: number, y: number, width: number, height: number): number {
		let node = 0;
		let nx = this.rootX;
		let ny = this.rootY;
		let nw = this.rootWidth;
		let nh = this.rootHeight;

		for(let level = 0; level < this.maxLevels; level++) {
			let midX = nx + nw / 2;
			let midY = ny + nh / 2;
			let west = x >= nx && x + width <= midX && (width > 0 || x < midX);
			let east = x >= midX && x + width <= nx + nw;
			let north = y >= ny && y + height <= midY && (height > 0 || y < midY);
			let south = y >= midY && y + height <= ny + nh;

			if(north && west) {
				node = node * 4 + 1;
				nw /= 2;
				nh /= 2;
			} else if(north && east) {
				node = node * 4 + 2;
				nx = midX;
				nw /= 2;
				nh /= 2;
			} else if(south && west) {
				node = node * 4 + 3;
				ny = midY;
				nw /= 2;
				nh /= 2;
			} else if(south && east) {
				node = node * 4 + 4;
				nx = midX;
				ny = midY;
				nw /= 2;
				nh /= 2;
			} else {
				break;
			}
		}

		return node;
	}

	private collect(out: Array<number>, node: number, nx: number, ny: number, nw: number, nh: number, level: number, qx: number, qy: number, qw: number, qh: number) {
		// Peek the head unlocked: an empty bucket has nothing to read, so the lock (and its atomics) is pure overhead. Most
		// nodes in a fixed-depth tree are empty, so skipping them dominates query cost. Taking the lock only to walk a
		// non-empty bucket preserves the snapshot guarantee - a concurrent insert we race is simply not in this snapshot.
		let headIndex = node * NODE_SIZE + NODE_HEAD_OFFSET;
		if(this.nodeHeads[headIndex] !== this.nullIndex) {
			let lockIndex = node * NODE_SIZE + NODE_LOCK_OFFSET;
			lock(this.nodeInts, lockIndex);
			let index = this.nodeHeads[headIndex];
			let pool = this.pool;
			while(index !== this.nullIndex) {
				// One chunk resolve per item covers both fields it reads
				let block = pool.blockFor(index);
				let off = pool.blockOffset(index);
				out.push(block[off + ITEM_ID]);
				index = block[off + ITEM_NEXT];
			}
			unlock(this.nodeInts, lockIndex);
		}

		if(level >= this.maxLevels) {
			return;
		}

		let midX = nx + nw / 2;
		let midY = ny + nh / 2;
		let hw = nw / 2;
		let hh = nh / 2;
		let overlapsWest = qx < midX;
		let overlapsEast = qx + qw > midX;
		let overlapsNorth = qy < midY;
		let overlapsSouth = qy + qh > midY;

		if(overlapsNorth && overlapsWest) {
			this.collect(out, node * 4 + 1, nx, ny, hw, hh, level + 1, qx, qy, qw, qh);
		}
		if(overlapsNorth && overlapsEast) {
			this.collect(out, node * 4 + 2, midX, ny, hw, hh, level + 1, qx, qy, qw, qh);
		}
		if(overlapsSouth && overlapsWest) {
			this.collect(out, node * 4 + 3, nx, midY, hw, hh, level + 1, qx, qy, qw, qh);
		}
		if(overlapsSouth && overlapsEast) {
			this.collect(out, node * 4 + 4, midX, midY, hw, hh, level + 1, qx, qy, qw, qh);
		}
	}

	private collectNeighborNode(
		out: Array<NeighborCandidate>, node: number, x: number, y: number, maxDistanceSquared: number,
	) {
		let headIndex = node * NODE_SIZE + NODE_HEAD_OFFSET;
		if(this.nodeHeads[headIndex] === this.nullIndex) {
			return;
		}
		let lockIndex = node * NODE_SIZE + NODE_LOCK_OFFSET;
		lock(this.nodeInts, lockIndex);
		let index = this.nodeHeads[headIndex];
		while(index !== this.nullIndex) {
			let block = this.pool.blockFor(index);
			let off = this.pool.blockOffset(index);
			let id = block[off + ITEM_ID];
			let distance = distanceSquaredToRect(x, y, block[off + ITEM_X], block[off + ITEM_Y], block[off + ITEM_X] + block[off + ITEM_W], block[off + ITEM_Y] + block[off + ITEM_H]);
			if(distance <= maxDistanceSquared) {
				out.push({ id, distance });
			}
			index = block[off + ITEM_NEXT];
		}
		unlock(this.nodeInts, lockIndex);
	}

	private collectNearestNode(nearest: NearestNeighbor, node: number, x: number, y: number) {
		let headIndex = node * NODE_SIZE + NODE_HEAD_OFFSET;
		if(this.nodeHeads[headIndex] === this.nullIndex) {
			return;
		}
		let lockIndex = node * NODE_SIZE + NODE_LOCK_OFFSET;
		lock(this.nodeInts, lockIndex);
		let index = this.nodeHeads[headIndex];
		while(index !== this.nullIndex) {
			let block = this.pool.blockFor(index);
			let off = this.pool.blockOffset(index);
			let id = block[off + ITEM_ID];
			let distance = distanceSquaredToRect(
				x, y, block[off + ITEM_X], block[off + ITEM_Y],
				block[off + ITEM_X] + block[off + ITEM_W], block[off + ITEM_Y] + block[off + ITEM_H],
			);
			if(distance < nearest.distance
				|| (distance === nearest.distance && (nearest.id === undefined || id < nearest.id))) {
				nearest.id = id;
				nearest.distance = distance;
			}
			index = block[off + ITEM_NEXT];
		}
		unlock(this.nodeInts, lockIndex);
	}

	private linkIntoNode(node: number, index: number) {
		let lockIndex = node * NODE_SIZE + NODE_LOCK_OFFSET;
		lock(this.nodeInts, lockIndex);
		this.linkNoLock(node, index);
		unlock(this.nodeInts, lockIndex);
	}
	// Push the item onto the node's bucket head. Caller holds the node lock.
	private linkNoLock(node: number, index: number) {
		let headIndex = node * NODE_SIZE + NODE_HEAD_OFFSET;
		this.pool.set(index, ITEM_NEXT, this.nodeHeads[headIndex]);
		this.nodeHeads[headIndex] = index;
	}

	private unlinkFromNode(node: number, index: number) {
		let lockIndex = node * NODE_SIZE + NODE_LOCK_OFFSET;
		lock(this.nodeInts, lockIndex);
		this.unlinkNoLock(node, index);
		unlock(this.nodeInts, lockIndex);
	}
	// Splice the item out of the node's bucket. Caller holds the node lock.
	private unlinkNoLock(node: number, index: number) {
		let headIndex = node * NODE_SIZE + NODE_HEAD_OFFSET;
		let head = this.nodeHeads[headIndex];
		let next = this.pool.get(index, ITEM_NEXT);
		if(head === index) {
			this.nodeHeads[headIndex] = next;
			return;
		}

		let prev = head;
		while(prev !== this.nullIndex) {
			let prevNext = this.pool.get(prev, ITEM_NEXT);
			if(prevNext === index) {
				this.pool.set(prev, ITEM_NEXT, next);
				return;
			}
			prev = prevNext;
		}
	}
}

function getCoordTypeCode(type: CoordArrayConstructor | undefined): number {
	let code = getArrayTypeCode(type ?? DEFAULT_COORD_TYPE);
	if(code !== ARRAY_TYPE.float32 && code !== ARRAY_TYPE.float64) {
		throw new Error('SharedQuadtree must be Float32Array or Float64Array');
	}
	return code;
}
function getCoordTypeConstructor(typeCode: number): CoordArrayConstructor {
	return getByteMultipler(typeCode) === 2 ? Float64Array : Float32Array;
}
function nullIndexFor(typeCode: number): number {
	return typeCode === ARRAY_TYPE.float32 ? FLOAT32_NULL_INDEX : FLOAT64_NULL_INDEX;
}

interface QuadtreeBounds {
	x: number
	y: number
	width: number
	height: number
}
interface SharedQuadtreeConfig {
	bounds: QuadtreeBounds
	maxLevels?: number
	maxEntities?: number
	type?: CoordArrayConstructor
}
interface SharedQuadtreeMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedQuadtreeConfig, SharedQuadtreeMemory, QuadtreeBounds };
