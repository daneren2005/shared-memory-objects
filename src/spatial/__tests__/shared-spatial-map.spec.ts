import MemoryHeap from '../../memory-heap';
import SharedSpatialMap from '../shared-spatial-map';
import { ARRAY_TYPE } from '../../utils/array-type';

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

describe('SharedSpatialMap', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap();
	});

	it('inserts entities and retrieves them by region', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 10, 10);
		map.insert(2, 800, 800, 10, 10);

		expect(map.size).toEqual(2);
		expect(new Set(map.retrieve(0, 0, 1000, 1000))).toEqual(new Set([1, 2]));
		let near = map.retrieve(90, 90, 30, 30);
		expect(near).toContain(1);
		expect(near).not.toContain(2);
	});

	it('supports an unbounded world including negative coordinates', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, -5000, -5000, 10, 10);
		map.insert(2, 1_000_000, 1_000_000, 10, 10);

		expect(map.retrieve(-5010, -5010, 30, 30)).toContain(1);
		expect(map.retrieve(999_990, 999_990, 30, 30)).toContain(2);
		expect(map.retrieve(-5010, -5010, 30, 30)).not.toContain(2);
		expect(map.size).toEqual(2);
	});

	it('never returns the same entity twice', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		for(let i = 0; i < 50; i++) {
			map.insert(i, i * 15, i * 15, 5, 5);
		}
		let result = map.retrieve(0, 0, 1000, 1000);
		expect(result.length).toEqual(new Set(result).size);
		expect(result.length).toEqual(50);
	});

	it('places a large object in many cells and returns it exactly once from a spanning query', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 0, 0, 1000, 1000);
		map.insert(2, 500, 500, 2, 2);

		expect(map.retrieve(10, 10, 1, 1)).toContain(1);
		expect(map.retrieve(950, 950, 1, 1)).toContain(1);

		let wide = map.retrieve(100, 100, 800, 800);
		expect(wide.filter(id => id === 1).length).toEqual(1);
		expect(new Set(wide)).toEqual(new Set([1, 2]));
	});

	it('finds a cell-straddling entity from either side once', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		// Straddles the boundary between the (0,0) and (1,0) cells -> lives in both
		map.insert(1, 45, 20, 10, 10);

		expect(map.retrieve(40, 20, 5, 5)).toContain(1);
		expect(map.retrieve(52, 20, 5, 5)).toContain(1);
		let both = map.retrieve(40, 20, 30, 10);
		expect(both.filter(id => id === 1).length).toEqual(1);
	});

	it('updates an entity in place within the same cell', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 10, 10);
		map.update(1, 110, 110, 10, 10);

		expect(map.size).toEqual(1);
		expect(map.retrieve(105, 105, 20, 20)).toContain(1);
	});

	it('moves an entity across cells so old region no longer sees it', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 50, 50, 5, 5);
		expect(map.retrieve(40, 40, 30, 30)).toContain(1);

		map.update(1, 900, 900, 5, 5);
		expect(map.retrieve(40, 40, 30, 30)).not.toContain(1);
		expect(map.retrieve(880, 880, 40, 40)).toContain(1);
		expect(map.size).toEqual(1);
	});

	it('shrinks a multi-cell entity down to one cell and no longer sees it in the vacated cells', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 40, 40, 120, 120); // spans several cells
		expect(map.retrieve(140, 140, 5, 5)).toContain(1);

		map.update(1, 40, 40, 5, 5); // now a single cell
		expect(map.retrieve(140, 140, 5, 5)).not.toContain(1);
		expect(map.retrieve(40, 40, 5, 5)).toContain(1);
		expect(map.size).toEqual(1);
	});

	it('update on an unknown id inserts it', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.update(7, 300, 300, 5, 5);
		expect(map.has(7)).toBe(true);
		expect(map.retrieve(290, 290, 30, 30)).toContain(7);
	});

	it('removes entities and recycles their slots', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 5, 5);
		map.insert(2, 100, 100, 5, 5);
		map.insert(3, 100, 100, 5, 5);

		expect(map.remove(2)).toBe(true);
		expect(map.remove(2)).toBe(false);
		expect(map.has(2)).toBe(false);
		expect(map.size).toEqual(2);

		let result = map.retrieve(90, 90, 30, 30);
		expect(new Set(result)).toEqual(new Set([1, 3]));
	});

	it('unlinks correctly when removing the head, middle, and tail of a bucket', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		// All land in the same cell so they share one bucket
		for(let id of [1, 2, 3, 4, 5]) {
			map.insert(id, 500, 500, 1, 1);
		}
		map.remove(5); // most-recently-inserted = head
		map.remove(1); // oldest = tail
		map.remove(3); // middle

		expect(new Set(map.retrieve(499, 499, 4, 4))).toEqual(new Set([2, 4]));
		expect(map.size).toEqual(2);
	});

	it('removes a multi-cell entity from every cell it occupied', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 40, 40, 120, 120);
		map.insert(2, 40, 40, 5, 5);

		expect(map.remove(1)).toBe(true);
		expect(map.retrieve(0, 0, 1000, 1000)).toEqual([2]);
		expect(map.retrieve(140, 140, 5, 5)).not.toContain(1);
		expect(map.size).toEqual(1);
	});

	it('handles many distinct cells colliding onto a tiny bucket array', () => {
		// Far fewer buckets than occupied cells forces heavy chaining, so id+cell disambiguation is exercised hard
		let map = new SharedSpatialMap(memory, { gridSize: 10, buckets: 4 });
		let rects: Array<Rect> = [];
		for(let id = 0; id < 60; id++) {
			let rect = { id, x: id * 37, y: id * 53, width: 6, height: 6 };
			rects.push(rect);
			map.insert(rect.id, rect.x, rect.y, rect.width, rect.height);
		}
		expect(map.size).toEqual(60);
		for(let rect of rects) {
			let found = map.retrieve(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2);
			expect(found).toContain(rect.id);
		}
		// Whole-world query returns every id exactly once despite the bucket collisions
		let all = map.retrieve(-10, -10, 60 * 37 + 40, 60 * 53 + 40);
		expect(all.length).toEqual(new Set(all).size);
		expect(new Set(all)).toEqual(new Set(rects.map(rect => rect.id)));
	});

	it('clear empties the map but keeps it usable', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		for(let i = 0; i < 20; i++) {
			map.insert(i, i * 10, i * 10, 5, 5);
		}
		map.clear();
		expect(map.size).toEqual(0);
		expect(map.retrieve(0, 0, 1000, 1000)).toEqual([]);

		map.insert(99, 500, 500, 5, 5);
		expect(map.retrieve(0, 0, 1000, 1000)).toEqual([99]);
	});

	it('a second instance over the same shared memory sees inserts and updates', () => {
		let main = new SharedSpatialMap(memory, { gridSize: 50 });
		let clone = new SharedSpatialMap(memory, main.getSharedMemory());

		main.insert(1, 100, 100, 5, 5);
		expect(clone.retrieve(90, 90, 30, 30)).toContain(1);
		expect(clone.size).toEqual(1);

		clone.update(1, 900, 900, 5, 5);
		expect(main.retrieve(880, 880, 40, 40)).toContain(1);
		expect(main.retrieve(90, 90, 30, 30)).not.toContain(1);

		clone.insert(2, 500, 500, 5, 5);
		expect(main.has(2)).toBe(true);
	});

	it('reports its gridSize and bucket count', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 40, buckets: 1024 });
		expect(map.gridSize).toEqual(40);
		expect(map.buckets).toEqual(1024);

		let clone = new SharedSpatialMap(memory, map.getSharedMemory());
		expect(clone.gridSize).toEqual(40);
		expect(clone.buckets).toEqual(1024);
	});

	it('defaults gridSize to 50', () => {
		let map = new SharedSpatialMap(memory);
		expect(map.gridSize).toEqual(50);
	});

	it('retrieve returns every true overlap (randomized cross-check against brute force)', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 40, buckets: 256 });
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
				// Range spans negative and positive to exercise the unbounded world
				x: -500 + random() * 2000,
				y: -500 + random() * 2000,
				width,
				height,
			};
			rects.push(rect);
			map.insert(rect.id, rect.x, rect.y, rect.width, rect.height);
		}

		for(let q = 0; q < 200; q++) {
			let width = 1 + random() * 100;
			let height = 1 + random() * 100;
			let query = {
				x: -500 + random() * 2000,
				y: -500 + random() * 2000,
				width,
				height,
			};

			let result = map.retrieve(query.x, query.y, query.width, query.height);
			// No duplicates even though entities span multiple cells and cells collide onto buckets
			expect(result.length).toEqual(new Set(result).size);

			let found = new Set(result);
			let expected = rects.filter(rect => overlaps(rect, query)).map(rect => rect.id);
			for(let id of expected) {
				expect(found.has(id)).toBe(true);
			}
		}
	});

	it('works with a non-power-of-two bucket count (modulo fallback)', () => {
		// 1000 is not a power of two, so bucketOf falls back to hash % bucketCount instead of the bitmask
		let map = new SharedSpatialMap(memory, { gridSize: 40, buckets: 1000 });
		expect(map.buckets).toEqual(1000);

		let rects: Array<Rect> = [];
		let seed = 42;
		let random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for(let id = 0; id < 300; id++) {
			let rect = { id, x: -500 + random() * 2000, y: -500 + random() * 2000, width: 1 + random() * 40, height: 1 + random() * 40 };
			rects.push(rect);
			map.insert(rect.id, rect.x, rect.y, rect.width, rect.height);
		}

		for(let q = 0; q < 100; q++) {
			let query = { x: -500 + random() * 2000, y: -500 + random() * 2000, width: 1 + random() * 100, height: 1 + random() * 100 };
			let result = map.retrieve(query.x, query.y, query.width, query.height);
			expect(result.length).toEqual(new Set(result).size);

			let found = new Set(result);
			let expected = rects.filter(rect => overlaps(rect, query)).map(rect => rect.id);
			for(let id of expected) {
				expect(found.has(id)).toBe(true);
			}
		}
	});

	describe('coordinate type', () => {
		it('defaults to float32', () => {
			let map = new SharedSpatialMap(memory);
			expect(map.type).toEqual(ARRAY_TYPE.float32);
		});

		it('can be configured as float64 and costs more per entity', () => {
			let f32 = new SharedSpatialMap(memory, { type: Float32Array });
			let f64 = new SharedSpatialMap(memory, { type: Float64Array });
			expect(f64.type).toEqual(ARRAY_TYPE.float64);
			expect(f64.usedMemory).toBeGreaterThan(f32.usedMemory);
		});

		it('rejects a float32 map with more than 2^24 entities but allows it for float64', () => {
			expect(() => new SharedSpatialMap(memory, { maxEntities: 0x1000000 + 1 }))
				.toThrow('Float32 SharedSpatialMap supports at most');
			expect(() => new SharedSpatialMap(memory, { maxEntities: 0x1000000 + 1, type: Float64Array }))
				.not.toThrow();
		});

		it('keeps large ids and coordinates exact with float64', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50, type: Float64Array });
			let bigId = 2 ** 40 + 7;
			map.insert(bigId, 100, 100, 10, 10);
			expect(map.retrieve(90, 90, 30, 30)).toContain(bigId);
		});

		it('a second instance over the same memory reports the same type', () => {
			let main = new SharedSpatialMap(memory, { type: Float64Array });
			let clone = new SharedSpatialMap(memory, main.getSharedMemory());
			expect(clone.type).toEqual(ARRAY_TYPE.float64);
		});

		it('still inserts and retrieves with float64 coordinates', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50, type: Float64Array });
			map.insert(1, 100, 100, 10, 10);
			map.update(1, 900, 900, 10, 10);
			expect(map.retrieve(880, 880, 40, 40)).toContain(1);
			expect(map.retrieve(90, 90, 30, 30)).not.toContain(1);
		});
	});

	describe('usedMemory', () => {
		it('sums the header, bucket block, pools, and id map', () => {
			let map = new SharedSpatialMap(memory);
			expect(map.usedMemory).toBeGreaterThan(0);
		});
		it('more buckets starts with more memory', () => {
			let few = new SharedSpatialMap(memory, { buckets: 256 });
			let many = new SharedSpatialMap(new MemoryHeap(), { buckets: 16384 });
			expect(many.usedMemory).toBeGreaterThan(few.usedMemory);
		});

		it('is shared between two instances over the same memory', () => {
			let main = new SharedSpatialMap(memory, { gridSize: 50 });
			let clone = new SharedSpatialMap(memory, main.getSharedMemory());
			expect(clone.usedMemory).toEqual(main.usedMemory);
		});

		it('grows as entities are inserted', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50, maxEntities: 10 });
			let before = map.usedMemory;
			for(let i = 0; i < 100; i++) {
				map.insert(i, i * 5, i * 5, 1, 1);
			}
			expect(map.usedMemory).toBeGreaterThan(before);
		});
	});
});
