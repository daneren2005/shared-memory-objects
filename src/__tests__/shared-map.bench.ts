import { benchmarkSuite } from './helpers/benchmark-suite';
import type { BenchmarkRegistrar } from './helpers/benchmark-suite';
import MemoryHeap from '../memory-heap';
import SharedMap from '../shared-map';

const COUNT = 1_000;

// Pre-generate a stable set of keys/values so every benchmark hits the same distribution of slots/collisions
const keys: Array<number> = [];
for(let i = 0; i < COUNT; i++) {
	keys.push(i);
}
const values: Array<number> = keys.map(() => Math.random() * 1_000_000);

interface MapLike {
	set(key: number, value: number): void
	get(key: number): number | undefined
	delete(key: number): boolean
	[Symbol.iterator](): IterableIterator<[number, number]>
}
type Factory = () => MapLike;

const implementations: Array<[string, Factory]> = [
	['shared map', () => new SharedMap<number>(new MemoryHeap())],
	['native map', () => new Map<number, number>()],
];

// Builds and fills a fresh map before each sample so the timed body starts from the same populated state
function benchPopulated(bench: BenchmarkRegistrar, name: string, factory: Factory, run: (map: MapLike) => void) {
	let map: MapLike;
	bench(name, () => {
		run(map);
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				map = factory();
				for(let i = 0; i < COUNT; i++) {
					map.set(keys[i], values[i]);
				}
			};
		},
	});
}

benchmarkSuite(`SharedMap implementations: ${COUNT} sets`, (bench) => {
	for(let [name, factory] of implementations) {
		bench(name, () => {
			let map = factory();
			for(let i = 0; i < COUNT; i++) {
				map.set(keys[i], values[i]);
			}
		});
	}
});

benchmarkSuite(`SharedMap implementations: ${COUNT} overwrites`, (bench) => {
	for(let [name, factory] of implementations) {
		benchPopulated(bench, name, factory, (map) => {
			for(let i = 0; i < COUNT; i++) {
				map.set(keys[i], values[i] + 1);
			}
		});
	}
});

benchmarkSuite(`SharedMap implementations: ${COUNT} gets`, (bench) => {
	for(let [name, factory] of implementations) {
		benchPopulated(bench, name, factory, (map) => {
			for(let i = 0; i < COUNT; i++) {
				map.get(keys[i]);
			}
		});
	}
});

benchmarkSuite(`SharedMap implementations: ${COUNT} deletes`, (bench) => {
	for(let [name, factory] of implementations) {
		benchPopulated(bench, name, factory, (map) => {
			for(let i = 0; i < COUNT; i++) {
				map.delete(keys[i]);
			}
		});
	}
});

benchmarkSuite(`SharedMap implementations: iterate ${COUNT} entries`, (bench) => {
	for(let [name, factory] of implementations) {
		benchPopulated(bench, name, factory, (map) => {
			// eslint-disable-next-line
			for(let entry of map) {}
		});
	}
});
