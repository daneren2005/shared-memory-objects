import { bench, describe } from 'vitest';
import { Quadtree as QuadtreeTs, Rectangle } from '@timohausmann/quadtree-ts';
import Flatbush from 'flatbush';
import MemoryHeap from '../../memory-heap';
import SharedQuadtree from '../shared-quadtree';
import SharedSpatialGrid from '../shared-spatial-grid';
import SharedSpatialMap from '../shared-spatial-map';

// SharedQuadtree, SharedSpatialGrid, and SharedSpatialMap are fixed-shape structures meant for live multi-thread updates;
// quadtree-ts supports single-threaded updates, while Flatbush is static. SharedSpatialMap is the grid's unbounded cousin: it
// hashes cells into a fixed bucket array instead of a fixed cols x rows extent, so it pays a hash + chain filter per cell
// in exchange for supporting a world of any size. The comparison covers building, broad-phase queries, and moving entities.

const WORLD = { x: 0, y: 0, width: 4000, height: 4000 };
const MAX_LEVELS = 6;
// A fixed grid cell roughly the size of a leaf cell of the depth-6 quadtree over this world, so both index at a similar
// resolution for the comparison
const GRID_SIZE = WORLD.width / Math.pow(2, MAX_LEVELS);
const ENTITY_COUNT = 2_000;
const QUERY_COUNT = 2_000;
const MOVED_ENTITY_COUNT = ENTITY_COUNT * 0.2;

interface Entity {
	id: number
	x: number
	y: number
	width: number
	height: number
}

// Deterministic dataset so every run and every implementation sees the same distribution
let seed = 987654321;
function random(): number {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}

const entities: Array<Entity> = [];
for(let id = 0; id < ENTITY_COUNT; id++) {
	let width = 4 + random() * 24;
	let height = 4 + random() * 24;
	entities.push({
		id,
		x: random() * (WORLD.width - width),
		y: random() * (WORLD.height - height),
		width,
		height,
	});
}
const queries: Array<Entity> = [];
for(let id = 0; id < QUERY_COUNT; id++) {
	let width = 20 + random() * 180;
	let height = 20 + random() * 180;
	queries.push({
		id,
		x: random() * (WORLD.width - width),
		y: random() * (WORLD.height - height),
		width,
		height,
	});
}

// quadtree-ts insert/retrieve take shape instances, so pre-build them once to keep the comparison fair
const entityRects = entities.map(entity => new Rectangle({ x: entity.x, y: entity.y, width: entity.width, height: entity.height, data: entity.id }));
const queryRects = queries.map(query => new Rectangle({ x: query.x, y: query.y, width: query.width, height: query.height }));

function buildShared(): SharedQuadtree {
	let tree = new SharedQuadtree(new MemoryHeap(), { bounds: WORLD, maxLevels: MAX_LEVELS, maxEntities: ENTITY_COUNT });
	for(let entity of entities) {
		tree.insert(entity.id, entity.x, entity.y, entity.width, entity.height);
	}
	return tree;
}
function buildQuadtreeTs(): QuadtreeTs<Rectangle<number>> {
	let tree = new QuadtreeTs<Rectangle<number>>({ x: WORLD.x, y: WORLD.y, width: WORLD.width, height: WORLD.height, maxObjects: 10, maxLevels: MAX_LEVELS });
	for(let rect of entityRects) {
		tree.insert(rect);
	}
	return tree;
}
function buildGrid(): SharedSpatialGrid {
	let grid = new SharedSpatialGrid(new MemoryHeap(), { bounds: WORLD, gridSize: GRID_SIZE, maxEntities: ENTITY_COUNT });
	for(let entity of entities) {
		grid.insert(entity.id, entity.x, entity.y, entity.width, entity.height);
	}
	return grid;
}
function buildSpatialMap(): SharedSpatialMap {
	// Roughly one bucket per occupied cell so chains stay short, matching the grid's resolution over this world
	let map = new SharedSpatialMap(new MemoryHeap(), { gridSize: GRID_SIZE, buckets: 8192, maxEntities: ENTITY_COUNT });
	for(let entity of entities) {
		map.insert(entity.id, entity.x, entity.y, entity.width, entity.height);
	}
	return map;
}
function buildFlatbush(movedEntityCount = 0): Flatbush {
	let index = new Flatbush(ENTITY_COUNT);
	for(let i = 0; i < entities.length; i++) {
		let entity = entities[i];
		let offset = i < movedEntityCount ? 3 : 0;
		index.add(entity.x + offset, entity.y + offset, entity.x + entity.width + offset, entity.y + entity.height + offset);
	}
	index.finish();
	return index;
}

describe(`build a tree of ${ENTITY_COUNT} entities`, () => {
	bench('shared quadtree', () => {
		buildShared();
	});
	bench('shared grid', () => {
		buildGrid();
	});
	bench('shared spatial map', () => {
		buildSpatialMap();
	});
	bench('quadtree-ts', () => {
		buildQuadtreeTs();
	});
	bench('flatbush', () => {
		buildFlatbush();
	});
});

describe(`${QUERY_COUNT} broad-phase queries`, () => {
	let sharedTree: SharedQuadtree;
	let out: Array<number> = [];
	bench('shared quadtree', () => {
		for(let query of queries) {
			out.length = 0;
			sharedTree.retrieveInto(out, query.x, query.y, query.width, query.height);
		}
	}, {
		setup: () => {
			sharedTree = buildShared();
		},
	});

	let grid: SharedSpatialGrid;
	bench('shared grid', () => {
		for(let query of queries) {
			out.length = 0;
			grid.retrieveInto(out, query.x, query.y, query.width, query.height);
		}
	}, {
		setup: () => {
			grid = buildGrid();
		},
	});

	let spatialMap: SharedSpatialMap;
	bench('shared spatial map', () => {
		for(let query of queries) {
			out.length = 0;
			spatialMap.retrieveInto(out, query.x, query.y, query.width, query.height);
		}
	}, {
		setup: () => {
			spatialMap = buildSpatialMap();
		},
	});

	let tsTree: QuadtreeTs<Rectangle<number>>;
	bench('quadtree-ts', () => {
		for(let query of queryRects) {
			tsTree.retrieve(query);
		}
	}, {
		setup: () => {
			tsTree = buildQuadtreeTs();
		},
	});

	let flatbush: Flatbush;
	bench('flatbush', () => {
		for(let query of queries) {
			flatbush.search(query.x, query.y, query.x + query.width, query.y + query.height);
		}
	}, {
		setup: () => {
			flatbush = buildFlatbush();
		},
	});
});

describe(`move ${MOVED_ENTITY_COUNT} of ${ENTITY_COUNT} entities one step`, () => {
	let sharedTree: SharedQuadtree;
	bench('shared quadtree', () => {
		for(let i = 0; i < MOVED_ENTITY_COUNT; i++) {
			let entity = entities[i];
			sharedTree.update(entity.id, entity.x + 3, entity.y + 3, entity.width, entity.height);
		}
	}, {
		setup: () => {
			sharedTree = buildShared();
		},
	});

	let grid: SharedSpatialGrid;
	bench('shared grid', () => {
		for(let i = 0; i < MOVED_ENTITY_COUNT; i++) {
			let entity = entities[i];
			grid.update(entity.id, entity.x + 3, entity.y + 3, entity.width, entity.height);
		}
	}, {
		setup: () => {
			grid = buildGrid();
		},
	});

	let spatialMap: SharedSpatialMap;
	bench('shared spatial map', () => {
		for(let i = 0; i < MOVED_ENTITY_COUNT; i++) {
			let entity = entities[i];
			spatialMap.update(entity.id, entity.x + 3, entity.y + 3, entity.width, entity.height);
		}
	}, {
		setup: () => {
			spatialMap = buildSpatialMap();
		},
	});

	bench('flatbush (rebuild)', () => {
		buildFlatbush(MOVED_ENTITY_COUNT);
	});
});

describe(`move all ${ENTITY_COUNT} entities one step`, () => {
	let sharedTree: SharedQuadtree;
	bench('shared quadtree', () => {
		for(let entity of entities) {
			sharedTree.update(entity.id, entity.x + 3, entity.y + 3, entity.width, entity.height);
		}
	}, {
		setup: () => {
			sharedTree = buildShared();
		},
	});

	let grid: SharedSpatialGrid;
	bench('shared grid', () => {
		for(let entity of entities) {
			grid.update(entity.id, entity.x + 3, entity.y + 3, entity.width, entity.height);
		}
	}, {
		setup: () => {
			grid = buildGrid();
		},
	});

	let spatialMap: SharedSpatialMap;
	bench('shared spatial map', () => {
		for(let entity of entities) {
			spatialMap.update(entity.id, entity.x + 3, entity.y + 3, entity.width, entity.height);
		}
	}, {
		setup: () => {
			spatialMap = buildSpatialMap();
		},
	});

	// quadtree-ts has an in-place update, so show both its update and the clear + reinsert path
	let tsTree: QuadtreeTs<Rectangle<number>>;
	bench('quadtree-ts', () => {
		for(let i = 0; i < entityRects.length; i++) {
			let rect = entityRects[i];
			rect.x = entities[i].x + 3;
			rect.y = entities[i].y + 3;
			tsTree.update(rect, true);
		}
	}, {
		setup: () => {
			tsTree = buildQuadtreeTs();
		},
	});
});
