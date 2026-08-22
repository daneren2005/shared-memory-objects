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
const MAX_SEGMENT_LENGTH_INDEX = 4;
const SEGMENT_COUNT_INDEX = 5;
const GROW_LOCK_INDEX = 6;
const SEGMENT_START_INDEX = 7;

const DEFAULT_BASE_SEGMENT_LENGTH = 4;
// Default segment budget. With uncapped power-of-two growth these 20 segments spanned 4,194,300 slots, but that ceiling
// was never reachable: past segment 14 a segment's block outgrows a 1MB buffer and allocation throws. Capping segments at
// what a buffer holds, the honest capacity of 20 segments is getCapacity(20, base, cap) instead.
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
	static readonly BASE_ALLOCATE_COUNT = 8;
	static readonly DEFAULT_ALLOCATE_COUNT = this.BASE_ALLOCATE_COUNT + DEFAULT_MAX_SEGMENTS;

	// Largest power-of-two segment length whose block (segmentLength data slots plus an equal run of publish sequences)
	// still fits in a single buffer. Segments double until they reach this, then stay flat so a segment can always be
	// allocated in one contiguous block. maxAllocationLength is MemoryHeap.maxAllocationLength.
	static getMaxSegmentLength(maxAllocationLength: number, baseSegmentLength = DEFAULT_BASE_SEGMENT_LENGTH): number {
		let segmentLength = baseSegmentLength;
		// A segment of length L needs a block of 2L u32s, so the next double only fits while 2 * (2L) <= maxAllocationLength
		while(segmentLength * 4 <= maxAllocationLength) {
			segmentLength *= 2;
		}
		return segmentLength;
	}

	// Smallest segment count whose summed capacity covers maxLength. Segments double from baseSegmentLength but never grow
	// past maxSegmentLength, so once capped they each add a flat maxSegmentLength. Looped rather than solved in closed form
	// to avoid float rounding landing a segment short or over.
	static getMaxSegments(maxLength: number, baseSegmentLength = DEFAULT_BASE_SEGMENT_LENGTH, maxSegmentLength = Infinity): number {
		let segments = 0;
		let capacity = 0;
		let segmentLength = baseSegmentLength;
		while(capacity < maxLength) {
			capacity += segmentLength;
			segments++;
			segmentLength = Math.min(segmentLength * 2, maxSegmentLength);
		}
		return segments;
	}
	// Total capacity of the first `segments` segments under the same doubling-then-capped growth as getMaxSegments
	static getCapacity(segments: number, baseSegmentLength = DEFAULT_BASE_SEGMENT_LENGTH, maxSegmentLength = Infinity): number {
		let capacity = 0;
		let segmentLength = baseSegmentLength;
		for(let i = 0; i < segments; i++) {
			capacity += segmentLength;
			segmentLength = Math.min(segmentLength * 2, maxSegmentLength);
		}
		return capacity;
	}
	static getAllocateCount(maxLength: number, baseSegmentLength = DEFAULT_BASE_SEGMENT_LENGTH, maxSegmentLength = Infinity): number {
		return this.BASE_ALLOCATE_COUNT + this.getMaxSegments(maxLength, baseSegmentLength, maxSegmentLength);
	}
	private memory: MemoryHeap;

	// Length, Type, Base Segment Length, Max Segments, Max Segment Length, Segment Count, Grow Lock, Segments
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;
	private growLock: Int32Array;
	readonly maxLength: number;

	// False when firstBlock is a slice of another structure's memory (e.g. inlined in SharedPool); that owner frees it
	private ownsFirstBlock: boolean;

	private cachedSegments: T[] = [];
	// Parallel to cachedSegments: the per-slot publish sequences for each slot of that segment. Populated together with
	// the data view in getSegment, so whenever cachedSegments[i] is set cachedSequences[i] is too.
	private cachedSequences: Int32Array[] = [];
	private cachedBaseSegmentLength = 0;
	// Segment growth caps at cachedMaxSegmentLength. Segments 0..(cachedCapSegmentCount - 1) double geometrically and cover
	// the first cachedGeometricCapacity slots; every segment beyond that is a flat cachedMaxSegmentLength. Indexing splits
	// on cachedGeometricCapacity: below it the fast log2 mapping, above it a plain linear division into capped segments.
	private cachedMaxSegmentLength = 0;
	private cachedCapSegmentCount = 0;
	private cachedGeometricCapacity = 0;

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
	get maxSegmentLength() {
		return this.firstBlock.data[MAX_SEGMENT_LENGTH_INDEX];
	}
	private set maxSegmentLength(value: number) {
		this.firstBlock.data[MAX_SEGMENT_LENGTH_INDEX] = value;
	}

	get pointer() {
		return this.firstBlock.pointer;
	}

	// Own internal memory plus every allocated segment. The firstBlock is excluded when inlined in another structure
	// (e.g. SharedPool) since that owner already counts it as part of its own internal memory.
	get usedMemory(): number {
		let total = this.ownsFirstBlock ? this.firstBlock.usedMemory : 0;
		for(let i = 0; i < this.segmentCount; i++) {
			let pointer = getPointer(Atomics.load(this.firstBlock.data, SEGMENT_START_INDEX + i));
			total += new AllocatedMemory(this.memory, pointer).usedMemory;
		}
		return total;
	}

	constructor(memory: MemoryHeap, config?: SharedStackConfig<T> | SharedStackMemory | SharedStackMemory & SharedStackConfig<T>) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			// An AllocatedMemory instance is a caller-reserved slice (e.g. inlined in SharedPool); a plain pointer is the
			// serialized clone path. Taking the instance directly keeps us off the pointer-resolving construction branch.
			this.firstBlock = config.firstBlock instanceof AllocatedMemory ? config.firstBlock : new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);

			// Memory passed together with config means the caller reserved the firstBlock slot for us to initialize in place
			if('type' in config || 'baseSegmentLength' in config || 'maxLength' in config) {
				this.initialize(config);
				this.ownsFirstBlock = false;
			} else {
				this.ownsFirstBlock = true;
			}
		} else {
			let baseSegmentLength = config?.baseSegmentLength ?? DEFAULT_BASE_SEGMENT_LENGTH;
			let maxSegmentLength = this.resolveMaxSegmentLength(baseSegmentLength, config?.maxSegmentLength);
			let maxSegments = this.resolveMaxSegments(config?.maxLength, baseSegmentLength, maxSegmentLength);

			this.firstBlock = memory.allocUI32(SharedStack.BASE_ALLOCATE_COUNT + maxSegments);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + TYPE_INDEX * Uint32Array.BYTES_PER_ELEMENT, 2);
			this.ownsFirstBlock = true;

			this.initialize(config);
		}

		this.growLock = new Int32Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + GROW_LOCK_INDEX * Uint32Array.BYTES_PER_ELEMENT, 1);
		this.cachedBaseSegmentLength = this.baseSegmentLength;
		this.cachedMaxSegmentLength = this.maxSegmentLength;
		// Segments 0..(K-1) double geometrically up to the cap, where K = log2(cap / base) + 1
		this.cachedCapSegmentCount = 32 - Math.clz32(((this.cachedMaxSegmentLength / this.cachedBaseSegmentLength) | 0));
		this.cachedGeometricCapacity = this.cachedBaseSegmentLength * ((1 << this.cachedCapSegmentCount) - 1);
		this.maxLength = SharedStack.getCapacity(this.maxSegments, this.cachedBaseSegmentLength, this.cachedMaxSegmentLength);
		if(this.maxLength > MAX_COUNT) {
			// The length word reserves LEN_BITS for the count and the rest for the ABA version tag
			throw new Error(`SharedStack maxLength ${this.maxLength} exceeds the ${MAX_COUNT} the versioned length counter can address`);
		}
	}

	// Cap on segment length: the largest a single buffer can hold, optionally lowered to a caller-requested value (floored
	// to a power-of-two multiple of the base). Beyond this segments stop doubling and stay flat so each still fits a buffer.
	private resolveMaxSegmentLength(baseSegmentLength: number, requested?: number): number {
		let cap = SharedStack.getMaxSegmentLength(this.memory.maxAllocationLength, baseSegmentLength);
		if(requested) {
			let floored = baseSegmentLength;
			while(floored * 2 <= requested) {
				floored *= 2;
			}
			cap = Math.min(cap, floored);
		}
		return cap;
	}

	// Segments needed to cover maxLength (or the default budget when none is given), but never more than the segment-pointer
	// spine can hold in a single buffer. Once capped, segments no longer double, so a huge maxLength on a small buffer is
	// honestly bounded here instead of blowing up later when the spine (or a segment) can't be allocated.
	private resolveMaxSegments(maxLength: number | undefined, baseSegmentLength: number, maxSegmentLength: number): number {
		let needed = maxLength === undefined
			? DEFAULT_MAX_SEGMENTS
			: SharedStack.getMaxSegments(maxLength, baseSegmentLength, maxSegmentLength);
		let spineLimit = this.memory.maxAllocationLength - SharedStack.BASE_ALLOCATE_COUNT;
		return Math.min(needed, spineLimit);
	}

	private initialize(config?: SharedStackConfig<T>) {
		let baseSegmentLength = config?.baseSegmentLength ?? DEFAULT_BASE_SEGMENT_LENGTH;
		let maxSegmentLength = this.resolveMaxSegmentLength(baseSegmentLength, config?.maxSegmentLength);
		// Each segment block holds the data slots followed by an equal-length region of publish sequences
		let firstSegmentBlock = this.memory.allocUI32(baseSegmentLength * 2);
		storePointer(this.firstBlock.data, SEGMENT_START_INDEX, firstSegmentBlock.bufferPosition, firstSegmentBlock.bufferByteOffset);
		this.baseSegmentLength = baseSegmentLength;
		this.maxSegmentLength = maxSegmentLength;
		this.maxSegments = this.resolveMaxSegments(config?.maxLength, baseSegmentLength, maxSegmentLength);
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

	at(index: number): number {
		let length = this.length;
		if(index >= length || index < 0) {
			throw new Error(`${index} is out of bounds ${length}`);
		}

		let geometricCapacity = this.cachedGeometricCapacity;
		let segmentIndex: number;
		let localIndex: number;
		if(index < geometricCapacity) {
			let baseSegmentLength = this.cachedBaseSegmentLength;
			segmentIndex = 31 - Math.clz32(((index / baseSegmentLength) | 0) + 1);
			localIndex = index - baseSegmentLength * ((1 << segmentIndex) - 1);
		} else {
			let maxSegmentLength = this.cachedMaxSegmentLength;
			let offset = index - geometricCapacity;
			let extra = (offset / maxSegmentLength) | 0;
			segmentIndex = this.cachedCapSegmentCount + extra;
			localIndex = offset - extra * maxSegmentLength;
		}
		let segment = this.cachedSegments[segmentIndex] ?? this.getSegment(segmentIndex);
		return segment[localIndex];
	}

	push(value: number): number {
		let data = this.firstBlock.data;
		let geometricCapacity = this.cachedGeometricCapacity;
		// eslint-disable-next-line no-constant-condition
		while(true) {
			// Plain (relaxed) read is enough: it only seeds the versioned CAS below, which rejects any stale value
			let packed = data[LENGTH_INDEX];
			let newIndex = packed & LEN_MASK;
			if(newIndex >= this.maxLength) {
				throw new Error(`${newIndex + 1} is out of bounds ${this.maxLength}`);
			}

			let segmentIndex: number;
			let localIndex: number;
			if(newIndex < geometricCapacity) {
				let baseSegmentLength = this.cachedBaseSegmentLength;
				segmentIndex = 31 - Math.clz32(((newIndex / baseSegmentLength) | 0) + 1);
				localIndex = newIndex - baseSegmentLength * ((1 << segmentIndex) - 1);
			} else {
				let maxSegmentLength = this.cachedMaxSegmentLength;
				let offset = newIndex - geometricCapacity;
				let extra = (offset / maxSegmentLength) | 0;
				segmentIndex = this.cachedCapSegmentCount + extra;
				localIndex = offset - extra * maxSegmentLength;
			}
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
		let geometricCapacity = this.cachedGeometricCapacity;
		// eslint-disable-next-line no-constant-condition
		while(true) {
			// Plain (relaxed) read is enough: it only seeds the versioned CAS below, which rejects any stale value
			let packed = data[LENGTH_INDEX];
			let length = packed & LEN_MASK;
			if(length <= 0) {
				return undefined;
			}
			let oldIndex = length - 1;

			let segmentIndex: number;
			let localIndex: number;
			if(oldIndex < geometricCapacity) {
				let baseSegmentLength = this.cachedBaseSegmentLength;
				segmentIndex = 31 - Math.clz32(((oldIndex / baseSegmentLength) | 0) + 1);
				localIndex = oldIndex - baseSegmentLength * ((1 << segmentIndex) - 1);
			} else {
				let maxSegmentLength = this.cachedMaxSegmentLength;
				let offset = oldIndex - geometricCapacity;
				let extra = (offset / maxSegmentLength) | 0;
				segmentIndex = this.cachedCapSegmentCount + extra;
				localIndex = offset - extra * maxSegmentLength;
			}
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
		let geometricCapacity = this.cachedGeometricCapacity;
		let maxSegmentLength = this.cachedMaxSegmentLength;
		let oldLength = Atomics.load(this.firstBlock.data, LENGTH_INDEX) & LEN_MASK;
		for(let i = 0; i < oldLength; i++) {
			let segmentIndex: number;
			let localIndex: number;
			if(i < geometricCapacity) {
				segmentIndex = 31 - Math.clz32(((i / baseSegmentLength) | 0) + 1);
				localIndex = i - baseSegmentLength * ((1 << segmentIndex) - 1);
			} else {
				let offset = i - geometricCapacity;
				let extra = (offset / maxSegmentLength) | 0;
				segmentIndex = this.cachedCapSegmentCount + extra;
				localIndex = offset - extra * maxSegmentLength;
			}
			let sequences = this.cachedSequences[segmentIndex] ?? (this.getSegment(segmentIndex), this.cachedSequences[segmentIndex]);
			let sequence = Atomics.load(sequences, localIndex);
			if((sequence & 1) !== 0) {
				Atomics.store(sequences, localIndex, sequence + 1);
			}
		}
		Atomics.store(this.firstBlock.data, LENGTH_INDEX, 0);
	}

	*[Symbol.iterator]() {
		let totalDataEntries = this.length;

		let maxSegmentLength = this.cachedMaxSegmentLength;
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
				segmentLength = Math.min(segmentLength * 2, maxSegmentLength);
			}
		}
	}

	private getSegment(segmentIndex: number): T {
		if(this.cachedSegments[segmentIndex]) {
			return this.cachedSegments[segmentIndex];
		}

		// Geometric while below the cap, then flat so the block always fits a single buffer
		let segmentLength = segmentIndex < this.cachedCapSegmentCount
			? this.cachedBaseSegmentLength << segmentIndex
			: this.cachedMaxSegmentLength;
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
		if(this.ownsFirstBlock) {
			this.firstBlock.free();
		}
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
	maxLength?: number
	// Cap on how large a single segment may grow. Defaults to the largest a buffer can hold; a smaller value is floored to
	// a power-of-two multiple of baseSegmentLength. Beyond the cap segments stay flat instead of doubling.
	maxSegmentLength?: number
}
interface SharedStackMemory {
	firstBlock: SharedAllocatedMemory | AllocatedMemory
}

export type { SharedStackConfig, SharedStackMemory };