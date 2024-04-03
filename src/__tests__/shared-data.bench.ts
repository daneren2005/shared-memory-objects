import { bench } from 'vitest';
import SharedList from '../shared-list';
import MemoryHeap from '../memory-heap';
import SharedMap from '../shared-map';
import SharedVector from '../shared-vector';

const INSERT_COUNT = 1_000;
describe(`Shared Data Structures: ${INSERT_COUNT} inserts`, () => {
	bench('shared list', () => {
		let memory = new MemoryHeap();
		let list = new SharedList(memory);

		for(let i = 0; i < INSERT_COUNT; i++) {
			list.insert(Math.random() * 1_000_000);
		}
	});
	bench('shared map', () => {
		let memory = new MemoryHeap();
		let list = new SharedMap<number>(memory);

		for(let i = 0; i < INSERT_COUNT; i++) {
			list.set(Math.random() * 1_000_000, Math.random() * 1_000_000);
		}
	});
	bench('shared vector', () => {
		let memory = new MemoryHeap();
		let list = new SharedVector(memory);

		for(let i = 0; i < INSERT_COUNT; i++) {
			list.push(Math.random() * 1_000_000);
		}
	});
	bench('shared vector with correct amount initialized', () => {
		let memory = new MemoryHeap();
		let list = new SharedVector(memory, {
			bufferLength: INSERT_COUNT + 2
		});

		for(let i = 0; i < INSERT_COUNT; i++) {
			list.push(Math.random() * 1_000_000);
		}
	});
	bench('native array', () => {
		let list: Array<number> = [];
		for(let i = 0; i < INSERT_COUNT; i++) {
			list.push(Math.random() * 1_000_000);
		}
	});
});

const DELETE_COUNT = 1_000;
describe(`Shared Data Structures: ${DELETE_COUNT} deletes end element`, () => {
	const INSERT_COUNT = 2_000;

	let sharedList: SharedList;
	bench('shared list', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			sharedList.deleteIndex(0);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap();
				sharedList = new SharedList(memory);
				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedList.insert(Math.random() * 1_000_000);
				}
			};
		}
	});

	let sharedVector: SharedVector;
	bench('shared vector', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			sharedVector.pop();
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 16
				});
				sharedVector = new SharedVector(memory);
				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedVector.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let nativeList: Array<number> = [];
	bench('native array', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			nativeList.pop();
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				nativeList = [];
				for(let i = 0; i < INSERT_COUNT; i++) {
					nativeList.push(Math.random() * 1_000_000);
				}
			};
		}
	});
});

describe(`Shared Data Structures: ${DELETE_COUNT} deletes random element`, () => {
	const INSERT_COUNT = 2_000;

	let sharedList: SharedList;
	bench('shared list', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			sharedList.deleteIndex(randomIndex(sharedList));
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap();
				sharedList = new SharedList(memory);
				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedList.insert(Math.random() * 1_000_000);
				}
			};
		}
	});

	let sharedVector: SharedVector;
	bench('shared vector', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			sharedVector.deleteIndex(randomIndex(sharedList));
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 16
				});
				sharedVector = new SharedVector(memory);
				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedVector.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let nativeList: Array<number> = [];
	bench('native array', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			nativeList.splice(randomIndex(nativeList), 1);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				nativeList = [];
				for(let i = 0; i < INSERT_COUNT; i++) {
					nativeList.push(Math.random() * 1_000_000);
				}
			};
		}
	});
});

function randomIndex(array: { length: number }) {
	return Math.floor(Math.random() * array.length);
}