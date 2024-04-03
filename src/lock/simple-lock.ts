const UNLOCKED = 0;
const LOCKED = 1;
export function lock(data: Int32Array, index: number = 0) {
	// Wait over and over again until we are one who set this from UNLOCKED to LOCKED
	while(Atomics.compareExchange(data, index, UNLOCKED, LOCKED) !== UNLOCKED) {
		if('WorkerGlobalScope' in self) {
			Atomics.wait(data, index, LOCKED);
		} else {
			// TODO: Spin-locks suck....
		}
	}
}
export function unlock(data: Int32Array, index: number = 0) {
	if(Atomics.compareExchange(data, index, LOCKED, UNLOCKED) !== LOCKED) {
		console.warn('We are unlocking when it was not locked!');
	}

	Atomics.notify(data, index);
}

export const SIMPLE_LOCK_ALLOCATE_COUNT = 1;