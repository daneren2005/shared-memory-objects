import MemoryHeap from '../../memory-heap';
import SharedSpatialGrid from '../shared-spatial-grid';
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

describe('SharedSpatialGrid', () => {
	it('bulkInsert inserts a batch and keeps the last duplicate', () => {
		let grid = new SharedSpatialGrid(new MemoryHeap(), { bounds: BOUNDS, gridSize: 50, maxEntities: 10 });
		grid.bulkInsert([
			{ id: 1, x: 100, y: 100, width: 10, height: 10 },
			{ id: 2, x: 800, y: 800 },
			{ id: 1, x: 500, y: 500, width: 5, height: 5 },
		]);

		expect(grid.size).toBe(2);
		expect(grid.search(490, 490, 20, 20)).toContain(1);
		expect(grid.search(790, 790, 20, 20)).toContain(2);
	});

	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap();
	});

	it('inserts entities and finds them by region', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 100, 100, 10, 10);
		grid.insert(2, 800, 800, 10, 10);

		expect(grid.size).toEqual(2);
		// A query over the whole world returns everything
		expect(new Set(grid.search(0, 0, 1000, 1000))).toEqual(new Set([1, 2]));
		// A query near the first entity returns it and not the far one
		let near = grid.search(90, 90, 30, 30);
		expect(near).toContain(1);
		expect(near).not.toContain(2);
	});

	it('never returns the same entity twice', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		for(let i = 0; i < 50; i++) {
			grid.insert(i, i * 15, i * 15, 5, 5);
		}
		let result = grid.search(0, 0, 1000, 1000);
		expect(result.length).toEqual(new Set(result).size);
		expect(result.length).toEqual(50);
	});

	it('places a large object in many cells and returns it exactly once from a spanning query', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		// Spans the whole world -> occupies every cell, but a query over any region returns it a single time
		grid.insert(1, 0, 0, 1000, 1000);
		grid.insert(2, 500, 500, 2, 2);

		expect(grid.search(10, 10, 1, 1)).toContain(1);
		expect(grid.search(950, 950, 1, 1)).toContain(1);

		// A query that spans many of the big entity's cells must still see it only once
		let wide = grid.search(100, 100, 800, 800);
		expect(wide.filter(id => id === 1).length).toEqual(1);
		expect(new Set(wide)).toEqual(new Set([1, 2]));
	});

	it('finds a cell-straddling entity from either side once', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		// Straddles the boundary between the (0,0) and (1,0) cells -> lives in both
		grid.insert(1, 45, 20, 10, 10);

		expect(grid.search(40, 20, 5, 5)).toContain(1);
		expect(grid.search(52, 20, 5, 5)).toContain(1);
		// Overlapping both of its cells still returns it once
		let both = grid.search(40, 20, 30, 10);
		expect(both.filter(id => id === 1).length).toEqual(1);
	});

	it('updates an entity in place within the same cell', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 100, 100, 10, 10);
		grid.update(1, 110, 110, 10, 10);

		expect(grid.size).toEqual(1);
		expect(grid.search(105, 105, 20, 20)).toContain(1);
	});

	it('moves an entity across cells so old region no longer sees it', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 50, 50, 5, 5);
		expect(grid.search(40, 40, 30, 30)).toContain(1);

		grid.update(1, 900, 900, 5, 5);
		expect(grid.search(40, 40, 30, 30)).not.toContain(1);
		expect(grid.search(880, 880, 40, 40)).toContain(1);
		expect(grid.size).toEqual(1);
	});

	it('shrinks a multi-cell entity down to one cell and no longer sees it in the vacated cells', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 40, 40, 120, 120); // spans several cells
		expect(grid.search(140, 140, 5, 5)).toContain(1);

		grid.update(1, 40, 40, 5, 5); // now a single cell
		expect(grid.search(140, 140, 5, 5)).not.toContain(1);
		expect(grid.search(40, 40, 5, 5)).toContain(1);
		expect(grid.size).toEqual(1);
	});

	// Regression for the overlap-cell relink bug: update() used to link the new cells then unlink the old ones. In a cell
	// belonging to BOTH rectangles the new slot went to the bucket head and the unlink removed the first id-match - the
	// just-added slot - leaving the stale one behind carrying the old anchor. Which way that broke depended on where the
	// overlap sat relative to the moved anchor: a duplicate id, or a lost one.
	describe('moving across overlapping cells keeps exactly one slot per cell', () => {
		it('does not duplicate when the overlap is a non-anchor cell and the anchor moves', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
			grid.insert(1, 95, 5, 20, 0); // cols 1..2, row 0 -> anchor cell (1,0)
			grid.update(1, 45, 5, 20, 0); // cols 0..1, row 0 -> overlap is col 1 (non-anchor), anchor moves to (0,0)

			let all = grid.search(0, 0, 1000, 1000);
			expect(all.filter(id => id === 1).length).toEqual(1);
			expect(new Set(all)).toEqual(new Set([1]));
			expect(grid.size).toEqual(1);
		});

		it('does not lose the entity when its new anchor cell is itself an overlap cell', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
			grid.insert(1, 45, 5, 20, 0); // cols 0..1, row 0 -> anchor cell (0,0)
			grid.update(1, 95, 5, 20, 0); // cols 1..2, row 0 -> new anchor cell (1,0) is in the overlap

			let all = grid.search(0, 0, 1000, 1000);
			expect(all.filter(id => id === 1).length).toEqual(1);
			expect(new Set(all)).toEqual(new Set([1]));
			expect(grid.size).toEqual(1);
		});

		it('keeps a 2D straddling entity to a single slot across a diagonal overlap move', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
			grid.insert(1, 95, 95, 20, 20); // cols 1..2, rows 1..2
			grid.update(1, 45, 45, 20, 20); // cols 0..1, rows 0..1 -> overlap is the single cell (1,1)

			let all = grid.search(0, 0, 1000, 1000);
			expect(all.filter(id => id === 1).length).toEqual(1);
			expect(grid.size).toEqual(1);
			expect(grid.search(45, 45, 5, 5)).toContain(1); // still at the new spot
			expect(grid.search(110, 110, 4, 4)).not.toContain(1); // gone from the old-only corner
		});

		it('stays consistent through many small overlapping moves', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
			grid.insert(1, 100, 100, 20, 20);
			// Deterministic walk kept inside a small cluster of cells so successive rectangles keep overlapping
			let seed = 12345;
			let rand = () => {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				return seed / 0x7fffffff;
			};
			for(let i = 0; i < 500; i++) {
				grid.update(1, 40 + rand() * 60, 40 + rand() * 60, 20, 20);
				let all = grid.search(0, 0, 1000, 1000);
				expect(all).toEqual([1]);
			}
			expect(grid.size).toEqual(1);
		});
	});

	it('update on an unknown id inserts it', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.update(7, 300, 300, 5, 5);
		expect(grid.has(7)).toBe(true);
		expect(grid.search(290, 290, 30, 30)).toContain(7);
	});

	it('treats inserting an existing id as an update without leaving stale slots', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 40, 40, 120, 120);
		grid.insert(1, 900, 900, 10, 10);

		expect(grid.size).toEqual(1);
		expect(grid.search(100, 100, 10, 10)).not.toContain(1);
		expect(grid.search(890, 890, 30, 30)).toEqual([1]);
	});

	it('keeps only live ids through moves, removals, inserts, and reinserts', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 100, 100, 10, 10);
		grid.insert(2, 800, 100, 10, 10);
		grid.update(1, 790, 790, 20, 20);
		grid.remove(2);
		grid.update(3, 100, 800, 10, 10);
		grid.insert(1, 100, 100, 10, 10);

		expect(new Set(grid.search(0, 0, 1000, 1000))).toEqual(new Set([1, 3]));
		expect(grid.search(90, 90, 30, 30)).toContain(1);
		expect(grid.search(780, 780, 40, 40)).not.toContain(1);
	});

	it('handles a negative origin and partial edge cells', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: { x: -125, y: 25, width: 105, height: 70 }, gridSize: 50 });
		grid.insert(1, -125, 25, 1, 1);
		grid.insert(2, -21, 94, 1, 1);

		expect(grid.columns).toEqual(3);
		expect(grid.rowCount).toEqual(2);
		expect(grid.search(-125, 25, 1, 1)).toContain(1);
		expect(grid.search(-21, 94, 1, 1)).toContain(2);
	});

	it('appends candidates into a caller-owned result array', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 100, 100, 10, 10);
		let result = [99];

		expect(grid.searchInto(result, 90, 90, 30, 30)).toBe(result);
		expect(result).toEqual([99, 1]);
	});

	it('filters search candidates by id', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 100, 100, 10, 10);
		grid.insert(2, 105, 105, 10, 10);

		expect(grid.search(90, 90, 40, 40, (id) => id === 2)).toEqual([2]);

		let result = [99];
		expect(grid.searchInto(result, 90, 90, 40, 40, (id) => id === 1)).toBe(result);
		expect(result).toEqual([99, 1]);
	});

	it('finds nearest entities in distance order with limits and filtering', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 100, 100, 10, 10);
		grid.insert(2, 130, 100, 10, 10);
		grid.insert(3, 250, 100, 10, 10);

		expect(grid.neighbors(105, 105, 2, 200)).toEqual([1, 2]);
		expect(grid.neighbors(105, 105, 3, 20)).toEqual([1]);
		expect(grid.neighbors(105, 105, 2, 200, id => id !== 1)).toEqual([2, 3]);
		expect(grid.neighbors(105, 105, 0, 200)).toEqual([]);

		grid.update(1, 145, 100, 10, 10);
		expect(grid.neighbors(105, 105, 1, 200)).toEqual([2]);
	});

	it('removes entities and recycles their slots', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 100, 100, 5, 5);
		grid.insert(2, 100, 100, 5, 5);
		grid.insert(3, 100, 100, 5, 5);

		expect(grid.remove(2)).toBe(true);
		expect(grid.remove(2)).toBe(false);
		expect(grid.has(2)).toBe(false);
		expect(grid.size).toEqual(2);

		let result = grid.search(90, 90, 30, 30);
		expect(new Set(result)).toEqual(new Set([1, 3]));
	});

	it('unlinks correctly when removing the head, middle, and tail of a bucket', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		// All land in the same cell so they share one bucket
		for(let id of [1, 2, 3, 4, 5]) {
			grid.insert(id, 500, 500, 1, 1);
		}
		grid.remove(5); // most-recently-inserted = head
		grid.remove(1); // oldest = tail
		grid.remove(3); // middle

		expect(new Set(grid.search(499, 499, 4, 4))).toEqual(new Set([2, 4]));
		expect(grid.size).toEqual(2);
	});

	it('removes a multi-cell entity from every cell it occupied', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		grid.insert(1, 40, 40, 120, 120);
		grid.insert(2, 40, 40, 5, 5);

		expect(grid.remove(1)).toBe(true);
		expect(grid.search(0, 0, 1000, 1000)).toEqual([2]);
		expect(grid.search(140, 140, 5, 5)).not.toContain(1);
		expect(grid.size).toEqual(1);
	});

	it('clear empties the grid but keeps it usable', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		for(let i = 0; i < 20; i++) {
			grid.insert(i, i * 10, i * 10, 5, 5);
		}
		grid.clear();
		expect(grid.size).toEqual(0);
		expect(grid.search(0, 0, 1000, 1000)).toEqual([]);

		grid.insert(99, 500, 500, 5, 5);
		expect(grid.search(0, 0, 1000, 1000)).toEqual([99]);
	});

	it('a second instance over the same shared memory sees inserts and updates', () => {
		let main = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
		let clone = new SharedSpatialGrid(memory, main.getSharedMemory());

		main.insert(1, 100, 100, 5, 5);
		expect(clone.search(90, 90, 30, 30)).toContain(1);
		expect(clone.size).toEqual(1);

		clone.update(1, 900, 900, 5, 5);
		expect(main.search(880, 880, 40, 40)).toContain(1);
		expect(main.search(90, 90, 30, 30)).not.toContain(1);

		clone.insert(2, 500, 500, 5, 5);
		expect(main.has(2)).toBe(true);
	});

	it('reports its grid dimensions from bounds and gridSize', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: { x: 0, y: 0, width: 1000, height: 500 }, gridSize: 50 });
		expect(grid.gridSize).toEqual(50);
		expect(grid.columns).toEqual(20);
		expect(grid.rowCount).toEqual(10);

		let clone = new SharedSpatialGrid(memory, grid.getSharedMemory());
		expect(clone.columns).toEqual(20);
		expect(clone.rowCount).toEqual(10);
		expect(clone.gridSize).toEqual(50);
	});

	it('defaults gridSize to 50', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: { x: 0, y: 0, width: 100, height: 100 } });
		expect(grid.gridSize).toEqual(50);
		expect(grid.columns).toEqual(2);
		expect(grid.rowCount).toEqual(2);
	});

	it('search returns every true overlap (randomized cross-check against brute force)', () => {
		let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 40 });
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
			grid.insert(rect.id, rect.x, rect.y, rect.width, rect.height);
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

			let result = grid.search(query.x, query.y, query.width, query.height);
			// No duplicates even though entities span multiple cells
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
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS });
			expect(grid.type).toEqual(ARRAY_TYPE.float32);
		});

		it('can be configured as float64 and costs more per entity', () => {
			let f32 = new SharedSpatialGrid(memory, { bounds: BOUNDS, type: Float32Array });
			let f64 = new SharedSpatialGrid(memory, { bounds: BOUNDS, type: Float64Array });
			expect(f64.type).toEqual(ARRAY_TYPE.float64);
			expect(f64.usedMemory).toBeGreaterThan(f32.usedMemory);
		});

		it('rejects a float32 grid with more than 2^24 entities but allows it for float64', () => {
			expect(() => new SharedSpatialGrid(memory, { bounds: BOUNDS, maxEntities: 0x1000000 + 1 }))
				.toThrow('Float32 SharedSpatialGrid supports at most');
			expect(() => new SharedSpatialGrid(memory, { bounds: BOUNDS, maxEntities: 0x1000000 + 1, type: Float64Array }))
				.not.toThrow();
		});

		it('keeps large ids and coordinates exact with float64', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50, type: Float64Array });
			let bigId = 2 ** 40 + 7;
			grid.insert(bigId, 100, 100, 10, 10);
			expect(grid.search(90, 90, 30, 30)).toContain(bigId);
		});

		it('a second instance over the same memory reports the same type', () => {
			let main = new SharedSpatialGrid(memory, { bounds: BOUNDS, type: Float64Array });
			let clone = new SharedSpatialGrid(memory, main.getSharedMemory());
			expect(clone.type).toEqual(ARRAY_TYPE.float64);
		});

		it('still inserts and finds with float64 coordinates', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50, type: Float64Array });
			grid.insert(1, 100, 100, 10, 10);
			grid.update(1, 900, 900, 10, 10);
			expect(grid.search(880, 880, 40, 40)).toContain(1);
			expect(grid.search(90, 90, 30, 30)).not.toContain(1);
		});
	});

	describe('usedMemory', () => {
		it('sums the header, cell block, pools, and id map', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS });
			expect(grid.usedMemory).toBeGreaterThan(0);
		});
		it('a smaller gridSize (more cells) starts with more memory', () => {
			let coarse = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 100 });
			let fine = new SharedSpatialGrid(new MemoryHeap(), { bounds: BOUNDS, gridSize: 25 });
			expect(fine.usedMemory).toBeGreaterThan(coarse.usedMemory);
		});

		it('is shared between two instances over the same memory', () => {
			let main = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50 });
			let clone = new SharedSpatialGrid(memory, main.getSharedMemory());
			expect(clone.usedMemory).toEqual(main.usedMemory);
		});

		it('grows as entities are inserted', () => {
			let grid = new SharedSpatialGrid(memory, { bounds: BOUNDS, gridSize: 50, maxEntities: 10 });
			let before = grid.usedMemory;
			for(let i = 0; i < 100; i++) {
				grid.insert(i, i * 5, i * 5, 1, 1);
			}
			expect(grid.usedMemory).toBeGreaterThan(before);
		});
	});
});
