import MemoryHeap from '../../memory-heap';
import SharedQuadtree from '../shared-quadtree';
import { ARRAY_TYPE } from '../../utils/array-type';

const BOUNDS = { x: 0, y: 0, width: 1000, height: 1000 };

interface Rect {
	id: number
	x: number
	y: number
	width: number
	height: number
}

// AABB overlap with positive area on both boxes
function overlaps(a: Rect, q: { x: number, y: number, width: number, height: number }): boolean {
	return a.x < q.x + q.width && a.x + a.width > q.x && a.y < q.y + q.height && a.y + a.height > q.y;
}

describe('SharedQuadtree', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap();
	});

	it('inserts entities and retrieves them by region', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 100, 100, 10, 10);
		tree.insert(2, 800, 800, 10, 10);

		expect(tree.size).toEqual(2);
		// A query over the whole world returns everything
		expect(new Set(tree.retrieve(0, 0, 1000, 1000))).toEqual(new Set([1, 2]));
		// A query near the first entity returns it and not the far one
		let near = tree.retrieve(90, 90, 30, 30);
		expect(near).toContain(1);
		expect(near).not.toContain(2);
	});

	it('never returns the same entity twice', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		for(let i = 0; i < 50; i++) {
			tree.insert(i, i * 15, i * 15, 5, 5);
		}
		let result = tree.retrieve(0, 0, 1000, 1000);
		expect(result.length).toEqual(new Set(result).size);
		expect(result.length).toEqual(50);
	});

	it('places a large object at a shallow node and still finds it from a small query', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		// Spans the whole world -> must live at the root, but a tiny query anywhere still retrieves it
		tree.insert(1, 0, 0, 1000, 1000);
		tree.insert(2, 500, 500, 2, 2);

		expect(tree.retrieve(10, 10, 1, 1)).toContain(1);
		expect(tree.retrieve(950, 950, 1, 1)).toContain(1);
		expect(tree.retrieve(499, 499, 4, 4)).toEqual(expect.arrayContaining([1, 2]));
	});

	it('updates an entity in place within the same cell', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 100, 100, 10, 10);
		tree.update(1, 110, 110, 10, 10);

		expect(tree.size).toEqual(1);
		expect(tree.retrieve(105, 105, 20, 20)).toContain(1);
	});

	it('moves an entity across cells so old region no longer sees it', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 50, 50, 5, 5);
		expect(tree.retrieve(40, 40, 30, 30)).toContain(1);

		tree.update(1, 900, 900, 5, 5);
		expect(tree.retrieve(40, 40, 30, 30)).not.toContain(1);
		expect(tree.retrieve(880, 880, 40, 40)).toContain(1);
		expect(tree.size).toEqual(1);
	});

	it('update on an unknown id inserts it', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.update(7, 300, 300, 5, 5);
		expect(tree.has(7)).toBe(true);
		expect(tree.retrieve(290, 290, 30, 30)).toContain(7);
	});

	it('treats inserting an existing id as an update without leaving a stale entry', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 100, 100, 10, 10);
		tree.insert(1, 900, 900, 10, 10);

		expect(tree.size).toEqual(1);
		expect(tree.retrieve(90, 90, 30, 30)).not.toContain(1);
		expect(tree.retrieve(890, 890, 30, 30)).toEqual([1]);
	});

	it('keeps only live ids through moves, removals, inserts, and reinserts', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 100, 100, 10, 10);
		tree.insert(2, 800, 100, 10, 10);
		tree.update(1, 790, 790, 20, 20);
		tree.remove(2);
		tree.update(3, 100, 800, 10, 10);
		tree.insert(1, 100, 100, 10, 10);

		expect(new Set(tree.retrieve(0, 0, 1000, 1000))).toEqual(new Set([1, 3]));
		expect(tree.retrieve(90, 90, 30, 30)).toContain(1);
		expect(tree.retrieve(780, 780, 40, 40)).not.toContain(1);
	});

	it('uses the deterministic child at a quadrant midline', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 500, 500, 0, 0);

		expect(tree.retrieve(500, 500, 1, 1)).toContain(1);
		expect(tree.retrieve(499, 499, 1, 1)).not.toContain(1);
	});

	it('appends candidates into a caller-owned result array', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 100, 100, 10, 10);
		let result = [99];

		expect(tree.retrieveInto(result, 90, 90, 30, 30)).toBe(result);
		expect(result).toEqual([99, 1]);
	});

	it('removes entities and recycles their slots', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		tree.insert(1, 100, 100, 5, 5);
		tree.insert(2, 100, 100, 5, 5);
		tree.insert(3, 100, 100, 5, 5);

		expect(tree.remove(2)).toBe(true);
		expect(tree.remove(2)).toBe(false);
		expect(tree.has(2)).toBe(false);
		expect(tree.size).toEqual(2);

		let result = tree.retrieve(90, 90, 30, 30);
		expect(new Set(result)).toEqual(new Set([1, 3]));
	});

	it('unlinks correctly when removing the head, middle, and tail of a bucket', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		// All land in the same leaf cell so they share one bucket
		for(let id of [1, 2, 3, 4, 5]) {
			tree.insert(id, 500, 500, 1, 1);
		}
		tree.remove(5); // most-recently-inserted = head
		tree.remove(1); // oldest = tail
		tree.remove(3); // middle

		expect(new Set(tree.retrieve(499, 499, 4, 4))).toEqual(new Set([2, 4]));
		expect(tree.size).toEqual(2);
	});

	it('clear empties the tree but keeps it usable', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		for(let i = 0; i < 20; i++) {
			tree.insert(i, i * 10, i * 10, 5, 5);
		}
		tree.clear();
		expect(tree.size).toEqual(0);
		expect(tree.retrieve(0, 0, 1000, 1000)).toEqual([]);

		tree.insert(99, 500, 500, 5, 5);
		expect(tree.retrieve(0, 0, 1000, 1000)).toEqual([99]);
	});

	it('a second instance over the same shared memory sees inserts and updates', () => {
		let main = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5 });
		let clone = new SharedQuadtree(memory, main.getSharedMemory());

		main.insert(1, 100, 100, 5, 5);
		expect(clone.retrieve(90, 90, 30, 30)).toContain(1);
		expect(clone.size).toEqual(1);

		clone.update(1, 900, 900, 5, 5);
		expect(main.retrieve(880, 880, 40, 40)).toContain(1);
		expect(main.retrieve(90, 90, 30, 30)).not.toContain(1);

		clone.insert(2, 500, 500, 5, 5);
		expect(main.has(2)).toBe(true);
	});

	it('retrieve returns every true overlap (randomized cross-check against brute force)', () => {
		let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 6 });
		let rects: Array<Rect> = [];

		let seed = 123456789;
		let random = () => {
			// Deterministic LCG so a failure reproduces
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};

		for(let id = 0; id < 500; id++) {
			let width = 1 + random() * 40;
			let height = 1 + random() * 40;
			let rect = {
				id,
				x: random() * (1000 - width),
				y: random() * (1000 - height),
				width,
				height,
			};
			rects.push(rect);
			tree.insert(rect.id, rect.x, rect.y, rect.width, rect.height);
		}

		for(let q = 0; q < 200; q++) {
			let width = 1 + random() * 100;
			let height = 1 + random() * 100;
			let query = {
				x: random() * (1000 - width),
				y: random() * (1000 - height),
				width,
				height,
			};

			let found = new Set(tree.retrieve(query.x, query.y, query.width, query.height));
			let expected = rects.filter(rect => overlaps(rect, query)).map(rect => rect.id);
			for(let id of expected) {
				expect(found.has(id)).toBe(true);
			}
		}
	});

	describe('coordinate type', () => {
		it('defaults to float32', () => {
			let tree = new SharedQuadtree(memory, { bounds: BOUNDS });
			expect(tree.type).toEqual(ARRAY_TYPE.float32);
		});

		it('can be configured as float64 and costs more per entity', () => {
			let f32 = new SharedQuadtree(memory, { bounds: BOUNDS, type: Float32Array });
			let f64 = new SharedQuadtree(memory, { bounds: BOUNDS, type: Float64Array });
			expect(f64.type).toEqual(ARRAY_TYPE.float64);
			expect(f64.usedMemory).toBeGreaterThan(f32.usedMemory);
		});

		it('rejects a float32 tree with more than 2^24 entities but allows it for float64', () => {
			expect(() => new SharedQuadtree(memory, { bounds: BOUNDS, maxEntities: 0x1000000 + 1 }))
				.toThrow('Float32 SharedQuadtree supports at most');
			expect(() => new SharedQuadtree(memory, { bounds: BOUNDS, maxEntities: 0x1000000 + 1, type: Float64Array }))
				.not.toThrow();
		});

		it('keeps large ids and coordinates exact with float64', () => {
			let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5, type: Float64Array });
			let bigId = 2 ** 40 + 7;
			tree.insert(bigId, 100, 100, 10, 10);
			expect(tree.retrieve(90, 90, 30, 30)).toContain(bigId);
		});

		it('a second instance over the same memory reports the same type', () => {
			let main = new SharedQuadtree(memory, { bounds: BOUNDS, type: Float64Array });
			let clone = new SharedQuadtree(memory, main.getSharedMemory());
			expect(clone.type).toEqual(ARRAY_TYPE.float64);
		});

		it('still inserts and retrieves with float64 coordinates', () => {
			let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 5, type: Float64Array });
			tree.insert(1, 100, 100, 10, 10);
			tree.update(1, 900, 900, 10, 10);
			expect(tree.retrieve(880, 880, 40, 40)).toContain(1);
			expect(tree.retrieve(90, 90, 30, 30)).not.toContain(1);
		});
	});

	describe('usedMemory', () => {
		const DEFAULT_MEMORY_USAGE = 6064;

		it('sums the header, node block, pool, and id map', () => {
			let tree = new SharedQuadtree(memory, { bounds: BOUNDS });
			expect(tree.usedMemory).toEqual(DEFAULT_MEMORY_USAGE);
		});
		it('larger maxLevels starts with more memory', () => {
			let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 6 });
			expect(tree.usedMemory).toBeGreaterThan(DEFAULT_MEMORY_USAGE);
		});

		it('is shared between two instances over the same memory', () => {
			let main = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 4 });
			let clone = new SharedQuadtree(memory, main.getSharedMemory());
			expect(clone.usedMemory).toEqual(main.usedMemory);
		});

		it('grows as entities are inserted', () => {
			let tree = new SharedQuadtree(memory, { bounds: BOUNDS, maxLevels: 4, maxEntities: 10 });
			let before = tree.usedMemory;
			for(let i = 0; i < 100; i++) {
				tree.insert(i, i * 5, i * 5, 1, 1);
			}
			expect(tree.usedMemory).toBeGreaterThan(before);
		});
	});
});
