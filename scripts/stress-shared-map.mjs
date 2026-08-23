// Real multi-threaded stress test for SharedMap, proving thread-safety with actual worker_threads.
// Runs against the built bundle (Vite has resolved import.meta.env there), so build first:
//
//   npm run build && node scripts/stress-shared-map.mjs
//
// Each worker owns a disjoint key range (worker N uses [N * KEY_RANGE, (N + 1) * KEY_RANGE)) and stores value === key, so
// every surviving entry must have value === key and a key that lands in exactly one worker's range - which catches torn
// writes and lost updates from concurrent set/delete/resize hammering the same shared table. Each worker also tracks its
// own live keys so it can randomly delete ones it knows exist and, at the end, verify every live key still resolves and
// every deleted key is gone.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// The library targets browser Web Workers; under Node's worker_threads `self`/`WorkerGlobalScope` are absent, so the
// allocator lock falls back to spinning. Shim it before the bundle evaluates (dynamic import runs after this line).
globalThis.self ??= globalThis;
const { default: MemoryHeap } = await import('../dist/memory-heap.js');
const { default: SharedMap } = await import('../dist/shared-map.js');

const WORKER_COUNT = 8;
const ITERATIONS = 5_000; // must stay below KEY_RANGE so ranges never overlap
const KEY_RANGE = 1_000_000;
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
	// Pre-size the heap so every table (re)allocation lands in a buffer all workers already hold - cross-thread buffer
	// growth can't be propagated safely mid-run, so give the map room to grow its table without ever calling growBuffer.
	const memory = new MemoryHeap({ initialBuffers: 8, autoGrowSize: 0 });
	const map = new SharedMap(memory);
	const shared = { buffers: memory.getSharedMemory().buffers, firstBlock: map.getSharedMemory().firstBlock };

	const results = await Promise.all(
		Array.from({ length: WORKER_COUNT }, (_value, index) => spawn({ shared, workerNumber: index + 1 })),
	);

	const totalExpected = results.reduce((sum, result) => sum + result.expectedCount, 0);
	check('map length matches total live', map.length, totalExpected);

	// Global scan: every entry must be a value === key torn-write-free pair whose key belongs to exactly one worker range
	let tornWrites = 0;
	let outOfRange = 0;
	const rangeActual = new Map();
	for(const [key, value] of map) {
		if(value !== key) {
			tornWrites++;
		}
		const workerNumber = Math.floor(key / KEY_RANGE);
		if(workerNumber < 1 || workerNumber > WORKER_COUNT) {
			outOfRange++;
		} else {
			rangeActual.set(workerNumber, (rangeActual.get(workerNumber) ?? 0) + 1);
		}
	}
	check('entries with value !== key (torn writes)', tornWrites, 0);
	check('entries whose key is out of every worker range', outOfRange, 0);

	for(const result of results) {
		check(`worker ${result.workerNumber} range count`, rangeActual.get(result.workerNumber) ?? 0, result.expectedCount);
		check(`worker ${result.workerNumber} live keys missing`, result.missing, 0);
		check(`worker ${result.workerNumber} deleted keys still present`, result.resurrected, 0);
	}

	console.log(`\nAll checks passed: ${WORKER_COUNT} threads x ${ITERATIONS} ops, ${totalExpected} live entries, no lost/duplicated/corrupted entries.`);
}

function spawn(data) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(HERE, { workerData: data });
		worker.once('message', resolve);
		worker.once('error', reject);
		worker.once('exit', code => {
			if(code !== 0) {
				reject(new Error(`worker exited ${code}`));
			}
		});
	});
}

function runWorker() {
	const { shared, workerNumber } = workerData;
	const memory = new MemoryHeap({ buffers: shared.buffers });
	const map = new SharedMap(memory, { firstBlock: shared.firstBlock });
	const keyBase = workerNumber * KEY_RANGE;

	// The keys this worker inserted and still expects to be present (value === key), plus the ones it deleted
	const liveKeys = [];
	const deletedKeys = [];
	for(let i = 0; i < ITERATIONS; i++) {
		const key = keyBase + i;
		map.set(key, key);
		liveKeys.push(key);

		// Randomly delete one of our own known-live keys to exercise delete/tombstone under contention
		if(Math.random() > 0.7 && liveKeys.length) {
			const removeAt = Math.floor(Math.random() * liveKeys.length);
			const deleteKey = liveKeys[removeAt];
			liveKeys[removeAt] = liveKeys[liveKeys.length - 1];
			liveKeys.pop();
			map.delete(deleteKey);
			deletedKeys.push(deleteKey);
		}
	}

	let missing = 0;
	for(const key of liveKeys) {
		if(map.get(key) !== key) {
			missing++;
		}
	}
	let resurrected = 0;
	for(const key of deletedKeys) {
		if(map.get(key) !== undefined) {
			resurrected++;
		}
	}

	parentPort.postMessage({ workerNumber, expectedCount: liveKeys.length, missing, resurrected });
}

function check(label, actual, expected) {
	if(actual !== expected) {
		console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
		process.exit(1);
	}
	console.log(`ok   ${label}: ${actual}`);
}
