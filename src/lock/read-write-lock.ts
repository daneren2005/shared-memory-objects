const UNLOCKED = 0;
const READ_LOCKED = 1;
const WRITE_LOCKED = 2;

export function readLock(data: Int32Array, index: number = 0) {
	// Wait over and over again until we get that it was unlocked or read locked
	while(Atomics.compareExchange(data, index, UNLOCKED, READ_LOCKED) === WRITE_LOCKED) {
		Atomics.wait(data, index, WRITE_LOCKED);
	}

	Atomics.add(data, index + 1, 1);
}
export function writeLock(data: Int32Array, index: number = 0) {
	// Write lock needs to be exclusive - wait until we were in UNLOCKED to proceed
	let oldValue = Atomics.compareExchange(data, index, UNLOCKED, WRITE_LOCKED);
	while(oldValue !== UNLOCKED) {
		Atomics.wait(data, index, oldValue);
		oldValue = Atomics.compareExchange(data, index, UNLOCKED, WRITE_LOCKED);
	}
}

export function readUnlock(data: Int32Array, index: number = 0) {
	let readCount = Atomics.sub(data, index + 1, 1) - 1;

	if(readCount <= 0) {
		if(Atomics.compareExchange(data, index, READ_LOCKED, UNLOCKED) !== READ_LOCKED) {
			console.warn('We are unlocking when it was not read locked!');
		}

		Atomics.notify(data, index);
	}
}
export function writeUnlock(data: Int32Array, index: number = 0) {
	if(Atomics.compareExchange(data, index, WRITE_LOCKED, UNLOCKED) !== WRITE_LOCKED) {
		console.warn('We are unlocking when it was not write locked!');
	}

	Atomics.notify(data, index);
}

export const READ_WRITE_LOCK_ALLOCATE_COUNT = 2;