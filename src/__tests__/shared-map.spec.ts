import MemoryHeap from '../memory-heap';
import SharedMap from '../shared-map';

function insertRandom(map: SharedMap<string>) {
	map.set(`${map.length + 1}`, Math.random() * 1_000_000);
}

describe('SharedMap', () => {
	let memory: MemoryHeap;
	beforeEach(() => {
		memory = new MemoryHeap({ bufferSize: 1024 * 16 });
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

		it('update does an atomic read-modify-write, inserting when absent', () => {
			let map = new SharedMap<string>(memory);

			// Absent key: updater sees undefined and the returned value is inserted.
			expect(map.update('ore', current => (current ?? 0) + 5)).toEqual(5);
			expect(map.get('ore')).toEqual(5);
			expect(map.length).toEqual(1);

			// Existing key: updater sees the stored value; length is unchanged.
			expect(map.update('ore', current => (current ?? 0) + 3)).toEqual(8);
			expect(map.get('ore')).toEqual(8);
			expect(map.length).toEqual(1);

			// Clamping subtraction never wraps past zero.
			expect(map.update('ore', current => Math.max(0, (current ?? 0) - 100))).toEqual(0);
			expect(map.get('ore')).toEqual(0);
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

		it('growing the hash table does not leak memory', () => {
			let startMemory = memory.currentUsed;
			let map = new SharedMap<string>(memory);

			// Enough distinct keys to force at least one hash table growth
			for(let i = 0; i < 30; i++) {
				map.set(`key-${i}`, i);
			}
			expect(map.maxHash).toBeGreaterThan(10);

			// All values should still be readable after the growth/rehash
			for(let i = 0; i < 30; i++) {
				expect(map.get(`key-${i}`)).toEqual(i);
			}

			map.free();
			expect(memory.currentUsed).toEqual(startMemory);
		});
	});

	describe('SharedMap<number>', () => {
		it('insert, read, and remove numeric keys', () => {
			let map = new SharedMap<number>(memory);

			map.set(1, 100);
			map.set(2, 200);
			map.set(3, 300);
			expect(map.length).toEqual(3);

			expect(map.get(1)).toEqual(100);
			expect(map.get(2)).toEqual(200);
			expect(map.has(3)).toEqual(true);
			expect(map.has(4)).toEqual(false);
			expect(map.get(4)).toBeUndefined();

			// Overwriting an existing key should not change length
			map.set(2, 222);
			expect(map.length).toEqual(3);
			expect(map.get(2)).toEqual(222);

			expect(map.delete(2)).toEqual(true);
			expect(map.length).toEqual(2);
			expect(map.get(2)).toBeUndefined();
			expect(map.delete(2)).toEqual(false);
		});

		it('handles key 0 and value 0', () => {
			let map = new SharedMap<number>(memory);
			map.set(0, 0);
			expect(map.has(0)).toEqual(true);
			expect(map.get(0)).toEqual(0);
			expect(map.delete(0)).toEqual(true);
			expect(map.get(0)).toBeUndefined();
		});

		it('reuses a tombstone slot so length stays correct after delete then re-insert', () => {
			let map = new SharedMap<number>(memory);
			map.set(1, 10);
			map.set(2, 20);
			map.delete(1);
			map.set(1, 11);
			expect(map.length).toEqual(2);
			expect(map.get(1)).toEqual(11);
			expect(map.get(2)).toEqual(20);
		});

		it('stores signed values with Int32Array', () => {
			let map = new SharedMap<number, Int32Array>(memory, { type: Int32Array });
			map.set(1, -100);
			map.set(2, 2147483647);
			map.set(3, -2147483648);
			expect(map.get(1)).toEqual(-100);
			expect(map.get(2)).toEqual(2147483647);
			expect(map.get(3)).toEqual(-2147483648);
		});

		it('stores fractional values with Float32Array', () => {
			let map = new SharedMap<number, Float32Array>(memory, { type: Float32Array });
			map.set(1, 0.5);
			map.set(2, -3.25);
			expect(map.get(1)).toEqual(0.5);
			expect(map.get(2)).toEqual(-3.25);
			// Survives a rehash with the value type preserved
			for(let i = 10; i < 60; i++) {
				map.set(i, i + 0.5);
			}
			expect(map.get(1)).toEqual(0.5);
			expect(map.get(42)).toEqual(42.5);
		});

		it('stores full-precision values with Float64Array', () => {
			let map = new SharedMap<number, Float64Array>(memory, { type: Float64Array });
			map.set(1, Number.MAX_SAFE_INTEGER);
			map.set(2, -3.25);
			expect(map.get(1)).toEqual(Number.MAX_SAFE_INTEGER);
			expect(map.get(2)).toEqual(-3.25);
			// Survives a rehash with the 64-bit stride preserved
			for(let i = 10; i < 60; i++) {
				map.set(i, i + 0.5);
			}
			expect(map.get(1)).toEqual(Number.MAX_SAFE_INTEGER);
			expect(map.get(42)).toEqual(42.5);
		});

		it('stores bigint values with BigInt64Array', () => {
			let map = new SharedMap<number, BigInt64Array>(memory, { type: BigInt64Array });
			map.set(1, -100n);
			map.set(2, 9223372036854775807n);
			map.set(3, -9223372036854775808n);
			expect(map.get(1)).toEqual(-100n);
			expect(map.get(2)).toEqual(9223372036854775807n);
			expect(map.get(3)).toEqual(-9223372036854775808n);
			// Survives a rehash with the value type preserved
			for(let i = 10; i < 60; i++) {
				map.set(i, BigInt(i));
			}
			expect(map.get(2)).toEqual(9223372036854775807n);
			expect(map.get(42)).toEqual(42n);
		});

		it('stores large unsigned bigint values with BigUint64Array', () => {
			let map = new SharedMap<number, BigUint64Array>(memory, { type: BigUint64Array });
			map.set(1, 18446744073709551615n);
			map.set(2, 0n);
			expect(map.get(1)).toEqual(18446744073709551615n);
			expect(map.get(2)).toEqual(0n);
			expect(map.has(1)).toEqual(true);
			expect(map.delete(1)).toEqual(true);
			expect(map.get(1)).toBeUndefined();
		});

		it('iterates every live entry exactly once', () => {
			let map = new SharedMap<number>(memory);
			for(let i = 0; i < 50; i++) {
				map.set(i, i * 10);
			}
			map.delete(7);
			map.delete(42);

			let seen = new Map<number, number>();
			for(let [key, value] of map) {
				seen.set(key, value);
			}

			expect(seen.size).toEqual(48);
			expect(seen.get(7)).toBeUndefined();
			expect(seen.get(42)).toBeUndefined();
			expect(seen.get(13)).toEqual(130);
		});
	});

	describe('usedMemory', () => {
		it('counts the metadata block plus the table allocation', () => {
			let map = new SharedMap<number>(memory);
			let pointerMemory = memory.allocUI32(SharedMap.ALLOCATE_COUNT).usedMemory;
			let table = memory.allocUI32(16 * (2 + 1)).usedMemory;
			expect(map.usedMemory).toEqual(pointerMemory + table);
		});

		it('grows when the table is resized', () => {
			let map = new SharedMap<number>(memory);
			let before = map.usedMemory;
			for(let i = 0; i < 100; i++) {
				map.set(i, i);
			}
			expect(map.usedMemory).toBeGreaterThan(before);
		});
	});
});