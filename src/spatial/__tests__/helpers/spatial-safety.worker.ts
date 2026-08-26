import { parentPort, workerData } from 'node:worker_threads';
import MemoryHeap, { type MemoryHeapMemory } from '../../../memory-heap';
import SharedQuadtree from '../../shared-quadtree';
import SharedSpatialGrid from '../../shared-spatial-grid';
import SharedSpatialMap from '../../shared-spatial-map';
import type { SharedAllocatedMemory } from '../../../allocated-memory';

// One worker for all three spatial structures: they share the insert/update/remove/retrieve surface, so the only thing
// that differs is which constructor the `kind` picks.
export type SpatialKind = 'quadtree' | 'grid' | 'map';

interface Placed {
	id: number
	x: number
	y: number
	width: number
	height: number
}
interface SpatialWorkerData {
	kind: SpatialKind
	heap: MemoryHeapMemory
	structure: { firstBlock: SharedAllocatedMemory }
	idBase: number
	insertCount: number
	updateRounds: number
	world: { x: number, y: number, width: number, height: number }
}

const SIZE = 16;

const { kind, heap: heapMemory, structure: structureMemory, idBase, insertCount, updateRounds, world } = workerData as SpatialWorkerData;
const port = parentPort!;

const heap = new MemoryHeap(heapMemory);
const structure = kind === 'quadtree'
	? new SharedQuadtree(heap, structureMemory)
	: kind === 'grid'
		? new SharedSpatialGrid(heap, structureMemory)
		: new SharedSpatialMap(heap, structureMemory);

// Every entity this worker owns and its last-known position, so it can move known entities and, at the end, verify each
// still resolves where it was last put.
const live: Array<Placed> = [];

function randomPosition(entity: Placed) {
	entity.x = Math.random() * (world.width - SIZE);
	entity.y = Math.random() * (world.height - SIZE);
}

function run() {
	for(let i = 0; i < insertCount; i++) {
		let entity = { id: idBase + i, x: 0, y: 0, width: SIZE, height: SIZE };
		randomPosition(entity);
		structure.insert(entity.id, entity.x, entity.y, entity.width, entity.height);
		live.push(entity);
	}

	// Repeatedly move every owned entity, with the occasional remove + reinsert to exercise those paths too
	for(let round = 0; round < updateRounds; round++) {
		for(let entity of live) {
			randomPosition(entity);
			structure.update(entity.id, entity.x, entity.y, entity.width, entity.height);
		}

		let removeAt = Math.floor(Math.random() * live.length);
		let entity = live[removeAt];
		structure.remove(entity.id);
		randomPosition(entity);
		structure.insert(entity.id, entity.x, entity.y, entity.width, entity.height);
	}

	port.postMessage({ done: true, expectedCount: live.length });
}

function check() {
	let missing: Array<number> = [];
	for(let entity of live) {
		// A tiny query around the last-known position must return this entity
		let found = structure.retrieve(entity.x - 1, entity.y - 1, entity.width + 2, entity.height + 2);
		if(!found.includes(entity.id)) {
			missing.push(entity.id);
		}
	}

	port.postMessage({ checked: true, missing, total: live.length });
}

port.on('message', (message: { run?: boolean, check?: boolean }) => {
	if(message.run) {
		run();
	} else if(message.check) {
		check();
	}
});

port.postMessage({ ready: true });
