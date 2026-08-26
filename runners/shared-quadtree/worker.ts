import SharedQuadtree from '../../src/spatial/shared-quadtree';
import MemoryHeap from '../../src/memory-heap';
import { log, warn } from '../logger';

let tree: SharedQuadtree;
let workerNumber: number;
let idBase = 0;
let world = { x: 0, y: 0, width: 0, height: 0 };

// Every entity this worker owns and its last-known position, so it can move known entities and, at the end, verify each
// still resolves where it was last put.
interface Placed {
	id: number
	x: number
	y: number
	width: number
	height: number
}
let live: Array<Placed> = [];

const SIZE = 16;

function randomPosition(entity: Placed) {
	entity.x = Math.random() * (world.width - SIZE);
	entity.y = Math.random() * (world.height - SIZE);
}

self.onmessage = (e) => {
	if(e.data.tree) {
		let heap = new MemoryHeap(e.data.heap);
		tree = new SharedQuadtree(heap, e.data.tree);
		workerNumber = e.data.workerNumber;
		idBase = e.data.idBase;
		world = e.data.world;

		let entities: Array<Placed> = [];
		for(let i = 0; i < e.data.insertCount; i++) {
			entities.push({ id: idBase + i, x: 0, y: 0, width: SIZE, height: SIZE });
		}
		// @ts-expect-error - stash config for the run phase
		self.__config = { entities, updateRounds: e.data.updateRounds };
	} else if(e.data.run) {
		// @ts-expect-error
		let { entities, updateRounds } = self.__config as { entities: Array<Placed>, updateRounds: number };

		for(let entity of entities) {
			randomPosition(entity);
			tree.insert(entity.id, entity.x, entity.y, entity.width, entity.height);
			live.push(entity);
		}

		// Repeatedly move every owned entity, with the occasional remove + reinsert to exercise those paths too
		for(let round = 0; round < updateRounds; round++) {
			for(let entity of live) {
				randomPosition(entity);
				tree.update(entity.id, entity.x, entity.y, entity.width, entity.height);
			}

			if(live.length) {
				let removeAt = Math.floor(Math.random() * live.length);
				let entity = live[removeAt];
				tree.remove(entity.id);
				randomPosition(entity);
				tree.insert(entity.id, entity.x, entity.y, entity.width, entity.height);
			}
		}

		self.postMessage({
			done: true,
			workerNumber,
			expectedCount: live.length,
		});
	} else if(e.data.check) {
		let missing = 0;
		for(let entity of live) {
			// A tiny query around the last-known position must return this entity
			let found = tree.search(entity.x - 1, entity.y - 1, entity.width + 2, entity.height + 2);
			if(!found.includes(entity.id)) {
				missing++;
			}
		}

		if(missing) {
			warn(`worker ${workerNumber}: ${missing} of ${live.length} owned entities not found at their last position`);
		} else {
			log(`worker ${workerNumber}: all ${live.length} owned entities resolve at their last position`);
		}
	}
};
