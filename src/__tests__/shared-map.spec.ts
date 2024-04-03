import MemoryHeap from '../memory-heap';
import SharedMap from '../shared-map';

describe('SharedMap', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap();
	});

	describe('SharedMap<string>', () => {
		it('insert and remove items', () => {
			let map = new SharedMap<string>(memory);

			// NOTE: If values are changed make sure we have at least one hash collision
			map.set('ds', 3);
			map.set('asd', 72);
			map.set('gfredf', 8);
			map.set('z', 65);
			// Map should only have one instance of each key - replace
			map.set('ds', 1);
			map.set('red', 10);
			expect(map.length).toEqual(5);

			expect(map.get('gfredf')).toEqual(8);
			expect(map.get('ds')).toEqual(1);
			expect(map.get('z')).toEqual(65);
			expect(map.get('blue')).toBeUndefined();
			expect(map.get('red')).toEqual(10);

			map.delete('ds');
			expect(map.length).toEqual(4);
			expect(map.get('ds')).toEqual(undefined);
			map.delete('ds');
			expect(map.length).toEqual(4);

			map.delete('dfsdfsd');
			expect(map.length).toEqual(4);
			map.delete('gfredf');
			expect(map.length).toEqual(3);
		});

		it('free', () => {
			let startMemory = memory.currentUsed;
			let map = new SharedMap<string>(memory);
			map.set('ds', 3);
			map.set('asd', 72);
			map.set('gfredf', 8);
			map.set('z', 65);

			map.free();
			expect(memory.currentUsed).toEqual(startMemory);
		});

		it('can be created from shared memory', () => {
			let startMemory = memory.currentUsed;
			let mainMap = new SharedMap<string>(memory);
			let cloneMap = new SharedMap<string>(memory, mainMap.getSharedMemory());

			mainMap.set('ds', 3);
			mainMap.set('asd', 72);
			cloneMap.set('ds', 1);
			cloneMap.set('red', 10);

			expect(mainMap.length).toEqual(3);
			expect(cloneMap.length).toEqual(3);
			
			expect(mainMap.get('ds')).toEqual(1);
			expect(cloneMap.get('ds')).toEqual(1);

			cloneMap.free();
			expect(memory.currentUsed).toEqual(startMemory);
		});

		it('inserting many items will grow hash table', () => {
			let map = new SharedMap<string>(memory);
			const previousMaxHash = map.maxHash;
			for(let i = 0; i < 5; i++) {
				insertRandom(map);
			}
			expect(map.length).toEqual(5);

			expect(map.maxHash).toEqual(previousMaxHash);
			for(let i = 0; i < 20; i++) {
				insertRandom(map);
			}
			expect(map.length).toEqual(25);
			expect(map.maxHash).toBeGreaterThan(previousMaxHash);

			for(let i = 0; i < map.length; i++) {
				expect(map.get(`${i + 1}`)).not.toBeUndefined();
			}
		});

		function insertRandom(map: SharedMap<string>) {
			map.set(`${map.length + 1}`, Math.random() * 1_000_000);
		}
	});
});