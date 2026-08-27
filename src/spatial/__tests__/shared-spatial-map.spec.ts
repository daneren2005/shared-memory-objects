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
	it('bulkInsert inserts a batch and keeps the last duplicate', () => {
		let map = new SharedSpatialMap(new MemoryHeap(), { gridSize: 50, maxEntities: 10 });
		map.bulkInsert([
			{ id: 1, x: 100, y: 100, width: 10, height: 10 },
			{ id: 2, x: 800, y: 800 },
			{ id: 1, x: 500, y: 500, width: 5, height: 5 },
		]);

		expect(map.size).toBe(2);
		expect(map.search(490, 490, 20, 20)).toContain(1);
		expect(map.search(790, 790, 20, 20)).toContain(2);
	});

	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap();
	});

	it('inserts entities and finds them by region', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 10, 10);
		map.insert(2, 800, 800, 10, 10);

		expect(map.size).toEqual(2);
		expect(new Set(map.search(0, 0, 1000, 1000))).toEqual(new Set([1, 2]));
		let near = map.search(90, 90, 30, 30);
		expect(near).toContain(1);
		expect(near).not.toContain(2);
	});

	it('supports an unbounded world including negative coordinates', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, -5000, -5000, 10, 10);
		map.insert(2, 1_000_000, 1_000_000, 10, 10);

		expect(map.search(-5010, -5010, 30, 30)).toContain(1);
		expect(map.search(999_990, 999_990, 30, 30)).toContain(2);
		expect(map.search(-5010, -5010, 30, 30)).not.toContain(2);
		expect(map.size).toEqual(2);
	});

	it('never returns the same entity twice', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		for(let i = 0; i < 50; i++) {
			map.insert(i, i * 15, i * 15, 5, 5);
		}
		let result = map.search(0, 0, 1000, 1000);
		expect(result.length).toEqual(new Set(result).size);
		expect(result.length).toEqual(50);
	});

	it('places a large object in many cells and returns it exactly once from a spanning query', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 0, 0, 1000, 1000);
		map.insert(2, 500, 500, 2, 2);

		expect(map.search(10, 10, 1, 1)).toContain(1);
		expect(map.search(950, 950, 1, 1)).toContain(1);

		let wide = map.search(100, 100, 800, 800);
		expect(wide.filter(id => id === 1).length).toEqual(1);
		expect(new Set(wide)).toEqual(new Set([1, 2]));
	});

	it('finds a cell-straddling entity from either side once', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		// Straddles the boundary between the (0,0) and (1,0) cells -> lives in both
		map.insert(1, 45, 20, 10, 10);

		expect(map.search(40, 20, 5, 5)).toContain(1);
		expect(map.search(52, 20, 5, 5)).toContain(1);
		let both = map.search(40, 20, 30, 10);
		expect(both.filter(id => id === 1).length).toEqual(1);
	});

	it('updates an entity in place within the same cell', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 10, 10);
		map.update(1, 110, 110, 10, 10);

		expect(map.size).toEqual(1);
		expect(map.search(105, 105, 20, 20)).toContain(1);
	});

	it('moves an entity across cells so old region no longer sees it', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 50, 50, 5, 5);
		expect(map.search(40, 40, 30, 30)).toContain(1);

		map.update(1, 900, 900, 5, 5);
		expect(map.search(40, 40, 30, 30)).not.toContain(1);
		expect(map.search(880, 880, 40, 40)).toContain(1);
		expect(map.size).toEqual(1);
	});

	it('shrinks a multi-cell entity down to one cell and no longer sees it in the vacated cells', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 40, 40, 120, 120); // spans several cells
		expect(map.search(140, 140, 5, 5)).toContain(1);

		map.update(1, 40, 40, 5, 5); // now a single cell
		expect(map.search(140, 140, 5, 5)).not.toContain(1);
		expect(map.search(40, 40, 5, 5)).toContain(1);
		expect(map.size).toEqual(1);
	});

	// Regression for the overlap-cell relink bug: update() used to link the new cells then unlink the old ones. In a cell
	// belonging to BOTH rectangles the new slot went to the bucket head and the unlink removed the first id+cell match - the
	// just-added slot - leaving the stale one behind carrying the old anchor. Which way that broke depended on where the
	// overlap sat relative to the moved anchor: a duplicate id, or a lost one.
	describe('moving across overlapping cells keeps exactly one slot per cell', () => {
		it('does not duplicate when the overlap is a non-anchor cell and the anchor moves', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50 });
			map.insert(1, 95, 5, 20, 0); // cols 1..2, row 0 -> anchor cell (1,0)
			map.update(1, 45, 5, 20, 0); // cols 0..1, row 0 -> overlap is col 1 (non-anchor), anchor moves to (0,0)

			let all = map.search(0, 0, 1000, 1000);
			expect(all.filter(id => id === 1).length).toEqual(1);
			expect(new Set(all)).toEqual(new Set([1]));
			expect(map.size).toEqual(1);
		});

		it('does not lose the entity when its new anchor cell is itself an overlap cell', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50 });
			map.insert(1, 45, 5, 20, 0); // cols 0..1, row 0 -> anchor cell (0,0)
			map.update(1, 95, 5, 20, 0); // cols 1..2, row 0 -> new anchor cell (1,0) is in the overlap

			let all = map.search(0, 0, 1000, 1000);
			expect(all.filter(id => id === 1).length).toEqual(1);
			expect(new Set(all)).toEqual(new Set([1]));
			expect(map.size).toEqual(1);
		});

		it('keeps a 2D straddling entity to a single slot across a diagonal overlap move', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50 });
			map.insert(1, 95, 95, 20, 20); // cols 1..2, rows 1..2
			map.update(1, 45, 45, 20, 20); // cols 0..1, rows 0..1 -> overlap is the single cell (1,1)

			let all = map.search(0, 0, 1000, 1000);
			expect(all.filter(id => id === 1).length).toEqual(1);
			expect(map.size).toEqual(1);
			expect(map.search(45, 45, 5, 5)).toContain(1); // still at the new spot
			expect(map.search(110, 110, 4, 4)).not.toContain(1); // gone from the old-only corner
		});

		it('keeps a single slot even when the two overlap cells collide onto one bucket', () => {
			// A single bucket forces every cell of both rectangles to share one chain, so the relink can only be correct if it
			// matches slots by cell (col, row), not just id.
			let map = new SharedSpatialMap(memory, { gridSize: 50, buckets: 1, maxBuckets: 1 });
			map.insert(1, 95, 5, 20, 0);
			map.update(1, 45, 5, 20, 0);
			expect(map.search(0, 0, 1000, 1000)).toEqual([1]);
			map.update(1, 95, 5, 20, 0);
			expect(map.search(0, 0, 1000, 1000)).toEqual([1]);
			expect(map.size).toEqual(1);
		});

		it('stays consistent through many small overlapping moves', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50 });
			map.insert(1, 100, 100, 20, 20);
			// Deterministic walk kept inside a small cluster of cells so successive rectangles keep overlapping
			let seed = 12345;
			let rand = () => {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				return seed / 0x7fffffff;
			};
			for(let i = 0; i < 500; i++) {
				map.update(1, 40 + rand() * 60, 40 + rand() * 60, 20, 20);
				let all = map.search(0, 0, 1000, 1000);
				expect(all).toEqual([1]);
			}
			expect(map.size).toEqual(1);
		});
	});

	it('update on an unknown id inserts it', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.update(7, 300, 300, 5, 5);
		expect(map.has(7)).toBe(true);
		expect(map.search(290, 290, 30, 30)).toContain(7);
	});

	it('treats inserting an existing id as an update without leaving stale slots', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 40, 40, 120, 120);
		map.insert(1, 900, 900, 10, 10);

		expect(map.size).toEqual(1);
		expect(map.search(100, 100, 10, 10)).not.toContain(1);
		expect(map.search(890, 890, 30, 30)).toEqual([1]);
	});

	it('keeps only live ids through moves, removals, inserts, and reinserts', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 10, 10);
		map.insert(2, 800, 100, 10, 10);
		map.update(1, 790, 790, 20, 20);
		map.remove(2);
		map.update(3, 100, 800, 10, 10);
		map.insert(1, 100, 100, 10, 10);

		expect(new Set(map.search(0, 0, 1000, 1000))).toEqual(new Set([1, 3]));
		expect(map.search(90, 90, 30, 30)).toContain(1);
		expect(map.search(780, 780, 40, 40)).not.toContain(1);
	});

	it('updates across negative cell boundaries even when cells share a bucket', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50, buckets: 1, maxBuckets: 1 });
		map.insert(1, -51, -1, 2, 2);
		map.update(1, -1, -51, 2, 2);

		expect(map.search(-90, -10, 10, 10)).not.toContain(1);
		expect(map.search(-10, -60, 20, 20)).toEqual([1]);
		expect(map.remove(1)).toBe(true);
		expect(map.search(-10, -60, 20, 20)).toEqual([]);
	});

	it('appends candidates into a caller-owned result array', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 10, 10);
		let result = [99];

		expect(map.searchInto(result, 90, 90, 30, 30)).toBe(result);
		expect(result).toEqual([99, 1]);
	});

	it('filters search candidates by id', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 100, 100, 10, 10);
		map.insert(2, 105, 105, 10, 10);

		expect(map.search(90, 90, 40, 40, (id) => id === 2)).toEqual([2]);

		let result = [99];
		expect(map.searchInto(result, 90, 90, 40, 40, (id) => id === 1)).toBe(result);
		expect(result).toEqual([99, 1]);
	});

	it('finds nearest entities in distance order with limits and filtering', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, -100, -100, 10, 10);
		map.insert(2, -70, -100, 10, 10);
		map.insert(3, 50, -100, 10, 10);

		expect(map.neighbors(-95, -95, 2, 200)).toEqual([1, 2]);
		expect(map.neighbors(-95, -95, 3, 20)).toEqual([1]);
		expect(map.neighbors(-95, -95, 2, Infinity, id => id !== 1)).toEqual([2, 3]);
		expect(map.neighbors(-95, -95, 2, -1)).toEqual([]);

		map.update(1, -55, -100, 10, 10);
		expect(map.neighbors(-95, -95, 1, 200)).toEqual([2]);

		map.remove(2);
		map.insert(4, -80, -100, 10, 10);
		expect(map.neighbors(-95, -95, 2, 200)).toEqual([4, 1]);
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

		let result = map.search(90, 90, 30, 30);
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

		expect(new Set(map.search(499, 499, 4, 4))).toEqual(new Set([2, 4]));
		expect(map.size).toEqual(2);
	});

	it('removes a multi-cell entity from every cell it occupied', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 50 });
		map.insert(1, 40, 40, 120, 120);
		map.insert(2, 40, 40, 5, 5);

		expect(map.remove(1)).toBe(true);
		expect(map.search(0, 0, 1000, 1000)).toEqual([2]);
		expect(map.search(140, 140, 5, 5)).not.toContain(1);
		expect(map.size).toEqual(1);
	});

	it('handles many distinct cells colliding onto a tiny bucket array', () => {
		// Far fewer buckets than occupied cells forces heavy chaining, so id+cell disambiguation is exercised hard
		let map = new SharedSpatialMap(memory, { gridSize: 10, buckets: 4, maxBuckets: 4 });
		let rects: Array<Rect> = [];
		for(let id = 0; id < 60; id++) {
			let rect = { id, x: id * 37, y: id * 53, width: 6, height: 6 };
			rects.push(rect);
			map.insert(rect.id, rect.x, rect.y, rect.width, rect.height);
		}
		expect(map.size).toEqual(60);
		for(let rect of rects) {
			let found = map.search(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2);
			expect(found).toContain(rect.id);
		}
		// Whole-world query returns every id exactly once despite the bucket collisions
		let all = map.search(-10, -10, 60 * 37 + 40, 60 * 53 + 40);
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
		expect(map.search(0, 0, 1000, 1000)).toEqual([]);

		map.insert(99, 500, 500, 5, 5);
		expect(map.search(0, 0, 1000, 1000)).toEqual([99]);
	});

	it('a second instance over the same shared memory sees inserts and updates', () => {
		let main = new SharedSpatialMap(memory, { gridSize: 50 });
		let clone = new SharedSpatialMap(memory, main.getSharedMemory());

		main.insert(1, 100, 100, 5, 5);
		expect(clone.search(90, 90, 30, 30)).toContain(1);
		expect(clone.size).toEqual(1);

		clone.update(1, 900, 900, 5, 5);
		expect(main.search(880, 880, 40, 40)).toContain(1);
		expect(main.search(90, 90, 30, 30)).not.toContain(1);

		clone.insert(2, 500, 500, 5, 5);
		expect(main.has(2)).toBe(true);
	});

	it('reports its gridSize and bucket count', () => {
		let map = new SharedSpatialMap(memory, { gridSize: 40, buckets: 1024, maxBuckets: 4096 });
		expect(map.gridSize).toEqual(40);
		expect(map.buckets).toEqual(1024);
		expect(map.maxBuckets).toEqual(4096);

		let clone = new SharedSpatialMap(memory, map.getSharedMemory());
		expect(clone.gridSize).toEqual(40);
		expect(clone.buckets).toEqual(1024);
		expect(clone.maxBuckets).toEqual(4096);
	});

	it('publishes bucket growth to existing shared instances', () => {
		let main = new SharedSpatialMap(memory, { gridSize: 50, buckets: 4, maxBuckets: 64 });
		let clone = new SharedSpatialMap(memory, main.getSharedMemory());
		for(let i = 0; i < 20; i++) {
			main.insert(i, i * 100, i * 100);
		}
		expect(main.buckets).toBeGreaterThan(4);
		expect(clone.buckets).toEqual(main.buckets);
		expect(clone.search(0, 0, 2000, 2000)).toHaveLength(20);
	});

	it('defaults gridSize to 50', () => {
		let map = new SharedSpatialMap(memory);
		expect(map.gridSize).toEqual(50);
		expect(map.buckets).toEqual(256);
	});

	it('search returns every true overlap (randomized cross-check against brute force)', () => {
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

			let result = map.search(query.x, query.y, query.width, query.height);
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
			let result = map.search(query.x, query.y, query.width, query.height);
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
			expect(map.search(90, 90, 30, 30)).toContain(bigId);
		});

		it('a second instance over the same memory reports the same type', () => {
			let main = new SharedSpatialMap(memory, { type: Float64Array });
			let clone = new SharedSpatialMap(memory, main.getSharedMemory());
			expect(clone.type).toEqual(ARRAY_TYPE.float64);
		});

		it('still inserts and finds with float64 coordinates', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50, type: Float64Array });
			map.insert(1, 100, 100, 10, 10);
			map.update(1, 900, 900, 10, 10);
			expect(map.search(880, 880, 40, 40)).toContain(1);
			expect(map.search(90, 90, 30, 30)).not.toContain(1);
		});
	});

	describe('usedMemory', () => {
		it('sums the header, bucket pages, pointer stack, pools, and id map', () => {
			let map = new SharedSpatialMap(memory);
			expect(map.usedMemory).toBeGreaterThan(0);
		});
		it('an explicitly larger initial bucket count starts with more memory', () => {
			let few = new SharedSpatialMap(memory, { buckets: 256 });
			let many = new SharedSpatialMap(new MemoryHeap(), { buckets: 16384 });
			expect(many.usedMemory).toBeGreaterThan(few.usedMemory);
		});

		it('grows the bucket count and storage as slots are inserted', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50, buckets: 64, maxBuckets: 1024 });
			let before = map.usedMemory;
			for(let i = 0; i < 100; i++) {
				map.insert(i, i * 100, i * 100);
			}
			expect(map.buckets).toBeGreaterThan(64);
			expect(map.usedMemory).toBeGreaterThan(before);
		});

		it('honors maxBuckets', () => {
			let map = new SharedSpatialMap(memory, { gridSize: 50, buckets: 4, maxBuckets: 8 });
			for(let i = 0; i < 100; i++) {
				map.insert(i, i * 100, i * 100);
			}
			expect(map.buckets).toEqual(8);
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
