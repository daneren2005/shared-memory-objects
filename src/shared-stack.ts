import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import type { TypedArrayConstructor } from './interfaces/typed-array-constructor';
import { lock, unlock } from './lock/simple-lock';
import type MemoryHeap from './memory-heap';
import { getPointer, storePointer } from './utils/pointer';

enum TYPE {
	uint32,
	int32,
	float32,
}

const LENGTH_INDEX = 0;
const TYPE_INDEX = 1;
const BASE_SEGMENT_LENGTH_INDEX = 2;
const MAX_SEGMENTS_INDEX = 3;
const SEGMENT_COUNT_INDEX = 4;
const GROW_LOCK_INDEX = 5;
const SEGMENT_START_INDEX = 6;

const DEFAULT_BASE_SEGMENT_LENGTH = 4;
const DEFAULT_MAX_SEGMENTS = 20;

// The LENGTH word packs an ABA version counter (high bits) with the live count (low LEN_BITS). Both push and pop bump
// the version on every successful CAS, so the CAS fails on ANY intervening op - the count can never ABA back to the
// same value with a slot at a different generation. 22 count bits cover the default max length (4,194,300); the
// remaining 10 version bits (1024) only need to outlast a single thread's load->CAS window.
const LEN_BITS = 22;
const LEN_MASK = (1 << LEN_BITS) - 1;
const MAX_COUNT = LEN_MASK - 1;
// Adding this to the packed word bumps the version (high bits) by one. Combined with +1/-1 for the count it repacks the
// whole word in a single add: the count is guarded from overflowing into the version bits, and a version overflow just
// wraps harmlessly when the value is coerced back to Uint32 on the atomic store.
const VERSION_STEP = 1 << LEN_BITS;

// Per-slot publish handshake. Each data slot has a companion sequence number: even means the slot is empty (free to
// fill) at some lap, odd means the value is published (safe to read). It only ever increases. push/pop read the slot's
// sequence and bail out (retry) unless it has the parity they need, then CAS the length; because the versioned CAS
// rejects any intervening op, the sequence read stays valid all the way through the publish store below.

export default class SharedStack<T extends Uint32Array | Int32Array | Float32Array = Uint32Array> implements Iterable<number> {
	static readonly BASE_ALLOCATE_COUNT = 7;
	static readonly DEFAULT_ALLOCATE_COUNT = this.BASE_ALLOCATE_COUNT + DEFAULT_MAX_SEGMENTS;
	private memory: MemoryHeap;

	// Length, Type, Base Segment Length, Max Segments, Segment Count, Grow Lock, Segments
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;
	private growLock: Int32Array;
	readonly maxLength: number;

	private cachedSegments: T[] = [];
	// Parallel to cachedSegments: the per-slot publish sequences for each slot of that segment. Populated together with
	// the data view in getSegment, so whenever cachedSegments[i] is set cachedSequences[i] is too.
	private cachedSequences: Int32Array[] = [];
	private cachedBaseSegmentLength = 0;

	get length(): number {
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX) & LEN_MASK;
	}
	get segmentCount(): number {
		return Atomics.load(this.firstBlock.data, SEGMENT_COUNT_INDEX);
	}
	private set segmentCount(value: number) {
		this.firstBlock.data[SEGMENT_COUNT_INDEX] = value;
	}
	
	get type(): number {
		return this.uint16Array[0];
	}
	private set type(value: number) {
		Atomics.store(this.uint16Array, 0, value);
	}

	get baseSegmentLength() {
		return this.firstBlock.data[BASE_SEGMENT_LENGTH_INDEX];
	}
	private set baseSegmentLength(value: number) {
		this.firstBlock.data[BASE_SEGMENT_LENGTH_INDEX] = value;
	}
	get maxSegments() {
		return this.firstBlock.data[MAX_SEGMENTS_INDEX];
	}
	private set maxSegments(value: number) {
		this.firstBlock.data[MAX_SEGMENTS_INDEX] = value;
	}

	get pointer() {
		return this.firstBlock.pointer;
	}

	constructor(memory: MemoryHeap, config?: SharedStackConfig<T> | SharedStackMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);
		} else {
			let maxSegments = config?.segmentCount ?? DEFAULT_MAX_SEGMENTS;

			this.firstBlock = memory.allocUI32(SharedStack.BASE_ALLOCATE_COUNT + maxSegments);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			let baseSegmentLength = config?.baseSegmentLength ?? DEFAULT_BASE_SEGMENT_LENGTH;
			// Each segment block holds the data slots followed by an equal-length region of publish sequences
			let firstSegmentBlock = memory.allocUI32(baseSegmentLength * 2);
			storePointer(this.firstBlock.data, SEGMENT_START_INDEX, firstSegmentBlock.bufferPosition, firstSegmentBlock.bufferByteOffset);
			this.baseSegmentLength = baseSegmentLength;
			this.maxSegments = maxSegments;
			this.segmentCount = 1;

			const type = config?.type ?? Uint32Array;
			if(type === Uint32Array) {
				this.type = TYPE.uint32;
			// @ts-expect-error
			} else if(type === Int32Array) {
				this.type = TYPE.int32;
			// @ts-expect-error
			} else if(type === Float32Array) {
				this.type = TYPE.float32;
			}
		}

		this.growLock = new Int32Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + GROW_LOCK_INDEX * Uint32Array.BYTES_PER_ELEMENT, 1);
		this.cachedBaseSegmentLength = this.baseSegmentLength;
		this.maxLength = this.cachedBaseSegmentLength * (2 ** this.maxSegments - 1);
		if(this.maxLength > MAX_COUNT) {
			// The length word reserves LEN_BITS for the count and the rest for the ABA version tag
			throw new Error(`SharedStack maxLength ${this.maxLength} exceeds the ${MAX_COUNT} the versioned length counter can address`);
		}
	}

	at(index: number): number {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}

		let baseSegmentLength = this.cachedBaseSegmentLength;
		let segmentIndex = 31 - Math.clz32(((index / baseSegmentLength) | 0) + 1);
		let segment = this.cachedSegments[segmentIndex] ?? this.getSegment(segmentIndex);
		return segment[index - baseSegmentLength * ((1 << segmentIndex) - 1)];
	}

	push(value: number): number {
		let data = this.firstBlock.data;
		let baseSegmentLength = this.cachedBaseSegmentLength;
		// eslint-disable-next-line no-constant-condition
		while(true) {
			// Plain (relaxed) read is enough: it only seeds the versioned CAS below, which rejects any stale value
			let packed = data[LENGTH_INDEX];
			let newIndex = packed & LEN_MASK;
			if(newIndex >= this.maxLength) {
				throw new Error(`${newIndex + 1} is out of bounds ${this.maxLength}`);
			}

			let segmentIndex = 31 - Math.clz32(((newIndex / baseSegmentLength) | 0) + 1);
			let localIndex = newIndex - baseSegmentLength * ((1 << segmentIndex) - 1);
			let segment = this.cachedSegments[segmentIndex] ?? this.getSegment(segmentIndex);
			let sequences = this.cachedSequences[segmentIndex];

			// The slot must be empty (even sequence) to fill. Odd means a popper hasn't finished emptying it yet - retry
			let sequence = Atomics.load(sequences, localIndex);
			if((sequence & 1) !== 0) {
				continue;
			}
			// Take the slot only if the whole versioned length word is unchanged. The version bump makes this fail on any
			// intervening op, so a win guarantees nothing touched the top - and our sequence read above is still valid
			if(Atomics.compareExchange(data, LENGTH_INDEX, packed, packed + VERSION_STEP + 1) !== packed) {
				continue;
			}

			segment[localIndex] = value;
			// Publish: bump to odd (full). Safe as a plain store - no other op can claim this slot until the length comes
			// back down to it, which can't happen (its popper is gated on an odd sequence) until this store lands
			Atomics.store(sequences, localIndex, sequence + 1);
			return newIndex;
		}
	}

	pop(): number | undefined {
		let data = this.firstBlock.data;
		let baseSegmentLength = this.cachedBaseSegmentLength;
		// eslint-disable-next-line no-constant-condition
		while(true) {
			// Plain (relaxed) read is enough: it only seeds the versioned CAS below, which rejects any stale value
			let packed = data[LENGTH_INDEX];
			let length = packed & LEN_MASK;
			if(length <= 0) {
				return undefined;
			}
			let oldIndex = length - 1;

			let segmentIndex = 31 - Math.clz32(((oldIndex / baseSegmentLength) | 0) + 1);
			let localIndex = oldIndex - baseSegmentLength * ((1 << segmentIndex) - 1);
			let segment = this.cachedSegments[segmentIndex] ?? this.getSegment(segmentIndex);
			let sequences = this.cachedSequences[segmentIndex];

			// The slot must be full (odd sequence) to read. Even means a pusher hasn't finished publishing it yet - retry
			let sequence = Atomics.load(sequences, localIndex);
			if((sequence & 1) === 0) {
				continue;
			}
			if(Atomics.compareExchange(data, LENGTH_INDEX, packed, packed + VERSION_STEP - 1) !== packed) {
				continue;
			}

			let value = segment[localIndex];
			// Release the slot: bump to even (empty) so a later push may reuse it
			Atomics.store(sequences, localIndex, sequence + 1);
			return value;
		}
	}

	clear() {
		// Mark every occupied slot empty (bump its odd sequence to the next even) before dropping the length, otherwise a
		// later push reusing the slot would spin forever on a stale full sequence. Not safe to call concurrently with push/pop.
		let baseSegmentLength = this.cachedBaseSegmentLength;
		let oldLength = Atomics.load(this.firstBlock.data, LENGTH_INDEX) & LEN_MASK;
		for(let i = 0; i < oldLength; i++) {
			let segmentIndex = 31 - Math.clz32(((i / baseSegmentLength) | 0) + 1);
			let sequences = this.cachedSequences[segmentIndex] ?? (this.getSegment(segmentIndex), this.cachedSequences[segmentIndex]);
			let localIndex = i - baseSegmentLength * ((1 << segmentIndex) - 1);
			let sequence = Atomics.load(sequences, localIndex);
			if((sequence & 1) !== 0) {
				Atomics.store(sequences, localIndex, sequence + 1);
			}
		}
		Atomics.store(this.firstBlock.data, LENGTH_INDEX, 0);
	}

	*[Symbol.iterator]() {
		let totalDataEntries = this.length;

		let segmentLength = this.baseSegmentLength;
		let segmentIndex = 0;
		let segment = this.getSegment(segmentIndex);
		let segmentDataIndex = 0;
		for(let i = 0; i < totalDataEntries; i++) {
			yield segment[segmentDataIndex];
			segmentDataIndex++;
			if(segmentDataIndex >= segmentLength) {
				segmentIndex++;
				segment = this.getSegment(segmentIndex);
				segmentDataIndex = 0;
				segmentLength = segmentLength * 2;
			}
		}
	}

	private getSegment(segmentIndex: number): T {
		if(this.cachedSegments[segmentIndex]) {
			return this.cachedSegments[segmentIndex];
		}

		let segmentLength = this.cachedBaseSegmentLength * 2 ** segmentIndex;
		let segmentDataBlock: AllocatedMemory | undefined;
		if(segmentIndex >= this.segmentCount) {
			// Lock when growing so another thread doesn't also setup the same segment
			lock(this.growLock);
			try {
				// Re-check under the lock: another thread may have already appended the segment while we were waiting
				if(segmentIndex >= this.segmentCount) {
					// Double length: the data slots followed by their publish sequences (calloc-zeroed = 0 = empty)
					segmentDataBlock = this.memory.allocUI32(segmentLength * 2);
					storePointer(this.firstBlock.data, SEGMENT_START_INDEX + segmentIndex, segmentDataBlock.bufferPosition, segmentDataBlock.bufferByteOffset);
					Atomics.add(this.firstBlock.data, SEGMENT_COUNT_INDEX, 1);
				}
			} finally {
				unlock(this.growLock);
			}
		}

		if(!segmentDataBlock) {
			let pointerNumber = Atomics.load(this.firstBlock.data, SEGMENT_START_INDEX + segmentIndex);
			let pointer = getPointer(pointerNumber);
			segmentDataBlock = new AllocatedMemory(this.memory, pointer);
		}

		let data: T;
		switch(this.type) {
			case TYPE.int32:
				data = new Int32Array(segmentDataBlock.data.buffer, segmentDataBlock.bufferByteOffset, segmentLength) as T;
				break;
			case TYPE.uint32:
				data = new Uint32Array(segmentDataBlock.data.buffer, segmentDataBlock.bufferByteOffset, segmentLength) as T;
				break;
			case TYPE.float32:
				data = new Float32Array(segmentDataBlock.data.buffer, segmentDataBlock.bufferByteOffset, segmentLength) as T;
				break;
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}
		// Publish sequences live in the second half of the block, always as Int32 regardless of the data type
		let sequenceByteOffset = segmentDataBlock.bufferByteOffset + segmentLength * Uint32Array.BYTES_PER_ELEMENT;
		this.cachedSequences[segmentIndex] = new Int32Array(segmentDataBlock.data.buffer, sequenceByteOffset, segmentLength);
		this.cachedSegments[segmentIndex] = data;

		return data;
	}

	free() {
		for(let i = 0; i < this.segmentCount; i++) {
			let pointerNumber = Atomics.load(this.firstBlock.data, SEGMENT_START_INDEX + i);
			let pointer = getPointer(pointerNumber);
			let rawData = new AllocatedMemory(this.memory, pointer);
			rawData.free();
		}
		this.firstBlock.free();
	}

	getSharedMemory(): SharedStackMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}
}

interface SharedStackConfig<T extends Uint32Array | Int32Array | Float32Array> {
	type?: TypedArrayConstructor<T>

	baseSegmentLength?: number
	segmentCount?: number
}
interface SharedStackMemory {
	firstBlock: SharedAllocatedMemory
}

export type { SharedStackConfig, SharedStackMemory };