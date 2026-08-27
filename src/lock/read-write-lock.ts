const WRITE_LOCKED = -1;

function canWait(): boolean {
	return typeof self !== 'undefined' && 'WorkerGlobalScope' in self;
}

export function readLock(data: Int32Array, index: number = 0) {
	// Pending writers block new readers so a steady stream of queries cannot starve a resize.
	while(true) {
		let writers = data[index + 1];
		if(writers !== 0) {
			if(canWait()) {
				Atomics.wait(data, index + 1, writers);
			}
			continue;
		}
		let readers = data[index];
		if(readers !== WRITE_LOCKED && Atomics.compareExchange(data, index, readers, readers + 1) === readers) {
			return;
		}
		if(canWait() && readers === WRITE_LOCKED) {
			Atomics.wait(data, index, WRITE_LOCKED);
		}
	}
}
export function writeLock(data: Int32Array, index: number = 0) {
	Atomics.add(data, index + 1, 1);
	while(Atomics.compareExchange(data, index, 0, WRITE_LOCKED) !== 0) {
		let state = data[index];
		if(canWait() && state !== 0) {
			Atomics.wait(data, index, state);
		}
	}
	Atomics.sub(data, index + 1, 1);
}

export function readUnlock(data: Int32Array, index: number = 0) {
	if(Atomics.sub(data, index, 1) === 1) {
		Atomics.notify(data, index);
	}
}
export function writeUnlock(data: Int32Array, index: number = 0) {
	if(Atomics.compareExchange(data, index, WRITE_LOCKED, 0) !== WRITE_LOCKED) {
		console.warn('We are unlocking when it was not write locked!');
	}
	Atomics.notify(data, index);
	Atomics.notify(data, index + 1);
}

export const READ_WRITE_LOCK_ALLOCATE_COUNT = 2;
