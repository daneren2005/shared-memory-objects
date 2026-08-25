import SharedList from '../shared-list';
import MemoryHeap from '../memory-heap';
import { createPointer } from '../utils/pointer';

// These tests deterministically drive the code paths that only ever execute under real concurrency:
//  - the Michael-Scott "help a lagging tail hint" branch in insert()
//  - the "lost the tombstone compareExchange" branch in deleteCurrent()
// Sequential single-instance usage never reaches them, so we force the exact shared-state windows by hand.
const TAIL_INDEX = 1;

describe('SharedList concurrency windows', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap({ bufferSize: 1024 * 16 });
	});

	// Build a raw view over the list's first block (the sentinel) so we can simulate a half-finished enqueue
	function firstBlockView(list: SharedList): { view: Uint32Array, sentinelPointer: number } {
		let { bufferPosition, bufferByteOffset } = list.getSharedMemory().firstBlock;
		return {
			view: new Uint32Array(memory.buffers[bufferPosition].buf, bufferByteOffset, 4),
			sentinelPointer: createPointer(bufferPosition, bufferByteOffset, memory.positionBits),
		};
	}

	it('insert repairs a tail hint that lags by one node', () => {
		let list = new SharedList(memory);
		list.insert(1);
		list.insert(2);

		// Simulate an in-flight enqueue that linked its node but has not yet swung the tail hint:
		// point the hint back at the sentinel as if no swing had happened.
		let { view, sentinelPointer } = firstBlockView(list);
		Atomics.store(view, TAIL_INDEX, sentinelPointer);

		// insert must walk/help the hint forward and still append at the true end
		list.insert(3);
		expect(flat(list)).toEqual([1, 2, 3]);
		expect(list.length).toEqual(3);
	});

	it('insert repairs a tail hint that lags by several nodes', () => {
		let list = new SharedList(memory);
		for(let value of [1, 2, 3, 4, 5]) {
			list.insert(value);
		}

		let { view, sentinelPointer } = firstBlockView(list);
		Atomics.store(view, TAIL_INDEX, sentinelPointer);

		list.insert(6);
		expect(flat(list)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(list.length).toEqual(6);

		// The hint is now repaired: a following insert is cheap and still correct
		list.insert(7);
		expect(flat(list)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it('two instances racing the same delete: the loser returns false and length is decremented once', () => {
		let main = new SharedList(memory);
		let other = new SharedList(memory, main.getSharedMemory());
		main.insert(1);
		main.insert(2);
		main.insert(3);

		// Grab a live handle to node 2 from one instance...
		let handle: { deleteCurrent: () => boolean } | undefined;
		for(let item of main) {
			if(item.data[0] === 2) {
				handle = item;
				break;
			}
		}
		expect(handle).toBeDefined();

		// ...while the other instance tombstones the same node first
		expect(other.deleteValue(2)).toBe(true);
		expect(main.length).toEqual(2);

		// The stale handle loses the compareExchange and must not double-decrement
		expect(handle!.deleteCurrent()).toBe(false);
		expect(main.length).toEqual(2);
		expect(flat(main)).toEqual([1, 3]);
		expect(flat(other)).toEqual([1, 3]);
	});

	it('interleaved inserts from two instances keep every value in append order', () => {
		let main = new SharedList(memory);
		let other = new SharedList(memory, main.getSharedMemory());

		let expected: number[] = [];
		for(let i = 0; i < 50; i++) {
			(i % 2 === 0 ? main : other).insert(i);
			expected.push(i);
		}

		expect(main.length).toEqual(50);
		expect(flat(main)).toEqual(expected);
		expect(flat(other)).toEqual(expected);
	});

	it('interleaved insert and delete across instances stays consistent', () => {
		let main = new SharedList(memory);
		let other = new SharedList(memory, main.getSharedMemory());

		for(let i = 0; i < 20; i++) {
			main.insert(i);
		}
		// Delete every even value from the other instance while re-reading from main
		for(let i = 0; i < 20; i += 2) {
			expect(other.deleteValue(i)).toBe(true);
		}

		let survivors = [];
		for(let i = 1; i < 20; i += 2) {
			survivors.push(i);
		}
		expect(flat(main)).toEqual(survivors);
		expect(main.length).toEqual(survivors.length);

		// compact from one instance is visible to both
		main.compact();
		expect(flat(other)).toEqual(survivors);
		expect(other.length).toEqual(survivors.length);
	});
});

function flat(list: SharedList<any>) {
	return [...list].reduce((array, value) => {
		// @ts-expect-error
		array.push(...value.data);

		return array;
	}, []);
}
