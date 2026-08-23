import SharedMap from '../../src/shared-map';
import MemoryHeap from '../../src/memory-heap';
import { log, warn } from '../logger';

let map: SharedMap<number>;
let workerNumber: number;
let keyBase = 0;

// The keys this worker inserted and still expects to be present (value === key). Kept so we can randomly delete keys we
// know exist and, at the end, verify every one still resolves.
let liveKeys: Array<number> = [];
let deletedKeys: Array<number> = [];

self.onmessage = (e) => {
	if(e.data.map) {
		let heap = new MemoryHeap(e.data.heap);
		map = new SharedMap<number>(heap, e.data.map);
		workerNumber = e.data.workerNumber;
		keyBase = workerNumber * e.data.keyRange;
	} else if(e.data.iterations) {
		for(let i = 0; i < e.data.iterations; i++) {
			let key = keyBase + i;
			map.set(key, key);
			liveKeys.push(key);

			// Randomly delete one of our own known-live keys to exercise delete/tombstone under contention
			if(Math.random() > 0.7 && liveKeys.length) {
				let removeAt = Math.floor(Math.random() * liveKeys.length);
				let deleteKey = liveKeys[removeAt];
				liveKeys[removeAt] = liveKeys[liveKeys.length - 1];
				liveKeys.pop();
				map.delete(deleteKey);
				deletedKeys.push(deleteKey);
			}
		}

		self.postMessage({
			done: true,
			workerNumber,
			expectedCount: liveKeys.length,
		});
	} else if(e.data.check) {
		let missing = 0;
		for(let key of liveKeys) {
			if(map.get(key) !== key) {
				missing++;
			}
		}

		let resurrected = 0;
		for(let key of deletedKeys) {
			// A key we deleted might have been legitimately re-inserted only if it appears in liveKeys; it never is here,
			// so any deleted key that still resolves is a bug
			if(map.get(key) !== undefined) {
				resurrected++;
			}
		}

		if(missing || resurrected) {
			warn(`worker ${workerNumber}: ${missing} live keys missing, ${resurrected} deleted keys still present`);
		} else {
			log(`worker ${workerNumber}: all ${liveKeys.length} live keys present and all ${deletedKeys.length} deleted keys absent`);
		}
	}
};
