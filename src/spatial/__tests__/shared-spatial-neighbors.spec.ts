import MemoryHeap from '../../memory-heap';
import SharedQuadtree from '../shared-quadtree';
import SharedSpatialGrid from '../shared-spatial-grid';
import SharedSpatialMap from '../shared-spatial-map';

const WORLD = { x: 0, y: 0, width: 2000, height: 2000 };
const ENTITY_COUNT = 300;

interface Rect {
	id: number
	x: number
	y: number
	width: number
	height: number
}

interface SpatialStructure {
	insert(id: number, x: number, y: number, width: number, height: number): void
	neighbors(x: number, y: number, maxResults: number, maxDistance: number, filter?: (id: number) => boolean): Array<number>
}

let seed = 246813579;
function random(): number {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}

function distanceSquared(x: number, y: number, rect: Rect): number {
	let dx = Math.max(rect.x - x, x - rect.x - rect.width, 0);
	let dy = Math.max(rect.y - y, y - rect.y - rect.height, 0);
	return dx * dx + dy * dy;
}

const rects: Array<Rect> = [];
for(let id = 0; id < ENTITY_COUNT; id++) {
	let width = 1 + Math.floor(random() * 35);
	let height = 1 + Math.floor(random() * 35);
	rects.push({
		id,
		x: Math.floor(random() * (WORLD.width - width)),
		y: Math.floor(random() * (WORLD.height - height)),
		width,
		height,
	});
}

const factories: Array<[string, (memory: MemoryHeap) => SpatialStructure]> = [
	['quadtree', memory => new SharedQuadtree(memory, { bounds: WORLD, maxLevels: 6, maxEntities: ENTITY_COUNT })],
	['grid', memory => new SharedSpatialGrid(memory, { bounds: WORLD, gridSize: 50, maxEntities: ENTITY_COUNT })],
	['spatial map', memory => new SharedSpatialMap(memory, { gridSize: 50, maxEntities: ENTITY_COUNT })],
];

describe.each(factories)('%s neighbors', (_name, create) => {
	it('matches brute force for single and multiple nearest neighbors', () => {
		let structure = create(new MemoryHeap());
		for(let rect of rects) {
			structure.insert(rect.id, rect.x, rect.y, rect.width, rect.height);
		}

		for(let query = 0; query < 100; query++) {
			let x = Math.floor(random() * WORLD.width);
			let y = Math.floor(random() * WORLD.height);
			let maxDistance = 300;
			let expected = rects
				.filter(rect => rect.id % 3 !== 0 && distanceSquared(x, y, rect) <= maxDistance * maxDistance)
				.sort((a, b) => distanceSquared(x, y, a) - distanceSquared(x, y, b) || a.id - b.id);

			expect(structure.neighbors(x, y, 1, maxDistance, id => id % 3 !== 0))
				.toEqual(expected.slice(0, 1).map(rect => rect.id));
			expect(structure.neighbors(x, y, 10, maxDistance, id => id % 3 !== 0))
				.toEqual(expected.slice(0, 10).map(rect => rect.id));
		}
	});
});
