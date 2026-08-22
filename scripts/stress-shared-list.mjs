// Real multi-threaded stress test for SharedList, proving lock-free thread-safety with actual worker_threads.
// Runs against the built bundle (Vite has resolved import.meta.env there), so build first:
//
//   npm run build && node scripts/stress-shared-list.mjs
//
// Phase 1: N workers each insert a disjoint range of unique values at the same time -> every value must survive once.
// Phase 2: N workers each delete their range's even values at the same time, while a reader iterates -> odds survive.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// The library targets browser Web Workers; under Node's worker_threads `self`/`WorkerGlobalScope` are absent, so the
// allocator lock falls back to spinning. Shim it before the bundle evaluates (dynamic import runs after this line).
globalThis.self ??= globalThis;
const { default: MemoryHeap } = await import('../dist/memory-heap.js');
const { default: SharedList } = await import('../dist/shared-list.js');

const WORKER_COUNT = 6;
const PER_WORKER = 4_000;
const HERE = fileURLToPath(import.meta.url);

/* eslint-disable no-console */
if(isMainThread) {
	main().catch(error => {
		console.error(error);
		process.exit(1);
	});
} else {
	runWorker();
}

async function main() {
	// One big buffer, auto-grow disabled: keeps every node in a buffer all workers already share (no cross-thread grow sync)
	const memory = new MemoryHeap({ bufferSize: 1 << 20, autoGrowSize: 0 });
	const list = new SharedList(memory);
	const shared = { buffers: memory.getSharedMemory().buffers, firstBlock: list.getSharedMemory().firstBlock };

	// Phase 1 - concurrent inserts
	await runBatch('insert', shared);
	const afterInsert = collect(list);
	const expectedInsertCount = WORKER_COUNT * PER_WORKER;
	check('phase1 length', list.length, expectedInsertCount);
	check('phase1 unique count', afterInsert.size, expectedInsertCount);
	let missing = 0;
	for(let w = 0; w < WORKER_COUNT; w++) {
		for(let i = 0; i < PER_WORKER; i++) {
			if(!afterInsert.has(w * PER_WORKER + i)) missing++;
		}
	}
	check('phase1 missing values', missing, 0);

	// Phase 2 - concurrent deletes (evens) with a concurrent reader
	await runBatch('delete', shared);
	list.compact();
	const afterDelete = collect(list);
	const expectedSurvivors = expectedInsertCount / 2;
	check('phase2 length', list.length, expectedSurvivors);
	check('phase2 unique count', afterDelete.size, expectedSurvivors);
	let wrong = 0;
	for(const value of afterDelete) {
		if(value % 2 === 0) wrong++;
	}
	check('phase2 even survivors (should be 0)', wrong, 0);

	console.log(`\nAll checks passed: ${WORKER_COUNT} threads x ${PER_WORKER} ops, no lost/duplicated/corrupted nodes.`);
}

function runBatch(mode, shared) {
	const workers = [];
	for(let workerId = 0; workerId < WORKER_COUNT; workerId++) {
		workers.push(spawn({ mode, workerId, shared }));
	}
	// One extra worker that only iterates during the batch - it must never throw on a mid-mutation chain
	workers.push(spawn({ mode: 'read', workerId: -1, shared }));
	return Promise.all(workers);
}

function spawn(data) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(HERE, { workerData: data });
		worker.once('message', () => {});
		worker.once('error', reject);
		worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
	});
}

function runWorker() {
	const { mode, workerId, shared } = workerData;
	const memory = new MemoryHeap({ buffers: shared.buffers });
	const list = new SharedList(memory, { firstBlock: shared.firstBlock });

	if(mode === 'insert') {
		const base = workerId * PER_WORKER;
		for(let i = 0; i < PER_WORKER; i++) {
			list.insert(base + i);
		}
	} else if(mode === 'delete') {
		const base = workerId * PER_WORKER;
		for(let i = 0; i < PER_WORKER; i += 2) {
			list.deleteValue(base + i);
		}
	} else {
		// reader: hammer iteration while others mutate; just make sure it never blows up
		let seen = 0;
		for(let pass = 0; pass < 50; pass++) {
			for(const item of list) {
				if(item.data[0] >= 0) {
					seen++;
				}
			}
		}
		parentPort.postMessage(seen);
	}
	parentPort.postMessage('done');
}

function collect(list) {
	const set = new Set();
	for(const item of list) {
		set.add(item.data[0]);
	}
	return set;
}

function check(label, actual, expected) {
	if(actual !== expected) {
		console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
		process.exit(1);
	}
	console.log(`ok   ${label}: ${actual}`);
}
