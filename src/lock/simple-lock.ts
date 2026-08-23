// Three-state futex mutex (Drepper / Lars T Hansen): 0 = unlocked, 1 = locked with no waiters, 2 = locked and contended.
// Tracking contention lets unlock skip Atomics.notify entirely on the common uncontended path (notify is expensive even
// with zero waiters), while still waking a waiter whenever one parked itself by moving the state to CONTENDED.
const UNLOCKED = 0;
const LOCKED = 1;
const CONTENDED = 2;

export function lock(data: Int32Array, index: number = 0) {
	let c = Atomics.compareExchange(data, index, UNLOCKED, LOCKED);
	if(c !== UNLOCKED) {
		// Mark the lock contended so the current holder knows to notify us on release
		if(c !== CONTENDED) {
			c = Atomics.exchange(data, index, CONTENDED);
		}
		let isWorker = typeof self !== 'undefined' && 'WorkerGlobalScope' in self;
		while(c !== UNLOCKED) {
			if(isWorker) {
				Atomics.wait(data, index, CONTENDED);
			}
			// On the main thread Atomics.wait throws, so this loop degrades to a spin re-acquire
			c = Atomics.exchange(data, index, CONTENDED);
		}
	}
}
export function unlock(data: Int32Array, index: number = 0) {
	// If the lock was contended a waiter may be parked, so publish the release and wake exactly one of them
	if(Atomics.exchange(data, index, UNLOCKED) === CONTENDED) {
		Atomics.notify(data, index, 1);
	}
}

export const SIMPLE_LOCK_ALLOCATE_COUNT = 1;
