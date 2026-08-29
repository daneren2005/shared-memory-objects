// Just disabling this rule instead of re-writing for now to keep asa close to original in case we want to pull updates later
// Doing `block && block.fill(fill)` instead of `if(block) { block.fill(fill); }` is valid code even if it is hard to parse
/* eslint-disable @typescript-eslint/no-unused-expressions */

import type { Pow2 } from './interfaces/pow2';
import type { TypedArray } from './interfaces/typed-array';
import { lock, unlock } from './lock/simple-lock';
import { typedArray } from './utils/typedarray';

const STATE_FREE = 0;
const STATE_USED = 1;
const STATE_TOP = 2;
const STATE_END = 3;
const STATE_ALIGN = 4;
const STATE_FLAGS = 5;
const STATE_MIN_SPLIT = 6;
// Highest top ever reached. callock can skip re-zeroing it
const STATE_HIGH_WATER = 7;

const MASK_COMPACT = 1;
const MASK_SPLIT = 2;

const SIZEOF = {
	u8: 1,
	u8c: 1,
	i8: 1,
	u16: 2,
	i16: 2,
	u32: 4,
	i32: 4,
	i64: 8,
	u64: 8,
	f32: 4,
	f64: 8,
};

const SIZEOF_STATE = 9 * 4;

const MEM_BLOCK_SIZE = 0;
const MEM_BLOCK_NEXT = 1;
// The used list is doubly linked so free() can unlink a block in O(1) instead of walking to find its predecessor.
// MEM_BLOCK_STATE marks live blocks so free() rejects a double-free (which would otherwise splice free-list pointers
// into the used list) without that walk. Word 3 also pads the header to 16 bytes, keeping data addresses aligned exactly
// as the original 8-byte header did.
const MEM_BLOCK_PREV = 2;
const MEM_BLOCK_STATE = 3;

const SIZEOF_MEM_BLOCK = 4 * 4;

const BLOCK_FREE = 0;
const BLOCK_USED = 1;

// Copied from https://github.com/thi-ng/umbrella/blob/develop/packages/malloc/src/pool.ts
// Changes: Atomic.load/store on state, simple lock on malloc/free
// Added bytesFor/lengthOf to be able to grab expected length of a block
export default class MemoryBuffer {
	buf: ArrayBufferLike;

	protected readonly start: number;
	protected u8: Uint8Array;
	protected u32: Uint32Array;
	protected state: Uint32Array;
	protected lock: Int32Array;
	// Whether the most recent malloc came from never-before-allocated (already-zeroed) memory. Per-instance/per-thread and
	// read by calloc immediately after malloc under the same call, so no locking is needed.
	private lastMallocFresh = false;

	constructor(opts: Partial<MemoryBufferConfig> = {}) {
		this.buf = opts.buf ? opts.buf : new ArrayBuffer(opts.size || 0x1000);
		this.start = opts.start != null ? align(Math.max(opts.start, 0), 4) : 0;
		this.u8 = new Uint8Array(this.buf);
		this.u32 = new Uint32Array(this.buf);
		this.state = new Uint32Array(this.buf, this.start, SIZEOF_STATE / 4);
		this.lock = new Int32Array(this.buf, this.start + this.state.byteLength - 4, 1);

		if(!opts.skipInitialization) {
			const _align = opts.align || 8;
			if(_align < 8) {
				throw new Error(`invalid alignment: ${_align}, must be a pow2 and >= 8`);
			}
			const top = this.initialTop(_align);
			const resolvedEnd =
				opts.end != null
					? Math.min(opts.end, this.buf.byteLength)
					: this.buf.byteLength;

			if(top >= resolvedEnd) {
				throw new Error(
					`insufficient address range (0x${this.start.toString(
						16,
					)} - 0x${resolvedEnd.toString(16)})`,
				);
			}

			this.align = _align;
			this.doCompact = opts.compact !== false;
			this.doSplit = opts.split !== false;
			this.minSplit = opts.minSplit || SIZEOF_MEM_BLOCK * 2;
			this.end = resolvedEnd;
			this.top = top;
			this.highWater = top;
			this._free = 0;
			this._used = 0;
		}
	}

	stats(): Readonly<MemoryBufferStats> {
		const listStats = (block: number) => {
			let count = 0;
			let size = 0;
			while(block) {
				count++;
				size += this.blockSize(block);
				block = this.blockNext(block);

				if(block > this.end) {
					console.error(`Trying to get stats for block past end of buffer: ${block} > ${this.end}`);
					break;
				}
			}
			return { count, size };
		};
		const free = listStats(this._free);
		return {
			free,
			used: listStats(this._used),
			top: this.top,
			available: this.end - this.top + free.size,
			total: this.buf.byteLength,
		};
	}

	callocAs<T extends Type>(type: T, num: number, fill = 0) {
		const block = this.mallocAs(type, num);
		// Fresh bump memory is already zero from the backing buffer; only fill for a non-zero value or reused (dirty) memory.
		block && (fill !== 0 || !this.lastMallocFresh) && block.fill(fill);
		return block;
	}

	mallocAs<T extends Type>(type: T, num: number) {
		const addr = this.malloc(num * SIZEOF[type]);
		return addr ? typedArray(type, this.buf, addr, num) : undefined;
	}

	calloc(bytes: number, fill = 0) {
		const addr = this.malloc(bytes);
		// Fresh bump memory is already zero from the backing buffer; only fill for a non-zero value or reused (dirty) memory.
		addr && (fill !== 0 || !this.lastMallocFresh) && this.u8.fill(fill, addr, addr + bytes);
		return addr;
	}

	malloc(bytes: number) {
		if(bytes <= 0) {
			return 0;
		}
		lock(this.lock);
		const paddedSize = align(bytes + SIZEOF_MEM_BLOCK, this.align);
		const end = this.end;
		// Without compaction top never retreats, so bump memory is always pristine and no high-water tracking is needed. With
		// compaction top can move back below the high-water mark, so a bump there reuses dirty memory and must be zeroed.
		const doCompact = this.doCompact;
		const highWater = doCompact ? this.highWater : 0;
		let top = this.top;
		let block = this._free;
		let prev = 0;
		while(block) {
			const blockSize = this.blockSize(block);
			const isTop = block + blockSize >= top;
			if(isTop || blockSize >= paddedSize) {
				let result = this.mallocTop(
					block,
					prev,
					blockSize,
					paddedSize,
					isTop,
				);

				// A free-list block was previously allocated (below the high-water mark), so its memory is dirty.
				this.lastMallocFresh = result !== 0 && doCompact && block >= highWater;
				if(doCompact && this.top > highWater) {
					this.highWater = this.top;
				}
				unlock(this.lock);
				return result;
			}
			prev = block;
			block = this.blockNext(block);
		}
		block = top;
		top = block + paddedSize;
		if(top <= end) {
			this.setBlockSize(block, paddedSize);
			this.pushUsed(block);
			this.top = top;
			// Bump allocation only ever advances into untouched memory, so it is fresh whenever it is at/above the mark.
			this.lastMallocFresh = !doCompact || block >= highWater;
			if(doCompact && top > highWater) {
				this.highWater = top;
			}
			let result = blockDataAddress(block);
			unlock(this.lock);

			return result;
		}
		this.lastMallocFresh = false;
		unlock(this.lock);
		return 0;
	}

	private mallocTop(
		block: number,
		prev: number,
		blockSize: number,
		paddedSize: number,
		isTop: boolean,
	) {
		if(isTop && block + paddedSize > this.end) return 0;
		if(prev) {
			this.unlinkBlock(prev, block);
		} else {
			this._free = this.blockNext(block);
		}
		this.pushUsed(block);
		if(isTop) {
			// Without splitting, shrinking would expose a new block header inside stale views of the old allocation.
			if(this.doSplit || paddedSize >= blockSize) {
				this.top = block + this.setBlockSize(block, paddedSize);
			}
		} else if(this.doSplit) {
			const excess = blockSize - paddedSize;
			excess >= this.minSplit &&
			this.splitBlock(block, paddedSize, excess);
		}
		return blockDataAddress(block);
	}

	bytesFor(ptrOrArray: number | TypedArray): number | undefined {
		let addr: number;
		if(typeof ptrOrArray !== 'number') {
			if(ptrOrArray.buffer !== this.buf) {
				return undefined;
			}
			addr = ptrOrArray.byteOffset;
		} else {
			addr = ptrOrArray;
		}

		addr = blockSelfAddress(addr);
		let block = this._used;
		while(block) {
			if(block === addr) {
				return this.blockSize(addr) - SIZEOF_MEM_BLOCK;
			}
			block = this.blockNext(block);
		}

		return undefined;
	}
	lengthOf(ptrOrArray: number | TypedArray): number | undefined {
		let bytes = this.bytesFor(ptrOrArray);
		if(bytes) {
			return bytes / this.u32.BYTES_PER_ELEMENT;
		} else {
			return undefined;
		}
	}
	allocationLengthAt(dataAddress: number): number {
		return (this.blockSize(blockSelfAddress(dataAddress)) - SIZEOF_MEM_BLOCK) / this.u32.BYTES_PER_ELEMENT;
	}

	free(ptrOrArray: number | TypedArray) {
		let addr: number;
		if(typeof ptrOrArray !== 'number') {
			if(ptrOrArray.buffer !== this.buf) {
				return false;
			}
			addr = ptrOrArray.byteOffset;
		} else {
			addr = ptrOrArray;
		}
		lock(this.lock);
		addr = blockSelfAddress(addr);
		// Reject anything not currently live (double-free or a stray pointer) without walking the used list.
		if(this.blockState(addr) !== BLOCK_USED) {
			unlock(this.lock);
			return false;
		}
		const next = this.blockNext(addr);
		const prev = this.blockPrev(addr);
		if(prev) {
			this.setBlockNext(prev, next);
		} else {
			this._used = next;
		}
		if(next) {
			this.setBlockPrev(next, prev);
		}
		this.setBlockState(addr, BLOCK_FREE);
		this.insert(addr);
		this.doCompact && this.compact();

		unlock(this.lock);
		return true;
	}

	release() {
		delete (<any> this).u8;
		delete (<any> this).u32;
		delete (<any> this).state;
		delete (<any> this).buf;
		return true;
	}

	protected get align() {
		return <Pow2> this.state[STATE_ALIGN];
	}

	protected set align(x: Pow2) {
		this.state[STATE_ALIGN] = x;
	}

	get end() {
		return this.state[STATE_END];
	}

	protected set end(x: number) {
		this.state[STATE_END] = x;
	}

	get top() {
		return Atomics.load(this.state, STATE_TOP);
	}

	protected set top(x: number) {
		Atomics.store(this.state, STATE_TOP, x);
	}

	protected get highWater() {
		return Atomics.load(this.state, STATE_HIGH_WATER);
	}

	protected set highWater(x: number) {
		Atomics.store(this.state, STATE_HIGH_WATER, x);
	}

	// No live allocations. O(1) (the head of the used list, not a walk like stats()), so it is cheap to poll each
	// frame when checking whether a spare buffer is still available.
	get isEmpty(): boolean {
		return this._used === 0;
	}

	protected get _free() {
		return Atomics.load(this.state, STATE_FREE);
	}

	protected set _free(block: number) {
		Atomics.store(this.state, STATE_FREE, block);
	}

	protected get _used() {
		return Atomics.load(this.state, STATE_USED);
	}

	protected set _used(block: number) {
		Atomics.store(this.state, STATE_USED, block);
	}

	protected get doCompact() {
		return !!(this.state[STATE_FLAGS] & MASK_COMPACT);
	}

	protected set doCompact(flag: boolean) {
		flag
			? (this.state[STATE_FLAGS] |= 1 << (MASK_COMPACT - 1))
			: (this.state[STATE_FLAGS] &= ~MASK_COMPACT);
	}

	protected get doSplit() {
		return !!(this.state[STATE_FLAGS] & MASK_SPLIT);
	}

	protected set doSplit(flag: boolean) {
		flag
			? (this.state[STATE_FLAGS] |= 1 << (MASK_SPLIT - 1))
			: (this.state[STATE_FLAGS] &= ~MASK_SPLIT);
	}

	protected get minSplit() {
		return this.state[STATE_MIN_SPLIT];
	}

	protected set minSplit(x: number) {
		if(x <= SIZEOF_MEM_BLOCK) {
			throw new Error(`illegal min split threshold: ${x}, require at least ${
				SIZEOF_MEM_BLOCK + 1
			}`);
		}
		this.state[STATE_MIN_SPLIT] = x;
	}

	protected blockSize(block: number) {
		return Atomics.load(this.u32, (block >> 2) + MEM_BLOCK_SIZE);
	}

	/**
	 * Sets & returns given block size.
	 *
	 * @param block -
	 * @param size -
	 */
	protected setBlockSize(block: number, size: number) {
		Atomics.store(this.u32, (block >> 2) + MEM_BLOCK_SIZE, size);
		return size;
	}

	protected blockNext(block: number) {
		return Atomics.load(this.u32, (block >> 2) + MEM_BLOCK_NEXT);
	}

	/**
	 * Sets block next pointer to `next`. Use zero to indicate list end.
	 *
	 * @param block -
	 */
	protected setBlockNext(block: number, next: number) {
		Atomics.store(this.u32, (block >> 2) + MEM_BLOCK_NEXT, next);
	}

	protected blockPrev(block: number) {
		return Atomics.load(this.u32, (block >> 2) + MEM_BLOCK_PREV);
	}

	protected setBlockPrev(block: number, prev: number) {
		Atomics.store(this.u32, (block >> 2) + MEM_BLOCK_PREV, prev);
	}

	protected blockState(block: number) {
		return Atomics.load(this.u32, (block >> 2) + MEM_BLOCK_STATE);
	}

	protected setBlockState(block: number, state: number) {
		Atomics.store(this.u32, (block >> 2) + MEM_BLOCK_STATE, state);
	}

	// Prepend a block onto the doubly-linked used list, keeping the back-links free() relies on for O(1) removal.
	protected pushUsed(block: number) {
		const head = this._used;
		this.setBlockNext(block, head);
		this.setBlockPrev(block, 0);
		this.setBlockState(block, BLOCK_USED);
		if(head) {
			this.setBlockPrev(head, block);
		}
		this._used = block;
	}

	/**
	 * Initializes block header with given `size` and `next` pointer. Returns `block`.
	 *
	 * @param block -
	 * @param size -
	 * @param next -
	 */
	// Only used for free-list blocks (split excess); the used list is built via pushUsed which also sets prev/state.
	protected initBlock(block: number, size: number, next: number) {
		const idx = block >>> 2;
		Atomics.store(this.u32, idx + MEM_BLOCK_SIZE, size);
		Atomics.store(this.u32, idx + MEM_BLOCK_NEXT, next);
		Atomics.store(this.u32, idx + MEM_BLOCK_STATE, BLOCK_FREE);
		return block;
	}

	protected unlinkBlock(prev: number, block: number) {
		this.setBlockNext(prev, this.blockNext(block));
	}

	protected splitBlock(block: number, blockSize: number, excess: number) {
		this.insert(
			this.initBlock(
				block + this.setBlockSize(block, blockSize),
				excess,
				0,
			),
		);
		this.doCompact && this.compact();
	}

	protected initialTop(_align = this.align) {
		return (
			align(this.start + SIZEOF_STATE + SIZEOF_MEM_BLOCK, _align) -
			SIZEOF_MEM_BLOCK
		);
	}

	/**
	 * Traverses free list and attempts to recursively merge blocks
	 * occupying consecutive memory regions. Returns true if any blocks
	 * have been merged. Only called if `compact` option is enabled.
	 */
	protected compact() {
		let block = this._free;
		let prev = 0;
		let scan = 0;
		let scanPrev: number;
		let res = false;
		while(block) {
			scanPrev = block;
			scan = this.blockNext(block);
			while(scan && scanPrev + this.blockSize(scanPrev) === scan) {
				// console.log("merge:", scan.addr, scan.size);
				scanPrev = scan;
				scan = this.blockNext(scan);
			}
			if(scanPrev !== block) {
				const newSize = scanPrev - block + this.blockSize(scanPrev);
				// console.log("merged size:", newSize);
				this.setBlockSize(block, newSize);
				const next = this.blockNext(scanPrev);
				let tmp = this.blockNext(block);
				while(tmp && tmp !== next) {
					// console.log("release:", tmp.addr);
					const tn = this.blockNext(tmp);
					this.setBlockNext(tmp, 0);
					tmp = tn;
				}
				this.setBlockNext(block, next);
				res = true;
			}
			// re-adjust top if poss
			if(block + this.blockSize(block) >= this.top) {
				this.top = block;
				prev
					? this.unlinkBlock(prev, block)
					: (this._free = this.blockNext(block));
			}
			prev = block;
			block = this.blockNext(block);
		}
		return res;
	}

	/**
	 * Inserts given block into list of free blocks, sorted by address.
	 *
	 * @param block -
	 */
	protected insert(block: number) {
		// Address ordering only exists so compact() can merge neighbours; without compaction a prepend keeps free O(1).
		if(!this.doCompact) {
			this.setBlockNext(block, this._free);
			this._free = block;
			return;
		}

		let ptr = this._free;
		let prev = 0;
		while(ptr) {
			if(block <= ptr) break;
			prev = ptr;
			ptr = this.blockNext(ptr);
		}
		if(prev) {
			this.setBlockNext(prev, block);
		} else {
			this._free = block;
		}
		this.setBlockNext(block, ptr);
	}
}

/**
 * Returns a block's data address, based on given alignment.
 *
 * @param blockAddress -
 */
function blockDataAddress(blockAddress: number) {
	return blockAddress > 0 ? blockAddress + SIZEOF_MEM_BLOCK : 0;
}

/**
 * Returns block start address for given data address and alignment.
 *
 * @param dataAddress -
 */
function blockSelfAddress(dataAddress: number) {
	return dataAddress > 0 ? dataAddress - SIZEOF_MEM_BLOCK : 0;
}

function align(addr: number, size: number) {
	size--;
	return addr + size & ~size;
}

// Bytes reserved before usable heap space (allocator state) and the per-allocation block header. Exported so callers can
// size an allocation against what a single buffer can actually hold.
// Byte offset of the first allocation's data in a freshly initialized buffer (default align). The heap's state block is
// always the first allocation, so a clone can resolve it without guessing.
const FIRST_BLOCK_DATA_BYTE_OFFSET = align(SIZEOF_STATE + SIZEOF_MEM_BLOCK, 8);

export { SIZEOF_STATE, SIZEOF_MEM_BLOCK, FIRST_BLOCK_DATA_BYTE_OFFSET };

type Type = 'u8' | 'u8c' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64';

interface MemoryBufferConfig {
	/**
	 * Backing ArrayBuffer (or SharedArrayBuffer). If not given, a new
	 * one will be created with given `size`.
	 */
	buf: ArrayBufferLike
	/**
	 * Byte size for newly created ArrayBuffers (if `buf` is not given).
	 *
	 * @defaultValue 0x1000 (4KB)
	 */
	size: number
	/**
	 * Anchor index (byte address) inside the array buffer. The MemPool
	 * stores its internal state from the given address and heap space
	 * starts at least 32 bytes later (depending on chosen `align`
	 * value). Unlike allocator state variables, `start`` cannot be
	 * saved inside the array buffer itself. If the ArrayBuffer is
	 * passed to other consumers they must use the same start value.
	 * MUST be multiple of 4.
	 *
	 * @defaultValue 0
	 */
	start: number
	/**
	 * Byte address (+1) of the end of the memory region managed by the
	 * {@link MemPool}.
	 *
	 * @defaultValue end of the backing ArrayBuffer
	 */
	end: number
	/**
	 * Number of bytes to align memory blocks to. MUST be a power of 2
	 * and >= 8. Use 16 if the pool is being used for allocating memory
	 * used in SIMD operations.
	 *
	 * @defaultValue 8
	 */
	align: Pow2
	/**
	 * Flag to configure memory block compaction. If true,
	 * adjoining free blocks (in terms of address space) will be merged
	 * to minimize fragementation.
	 *
	 * @defaultValue true
	 */
	compact: boolean
	/**
	 * Flag to configure memory block splitting. If true, and when the
	 * allocator is re-using a previously freed block larger than the
	 * requested size, the block will be split to minimize wasted/unused
	 * memory. The splitting behavior can further customized via the
	 * `minSplit` option.
	 *
	 * @defaultValue true
	 */
	split: boolean
	/**
	 * Only used if `split` behavior is enabled. Defines min number of
	 * excess bytes available in a block for memory block splitting to
	 * occur.
	 *
	 * @defaultValue 16, MUST be > 8
	 */
	minSplit: number
	/**
	 * Only needed when sharing the underlying ArrayBuffer. If true, the
	 * {@link MemPool} constructor will NOT initialize its internal state and
	 * assume the underlying ArrayBuffer has already been initialized by
	 * another {@link MemPool} instance. If this option is used, `buf` MUST be
	 * given.
	 *
	 * @defaultValue false
	 */
	skipInitialization: boolean
}
interface MemoryBufferStats {
	/**
	 * Free block stats.
	 */
	free: { count: number, size: number }
	/**
	 * Used block stats.
	 */
	used: { count: number, size: number }
	/**
	 * Current top address.
	 */
	top: number
	/**
	 * Bytes available
	 */
	available: number
	/**
	 * Total pool size.
	 */
	total: number
}