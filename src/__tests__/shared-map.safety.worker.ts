import { parentPort, workerData } from 'node:worker_threads';
import MemoryHeap, { type MemoryHeapMemory } from '../memory-heap';
import SharedMap, { type SharedMapMemory } from '../shared-map';

interface MapWorkerData {
	heap: MemoryHeapMemory
	map: SharedMapMemory
	workerNumber: number
	keyRange: number
	iterations: number
}

const { heap: heapMemory, map: mapMemory, workerNumber, keyRange, iterations } = workerData as MapWorkerData;
const port = parentPort!;

const heap = new MemoryHeap(heapMemory);
const map = new SharedMap<number>(heap, mapMemory);
const keyBase = workerNumber * keyRange;

// The keys this worker inserted and still expects to be present (value === key). Kept so we can randomly delete keys we
// know exist and, at the end, verify every one still resolves.
const liveKeys: Array<number> = [];
const deletedKeys: Array<number> = [];

port.on('message', (message: { run?: boolean, check?: boolean }) => {
	if(message.run) {
		for(let i = 0; i < iterations; i++) {
			let key = keyBase + i;
			map.set(key, key);
			liveKeys.push(key);

			// Randomly delete one of our own known-live keys to exercise delete/tombstone under contention
			if(Math.random() > 0.7) {
				let removeAt = Math.floor(Math.random() * liveKeys.length);
				let deleteKey = liveKeys[removeAt];
				liveKeys[removeAt] = liveKeys[liveKeys.length - 1];
				liveKeys.pop();
				map.delete(deleteKey);
				deletedKeys.push(deleteKey);
			}
		}

		port.postMessage({ done: true, workerNumber, expectedCount: liveKeys.length });
	} else if(message.check) {
		let missing = liveKeys.filter(key => map.get(key) !== key).length;
		// This worker never re-inserts a key it deleted, so any deleted key that still resolves is a bug
		let resurrected = deletedKeys.filter(key => map.get(key) !== undefined).length;

		port.postMessage({ checked: true, workerNumber, missing, resurrected });
	}
});

port.postMessage({ ready: true });
