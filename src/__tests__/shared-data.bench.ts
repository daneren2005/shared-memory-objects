import { bench } from 'vitest';
import SharedList from '../shared-list';
import MemoryHeap from '../memory-heap';
import SharedMap from '../shared-map';
import SharedVector from '../shared-vector';
import SharedPool from '../shared-pool';
import LocalPool from '../local-pool';

const ITERATE_COUNT = 10_000;
describe(`Shared Data Structures: ${ITERATE_COUNT} iterations`, () => {
	let sharedList: SharedList;
	bench('shared list', () => {
		// eslint-disable-next-line
		for(let number of sharedList) {}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap();
				sharedList = new SharedList(memory);
				for(let i = 0; i < ITERATE_COUNT; i++) {
					sharedList.insert(Math.random() * 1_000_000);
				}
			};
		}
	});

	let sharedVector: SharedVector;
	bench('shared vector', () => {
		// eslint-disable-next-line
		for(let number of sharedVector) {}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 100
				});
				sharedVector = new SharedVector(memory);
				for(let i = 0; i < ITERATE_COUNT; i++) {
					sharedVector.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let localPool: LocalPool;
	bench('local pool', () => {
		// eslint-disable-next-line
		for(let number of localPool) {}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 100
				});
				localPool = new LocalPool(memory, { type: Uint32Array });
				for(let i = 0; i < ITERATE_COUNT; i++) {
					localPool.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let sharedPool: SharedPool;
	bench('shared pool', () => {
		// eslint-disable-next-line
		for(let number of sharedPool) {}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 100
				});
				sharedPool = new SharedPool(memory);
				for(let i = 0; i < ITERATE_COUNT; i++) {
					sharedPool.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let list: Array<number>;
	bench('native array', () => {
		// eslint-disable-next-line
		for(let number of list) {}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				list = [];
				for(let i = 0; i < ITERATE_COUNT; i++) {
					list.push(Math.random() * 1_000_000);
				}
			};
		}
	});
});


const INDEX_COUNT = 1_000;
describe(`Shared Data Structures: ${INDEX_COUNT} indexed locations`, () => {
	let sharedVector: SharedVector;
	bench('shared vector', () => {
		for(let i = 0; i < INDEX_COUNT; i++) {
			sharedVector.get(randomIndex(sharedVector));
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 100
				});
				sharedVector = new SharedVector(memory);
				for(let i = 0; i < INDEX_COUNT; i++) {
					sharedVector.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let localPool: LocalPool;
	bench('local pool', () => {
		for(let i = 0; i < INDEX_COUNT; i++) {
			localPool.get(randomIndex(localPool));
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 100
				});
				localPool = new LocalPool(memory, { type: Uint32Array });
				for(let i = 0; i < INDEX_COUNT; i++) {
					localPool.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let sharedPool: SharedPool;
	bench('shared pool', () => {
		for(let i = 0; i < INDEX_COUNT; i++) {
			sharedPool.get(randomIndex(sharedPool));
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 100
				});
				sharedPool = new SharedPool(memory);
				for(let i = 0; i < INDEX_COUNT; i++) {
					sharedPool.push(Math.random() * 1_000_000);
				}
			};
		}
	});
	
	let list: Array<number>;
	bench('native array', () => {
		for(let i = 0; i < INDEX_COUNT; i++) {
			// eslint-disable-next-line
			list[randomIndex(list)];
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				list = [];
				for(let i = 0; i < INDEX_COUNT; i++) {
					list.push(Math.random() * 1_000_000);
				}
			};
		}
	});
});

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
	bench('local pool', () => {
		let memory = new MemoryHeap();
		let list = new LocalPool(memory, { type: Uint32Array });

		for(let i = 0; i < INSERT_COUNT; i++) {
			list.push(Math.random() * 1_000_000);
		}
	});
	bench('shared pool', () => {
		let memory = new MemoryHeap();
		let list = new SharedPool(memory);

		for(let i = 0; i < INSERT_COUNT; i++) {
			list.push(Math.random() * 1_000_000);
		}
	});

	let sharedPool: SharedPool;
	bench('shared pool with already deleted elements', () => {
		for(let i = 0; i < INSERT_COUNT; i++) {
			sharedPool.push(Math.random() * 1_000_000);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap();
				sharedPool = new SharedPool(memory, {
					// Make sure we are not measuring time to grow recycle buffer at all during the test
					recycleBufferLength: INSERT_COUNT
				});

				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedPool.push(Math.random() * 1_000_000);
				}
				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedPool.deleteIndex(i);
				}
			};
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
			sharedVector.deleteIndex(randomIndex(sharedVector));
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


	let localPool: LocalPool;
	bench('local pool', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			localPool.deleteIndex(randomIndex(localPool));
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 16
				});
				localPool = new LocalPool(memory, { type: Uint32Array });
				for(let i = 0; i < INSERT_COUNT; i++) {
					localPool.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let sharedPool: SharedPool;
	bench('shared pool', () => {
		for(let i = 0; i < DELETE_COUNT; i++) {
			sharedPool.deleteIndex(randomIndex(sharedPool));
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 16
				});
				sharedPool = new SharedPool(memory);
				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedPool.push(Math.random() * 1_000_000);
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

describe(`Shared Data Structures: ${INSERT_COUNT} insert and deleting random elements`, () => {
	const RUN_COUNT = 2_000;

	let sharedList: SharedList;
	bench('shared list', () => {
		for(let i = 0; i < RUN_COUNT; i++) {
			if(Math.random() > 0.6) {
				sharedList.deleteIndex(randomIndex(sharedList));
			} else {
				sharedList.insert(Math.random() * 1_000_000);
			}
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
		for(let i = 0; i < RUN_COUNT; i++) {
			if(Math.random() > 0.6) {
				sharedVector.deleteIndex(randomIndex(sharedVector));
			} else {
				sharedVector.push(Math.random() * 1_000_000);
			}
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

	let localPool: LocalPool;
	bench('local pool', () => {
		for(let i = 0; i < RUN_COUNT; i++) {
			if(Math.random() > 0.6) {
				localPool.deleteIndex(randomIndex(localPool));
			} else {
				localPool.push(Math.random() * 1_000_000);
			}
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 16
				});
				localPool = new LocalPool(memory, { type: Uint32Array });
				for(let i = 0; i < INSERT_COUNT; i++) {
					localPool.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let sharedPool: SharedPool;
	bench('shared pool', () => {
		for(let i = 0; i < RUN_COUNT; i++) {
			if(Math.random() > 0.6) {
				sharedPool.deleteIndex(randomIndex(sharedPool));
			} else {
				sharedPool.push(Math.random() * 1_000_000);
			}
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				let memory = new MemoryHeap({
					bufferSize: 1024 * 16
				});
				sharedPool = new SharedPool(memory);
				for(let i = 0; i < INSERT_COUNT; i++) {
					sharedPool.push(Math.random() * 1_000_000);
				}
			};
		}
	});

	let nativeList: Array<number> = [];
	bench('native array', () => {
		for(let i = 0; i < RUN_COUNT; i++) {
			if(Math.random() > 0.6) {
				nativeList.splice(randomIndex(nativeList), 1);
			} else {
				nativeList.push(Math.random() * 1_000_000);
			}
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