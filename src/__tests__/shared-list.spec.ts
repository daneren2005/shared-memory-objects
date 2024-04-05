import SharedList from '../shared-list';
import MemoryHeap from '../memory-heap';

describe('SharedList', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap();
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
		expect(memory.currentUsed).toBeLessThan(fullMemory);
		expect(list.length).toEqual(4);

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
		expect(memory.currentUsed).toBeLessThan(fullMemory);
		expect(list.length).toEqual(4);

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

		expect(memory.currentUsed).toEqual(startMemory);
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

	it('free', () => {
		let startMemory = memory.currentUsed;
		let list = new SharedList(memory);
		list.insert(5);
		list.insert(10);
		list.insert(4);

		list.free();
		expect(memory.currentUsed).toEqual(startMemory);
	});

	it('with int32', () => {
		let list = new SharedList(memory, {
			type: Int32Array
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
			type: Float32Array
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
			dataLength: 3
		});

		list.insert(5);
		expect(list.length).toEqual(1);

		list.insert([-10, 20, 1]);
		list.insert([4, -40]);
		expect(list.length).toEqual(3);

		expect(flat(list)).toEqual([
			5, 0, 0,
			-10, 20, 1,
			4, -40, 0
		]);

		// Don't delete middle values
		list.deleteValue(20);
		expect(flat(list)).toEqual([
			5, 0, 0,
			-10, 20, 1,
			4, -40, 0
		]);

		// Allow deleting first value only
		list.deleteValue(-10);
		expect(flat(list)).toEqual([
			5, 0, 0,
			4, -40, 0
		]);
		expect(list.length).toEqual(2);

		// Allow deleting entire set of values
		list.deleteValue([4, 10, 0]);
		list.deleteValue([5, 0, 0]);
		expect(flat(list)).toEqual([
			4, -40, 0
		]);
		expect(list.length).toEqual(1);
	});

	it('initWithBlock', () => {
		let block = memory.allocUI32(SharedList.ALLOCATE_COUNT);
		let list = new SharedList(memory, {
			initWithBlock: block
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