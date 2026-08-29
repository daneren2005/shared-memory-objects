import { bench, describe } from 'vitest';
import MemoryBuffer from '../memory-buffer';
import MemoryHeap from '../memory-heap';
import type AllocatedMemory from '../allocated-memory';

// Mirrors how MemoryHeap drives its buffers (high-churn, no compaction/splitting) so alloc/free costs match real usage.
const ALLOC_COUNT = 5_000;
const ALLOC_SIZE = 8;
const BUFFER_SIZE = 8 * 1024 * 1024;

function makeBuffer() {
	return new MemoryBuffer({
		buf: new ArrayBuffer(BUFFER_SIZE),
		compact: false,
		split: false,
	});
}

function fillBuffer() {
	const buffer = makeBuffer();
	const addrs: Array<number> = [];
	for(let i = 0; i < ALLOC_COUNT; i++) {
		addrs.push(buffer.malloc(ALLOC_SIZE * 4));
	}
	return { buffer, addrs };
}

describe(`MemoryBuffer: ${ALLOC_COUNT} allocations`, () => {
	bench('malloc', () => {
		const buffer = makeBuffer();
		for(let i = 0; i < ALLOC_COUNT; i++) {
			buffer.malloc(ALLOC_SIZE * 4);
		}
	});

	// Every block is bump-allocated from pristine memory, so callocAs skips zero-filling.
	bench('callocAs (fresh)', () => {
		const buffer = makeBuffer();
		for(let i = 0; i < ALLOC_COUNT; i++) {
			buffer.callocAs('u32', ALLOC_SIZE);
		}
	});

	// Blocks are reused from the free list (dirty), so callocAs must zero-fill each one.
	let dirty: MemoryBuffer;
	bench('callocAs (reused)', () => {
		for(let i = 0; i < ALLOC_COUNT; i++) {
			dirty.callocAs('u32', ALLOC_SIZE);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				dirty = makeBuffer();
				const addrs: Array<number> = [];
				for(let i = 0; i < ALLOC_COUNT; i++) {
					addrs.push(dirty.malloc(ALLOC_SIZE * 4));
				}
				for(const addr of addrs) {
					dirty.free(addr);
				}
			};
		},
	});
});

describe(`MemoryBuffer: free ${ALLOC_COUNT} allocations`, () => {
	let buffer: MemoryBuffer;
	let addrs: Array<number>;

	// Oldest-first: each block sits at the tail of the used list, the worst case for a singly-linked walk.
	bench('free (allocation order)', () => {
		for(let i = 0; i < ALLOC_COUNT; i++) {
			buffer.free(addrs[i]);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				({ buffer, addrs } = fillBuffer());
			};
		},
	});

	// Newest-first: each block sits at the head of the used list.
	bench('free (reverse order)', () => {
		for(let i = ALLOC_COUNT - 1; i >= 0; i--) {
			buffer.free(addrs[i]);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				({ buffer, addrs } = fillBuffer());
			};
		},
	});

	let shuffled: Array<number>;
	bench('free (random order)', () => {
		for(let i = 0; i < ALLOC_COUNT; i++) {
			buffer.free(shuffled[i]);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				({ buffer, addrs } = fillBuffer());
				shuffled = addrs.slice();
				for(let i = shuffled.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
				}
			};
		},
	});
});

// Large blocks where zero-filling dominates the per-allocation cost, so skipping it on fresh memory is visible.
const LARGE_ALLOC_COUNT = 100;
const LARGE_ALLOC_SIZE = 16 * 1024;
describe(`MemoryBuffer: ${LARGE_ALLOC_COUNT} large callocAs`, () => {
	bench('callocAs (fresh)', () => {
		const buffer = makeBuffer();
		for(let i = 0; i < LARGE_ALLOC_COUNT; i++) {
			buffer.callocAs('u32', LARGE_ALLOC_SIZE);
		}
	});

	let dirty: MemoryBuffer;
	bench('callocAs (reused)', () => {
		for(let i = 0; i < LARGE_ALLOC_COUNT; i++) {
			dirty.callocAs('u32', LARGE_ALLOC_SIZE);
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				dirty = makeBuffer();
				const addrs: Array<number> = [];
				for(let i = 0; i < LARGE_ALLOC_COUNT; i++) {
					addrs.push(dirty.malloc(LARGE_ALLOC_SIZE * 4));
				}
				for(const addr of addrs) {
					dirty.free(addr);
				}
			};
		},
	});
});

const CHURN_COUNT = 20_000;
describe(`MemoryBuffer: ${CHURN_COUNT} alloc/free churn`, () => {
	// Steady-state churn over a live set: half the ops allocate, half free a random live block.
	bench('mixed alloc/free', () => {
		const buffer = makeBuffer();
		const live: Array<number> = [];
		for(let i = 0; i < ALLOC_COUNT; i++) {
			live.push(buffer.malloc(ALLOC_SIZE * 4));
		}
		for(let i = 0; i < CHURN_COUNT; i++) {
			if(i % 2 === 0) {
				live.push(buffer.malloc(ALLOC_SIZE * 4));
			} else {
				const at = Math.floor(Math.random() * live.length);
				buffer.free(live[at]);
				live[at] = live[live.length - 1];
				live.pop();
			}
		}
	});
});

const HEAP_COUNT = 5_000;
describe(`MemoryHeap: ${HEAP_COUNT} alloc + free`, () => {
	bench('allocUI32', () => {
		const memory = new MemoryHeap({ bufferSize: BUFFER_SIZE });
		for(let i = 0; i < HEAP_COUNT; i++) {
			memory.allocUI32(ALLOC_SIZE);
		}
	});

	let memory: MemoryHeap;
	let blocks: Array<AllocatedMemory>;
	bench('free (allocation order)', () => {
		for(let i = 0; i < HEAP_COUNT; i++) {
			blocks[i].free();
		}
	}, {
		setup: (task) => {
			task.opts.beforeEach = () => {
				memory = new MemoryHeap({ bufferSize: BUFFER_SIZE });
				blocks = [];
				for(let i = 0; i < HEAP_COUNT; i++) {
					blocks.push(memory.allocUI32(ALLOC_SIZE));
				}
			};
		},
	});
});
