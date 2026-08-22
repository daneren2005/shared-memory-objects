import SharedList from '../shared-list';
import MemoryHeap from '../memory-heap';
import SharedString from '../shared-string';
import { getPointer } from '../utils/pointer';

describe('SharedList', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap({ bufferSize: 1024 * 16 });
	});

	it('can insert items', () => {
		let list = new SharedList(memory);

		list.insert(5);
		expect(list.length).toEqual(1);

		list.insert(10);
		list.insert(4);
		expect(list.length).toEqual(3);

		expect(flat(list)).toEqual([5, 10, 4]);
	});
	it('can delete items by index', () => {
		let list = new SharedList(memory);
		let startMemory = memory.currentUsed;
		list.insert(5);
		list.insert(10);
		list.insert(4);
		list.insert(8);
		list.insert(20);
		let fullMemory = memory.currentUsed;

		list.deleteIndex(2);
		expect(flat(list)).toEqual([5, 10, 8, 20]);
		// Deferred reclamation: the tombstoned node's memory is not freed until compact()
		expect(memory.currentUsed).toEqual(fullMemory);
		expect(list.length).toEqual(4);
		list.compact();
		expect(memory.currentUsed).toBeLessThan(fullMemory);

		list.deleteIndex(0);
		expect(flat(list)).toEqual([10, 8, 20]);
		list.deleteIndex(2);
		expect(flat(list)).toEqual([10, 8]);

		// Do nothing for bug deletes
		list.deleteIndex(2);
		expect(flat(list)).toEqual([10, 8]);

		// Delete everything and should still work
		list.deleteIndex(0);
		list.deleteIndex(0);
		expect(flat(list)).toEqual([]);
		expect(list.length).toEqual(0);
		list.compact();
		expect(memory.currentUsed).toEqual(startMemory);

		list.insert(80);
		list.insert(52);
		expect(flat(list)).toEqual([80, 52]);
	});
	it('can delete items by value', () => {
		let list = new SharedList(memory);
		let startMemory = memory.currentUsed;
		list.insert(5);
		list.insert(10);
		list.insert(4);
		list.insert(8);
		list.insert(20);
		let fullMemory = memory.currentUsed;

		list.deleteValue(4);
		expect(flat(list)).toEqual([5, 10, 8, 20]);
		// Deferred reclamation: the tombstoned node's memory is not freed until compact()
		expect(memory.currentUsed).toEqual(fullMemory);
		expect(list.length).toEqual(4);
		list.compact();
		expect(memory.currentUsed).toBeLessThan(fullMemory);

		list.deleteValue(5);
		expect(flat(list)).toEqual([10, 8, 20]);
		list.deleteValue(20);
		expect(flat(list)).toEqual([10, 8]);

		// Do nothing for bug deletes
		list.deleteValue(15);
		expect(flat(list)).toEqual([10, 8]);

		// Delete everything and should still work
		list.deleteValue(10);
		list.deleteValue(8);
		expect(flat(list)).toEqual([]);
		expect(list.length).toEqual(0);
		list.compact();
		expect(memory.currentUsed).toEqual(startMemory);

		list.insert(80);
		list.insert(52);
		expect(flat(list)).toEqual([80, 52]);
	});

	it('can delete during iteration', () => {
		let list = new SharedList(memory);
		list.insert(5);
		list.insert(10);
		list.insert(4);
		list.insert(8);
		list.insert(20);
		let fullMemory = memory.currentUsed;

		for(let { data, deleteCurrent } of list) {
			if(data[0] === 10 || data[0] === 20) {
				deleteCurrent();
			}
		}
		
		expect(flat(list)).toEqual([5, 4, 8]);
		expect(list.length).toEqual(3);
		// Tombstoned nodes are only reclaimed on compact()
		expect(memory.currentUsed).toEqual(fullMemory);
		list.compact();
		expect(memory.currentUsed).toBeLessThan(fullMemory);

		// Delete concurrent indexes
		for(let { data, deleteCurrent } of list) {
			if(data[0] === 5 || data[0] === 4) {
				deleteCurrent();
			}
		}
		expect(flat(list)).toEqual([8]);
		expect(list.length).toEqual(1);
	});

	it('can insert and delete over and over again without leaking memory', () => {
		let list = new SharedList(memory);
		list.insert(5);
		list.insert(10);
		let startMemory = memory.currentUsed;

		for(let i = 0; i < 10; i++) {
			list.insert(70);
			list.deleteIndex(2);
		}
		for(let i = 0; i < 10; i++) {
			list.insert(70);
			list.deleteValue(70);
		}

		// Tombstones accumulate until compact() reclaims them
		list.compact();
		expect(memory.currentUsed).toEqual(startMemory);
		expect(flat(list)).toEqual([5, 10]);
	});

	it('can delete with onDelete SharedString', () => {
		let list = new SharedList(memory);
		list.onDelete = (pointerData => {
			let string = new SharedString(memory, getPointer(pointerData[0]));
			string.free();
		});
		list.insert((new SharedString(memory, 'Test')).pointer);
		list.insert((new SharedString(memory, 'Test')).pointer);
		list.insert((new SharedString(memory, 'Test')).pointer);

		let startMemory = memory.currentUsed;
		list.insert((new SharedString(memory, 'Test')).pointer);
		list.deleteIndex(2);
		// onDelete (freeing the SharedString) fires at delete time, but the list node is reclaimed on compact()
		list.compact();
		expect(memory.currentUsed).toEqual(startMemory);
	});

	describe('compact', () => {
		it('reclaims tombstoned nodes and preserves live order', () => {
			let list = new SharedList(memory);
			for(let value of [1, 2, 3, 4, 5, 6]) {
				list.insert(value);
			}
			let fullMemory = memory.currentUsed;

			list.deleteValue(2);
			list.deleteValue(4);
			list.deleteValue(6);
			// Still linked (just skipped), memory unchanged until compact
			expect(flat(list)).toEqual([1, 3, 5]);
			expect(list.length).toEqual(3);
			expect(memory.currentUsed).toEqual(fullMemory);

			list.compact();
			expect(flat(list)).toEqual([1, 3, 5]);
			expect(list.length).toEqual(3);
			expect(memory.currentUsed).toBeLessThan(fullMemory);

			// List keeps working after compact - can still append and delete
			list.insert(7);
			expect(flat(list)).toEqual([1, 3, 5, 7]);
			list.deleteValue(1);
			list.compact();
			expect(flat(list)).toEqual([3, 5, 7]);
		});

		it('compacting an empty or all-live list is a no-op', () => {
			let list = new SharedList(memory);
			list.compact();
			expect(flat(list)).toEqual([]);

			list.insert(10);
			list.insert(20);
			let before = memory.currentUsed;
			list.compact();
			expect(flat(list)).toEqual([10, 20]);
			expect(memory.currentUsed).toEqual(before);

			list.insert(30);
			expect(flat(list)).toEqual([10, 20, 30]);
		});

		it('fires onDelete exactly once per removed item', () => {
			let deleted: number[] = [];
			let list = new SharedList(memory);
			list.onDelete = data => deleted.push(data[0]);

			list.insert(1);
			list.insert(2);
			list.insert(3);

			list.deleteValue(2);
			expect(deleted).toEqual([2]);

			// compact frees the tombstoned node but must not re-fire onDelete
			list.compact();
			expect(deleted).toEqual([2]);
		});
	});

	describe('clear', () => {
		it('basic', () => {
			let list = new SharedList(memory);
			let startMemory = memory.currentUsed;

			// Clear while already clear should be fine
			list.clear();
			expect(flat(list)).toEqual([]);
			expect(list.length).toEqual(0);

			for(let i = 0; i < 10; i++) {
				list.insert(70);
			}
			list.clear();

			expect(flat(list)).toEqual([]);
			expect(list.length).toEqual(0);
			expect(memory.currentUsed).toEqual(startMemory);
		});

		it('with onDelete SharedString', () => {
			let list = new SharedList(memory);
			list.onDelete = (pointerData => {
				let string = new SharedString(memory, getPointer(pointerData[0]));
				string.free();
			});
			let startMemory = memory.currentUsed;

			for(let i = 0; i < 10; i++) {
				const string = new SharedString(memory, 'Test');
				list.insert(string.pointer);
			}
			list.clear();

			expect(flat(list)).toEqual([]);
			expect(list.length).toEqual(0);
			expect(memory.currentUsed).toEqual(startMemory);
		});
	});

	it('can share memory and insert/delete items from either instance', () => {
		let mainList = new SharedList(memory);
		let secondList = new SharedList(memory, mainList.getSharedMemory());

		mainList.insert(5);
		mainList.insert(60);
		secondList.insert(14);
		mainList.insert(8);
		secondList.deleteIndex(1);

		expect(flat(mainList)).toEqual([5, 14, 8]);
		expect(flat(secondList)).toEqual([5, 14, 8]);
	});
	it.skip('can delete item mid-iteration');

	describe('free', () => {
		it('basic', () => {
			let startMemory = memory.currentUsed;
			let list = new SharedList(memory);
			list.insert(5);
			list.insert(10);
			list.insert(4);
	
			list.free();
			expect(memory.currentUsed).toEqual(startMemory);
		});

		it('with onDelete SharedString', () => {
			let startMemory = memory.currentUsed;
			let list = new SharedList(memory);
			list.onDelete = (pointerData => {
				let string = new SharedString(memory, getPointer(pointerData[0]));
				string.free();
			});
			list.insert((new SharedString(memory, 'Test')).pointer);
			list.insert((new SharedString(memory, 'Test')).pointer);
			list.insert((new SharedString(memory, 'Test')).pointer);
	
			list.free();
			expect(memory.currentUsed).toEqual(startMemory);
		});
	});

	it('with int32', () => {
		let list = new SharedList(memory, {
			type: Int32Array,
		});

		list.insert(5);
		expect(list.length).toEqual(1);

		list.insert(-10);
		list.insert(4);
		expect(list.length).toEqual(3);

		expect(flat(list)).toEqual([5, -10, 4]);
	});
	it('with float32', () => {
		let list = new SharedList(memory, {
			type: Float32Array,
		});

		list.insert(5.5);
		expect(list.length).toEqual(1);

		list.insert(-10);
		list.insert(4);
		expect(list.length).toEqual(3);

		expect(flat(list)).toEqual([5.5, -10, 4]);
	});

	it('with dataLength = 3', () => {
		let list = new SharedList(memory, {
			type: Int32Array,
			dataLength: 3,
		});

		list.insert(5);
		expect(list.length).toEqual(1);

		list.insert([-10, 20, 1]);
		list.insert([4, -40]);
		expect(list.length).toEqual(3);

		expect(flat(list)).toEqual([
			5, 0, 0,
			-10, 20, 1,
			4, -40, 0,
		]);

		// Don't delete middle values
		list.deleteValue(20);
		expect(flat(list)).toEqual([
			5, 0, 0,
			-10, 20, 1,
			4, -40, 0,
		]);

		// Allow deleting first value only
		list.deleteValue(-10);
		expect(flat(list)).toEqual([
			5, 0, 0,
			4, -40, 0,
		]);
		expect(list.length).toEqual(2);

		// Allow deleting entire set of values
		list.deleteValue([4, 10, 0]);
		list.deleteValue([5, 0, 0]);
		expect(flat(list)).toEqual([
			4, -40, 0,
		]);
		expect(list.length).toEqual(1);
	});

	it('initWithBlock', () => {
		let block = memory.allocUI32(SharedList.ALLOCATE_COUNT);
		let list = new SharedList(memory, {
			initWithBlock: block,
		});

		list.insert(5);
		list.insert(10);
		list.insert(4);
		list.deleteValue(10);
		expect(list.length).toEqual(2);
		expect(flat(list)).toEqual([5, 4]);
	});
});

function flat(list: SharedList<any>) {
	return [...list].reduce((array, value) => {
		// @ts-expect-error
		array.push(...value.data);

		return array;
	}, []);
}