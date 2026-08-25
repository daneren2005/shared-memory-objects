import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import type MemoryHeap from './memory-heap';
import { loadPointer, loadRawPointer, replaceRawPointer, storeRawPointer } from './utils/pointer';
import { getArrayTypeCode, getByteMultipler, isBigIntType, isFloatType, makeArrayView, type NumericArray, type NumericArrayIO, type TypedArrayConstructor } from './utils/array-type';

// Lock-free singly-linked list. firstBlock doubles as an immortal sentinel node whose next pointer (index 0) is the head.
// insert appends with a Michael-Scott CAS enqueue; delete only tombstones a node (never unlinks/frees). Memory is
// reclaimed exclusively by the quiescent compact()/clear()/free() passes. That deferral is what makes the CAS loops
// safe without hazard pointers: a live node's address is never handed back to the allocator, so no append can ever
// observe a recycled address (ABA) while another thread is mid-traversal.
const FIRST_BLOCK_RECORD_KEEPING_COUNT = 4;
const DATA_BLOCK_RECORD_KEEPING_COUNT = 2;
const DATA_BLOCK_BYTE_OFFSET = DATA_BLOCK_RECORD_KEEPING_COUNT * Uint32Array.BYTES_PER_ELEMENT;
const HEAD_INDEX = 0;
const TAIL_INDEX = 1;
const LENGTH_INDEX = 2;
const NODE_NEXT_INDEX = 0;
const NODE_DELETED_INDEX = 1;
// A pointer packs the buffer position in its low `positionBits` bits and the byte offset in the high bits (see
// utils/pointer). The split is per-heap, so it is read from the heap and cached rather than a module constant.
export default class SharedList<T extends NumericArray = Uint32Array> implements Iterable<SharedListIterable<T>> {
	static readonly ALLOCATE_COUNT = FIRST_BLOCK_RECORD_KEEPING_COUNT;

	private memory: MemoryHeap;
	// Per-heap pointer split, cached from the heap. Hoisted into locals inside the hot loops below.
	private positionBits: number;
	private positionMask: number;
	/* First block (also the sentinel node - index 0 is its next pointer = list head)
		32 index 0
		uint16 0 - head buffer position    | sentinel.next
		uint16 1 - head buffer index
		32 index 1
		uint16 2 - tail hint buffer position
		uint16 3 - tail hint buffer index
		32 index 2
		uint32 4 - length
		32 index 3
		uint16 6 - type
		uint16 7 - data length (defaults to 1 number per data)
	*/
	/* Other blocks
		32 index 0 - next buffer pointer
		32 index 1 - deleted flag (0 = live, 1 = tombstoned)
		32 index 2 => data
	*/
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;
	// type and dataLength are written once at init and never change, so cache them instead of atomic-loading per node
	private cachedType: number;
	private cachedDataLength: number;
	// u32 units per element: 1 for 32-bit types, 2 for 64-bit (float64/int64/uint64). Node data blocks scale by this.
	private cachedByteMultipler = 1;
	// Whether the value type is a BigInt view (int64/uint64), so insert stores bigint via Atomics; cached to keep the
	// per-insert branch off an instanceof check
	private cachedIsBigInt = false;
	// Float views can't be published with Atomics, so insert falls back to a plain store for them
	private cachedIsFloat = false;
	// One full-buffer Uint32Array per buffer position, so traversal indexes shared memory directly instead of
	// allocating a fresh view (and a getPointer object) for every node it touches
	private bufferViews: Array<Uint32Array> = [];
	onDelete?: (data: T) => void;

	get length(): number {
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX);
	}

	// Own internal memory plus every allocated node still linked in the chain (tombstoned nodes included, since they stay
	// allocated until a compact()/clear() reclaims them).
	get usedMemory(): number {
		let total = this.firstBlock.usedMemory;
		let { bufferPosition, bufferByteOffset } = loadPointer(this.firstBlock.data, HEAD_INDEX, this.positionBits);
		while(bufferByteOffset) {
			let node = new AllocatedMemory(this.memory, { bufferPosition, bufferByteOffset });
			total += node.usedMemory;
			({ bufferPosition, bufferByteOffset } = loadPointer(node.data, NODE_NEXT_INDEX, this.positionBits));
		}
		return total;
	}

	get type(): number {
		return this.cachedType;
	}
	private set type(value: number) {
		Atomics.store(this.uint16Array, 0, value);
	}
	get dataLength(): number {
		return this.cachedDataLength;
	}
	private set dataLength(value: number) {
		Atomics.store(this.uint16Array, 1, value);
	}

	constructor(memory: MemoryHeap, config?: SharedListConfig<T> | SharedListMemory) {
		this.memory = memory;
		this.positionBits = memory.positionBits;
		this.positionMask = (1 << this.positionBits) - 1;

		if(config && 'firstBlock' in config) {
			// TODO: How to handle referencing memory we don't have access to yet because buffer not synced from worker?
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + (LENGTH_INDEX + 1) * Uint32Array.BYTES_PER_ELEMENT, 2);
		} else {
			if(config && config.initWithBlock) {
				this.firstBlock = new AllocatedMemory(memory, config.initWithBlock);
			} else {
				this.firstBlock = memory.allocUI32(FIRST_BLOCK_RECORD_KEEPING_COUNT);
			}
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + (LENGTH_INDEX + 1) * Uint32Array.BYTES_PER_ELEMENT, 2);

			// Empty list: the tail hint points at the sentinel (firstBlock) so insert never special-cases the first node
			storeRawPointer(this.firstBlock.data, TAIL_INDEX, this.firstBlock.pointer);

			this.type = getArrayTypeCode(config?.type ?? Uint32Array);
			this.dataLength = config?.dataLength ?? 1;
		}

		this.cachedType = Atomics.load(this.uint16Array, 0);
		// dataLength defaults to at least one even when initialized from raw memory that was never explicitly set
		this.cachedDataLength = Math.max(1, Atomics.load(this.uint16Array, 1));
		this.cachedByteMultipler = getByteMultipler(this.cachedType);
		this.cachedIsBigInt = isBigIntType(this.cachedType);
		this.cachedIsFloat = isFloatType(this.cachedType);
	}

	insert(values: T[number] | Array<T[number]>) {
		if(!Array.isArray(values)) {
			values = [values];
		}

		let dataLength = this.cachedDataLength;
		if(values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}
		let newBlock = this.memory.allocUI32(DATA_BLOCK_RECORD_KEEPING_COUNT + dataLength * this.cachedByteMultipler);
		let newData = this.getDataBlock(newBlock.data.buffer, newBlock.data.byteOffset);
		let newBlockPointer = newBlock.pointer;

		let io = newData as NumericArrayIO;
		for(let i = 0; i < values.length; i++) {
			if(this.cachedIsFloat) {
				// Float views don't support Atomics; the enqueue CAS below still provides the cross-thread publish
				io[i] = values[i];
			} else if(this.cachedIsBigInt) {
				Atomics.store(newData as BigInt64Array, i, values[i] as bigint);
			} else {
				Atomics.store(newData as Int32Array, i, values[i] as number);
			}
		}

		// Michael-Scott enqueue: link the node onto tail.next BEFORE swinging the tail hint, so a committed node is never
		// invisible to a concurrent traversal. The tail hint may lag by one node; enqueuers help advance it.
		let positionBits = this.positionBits;
		let positionMask = this.positionMask;
		// eslint-disable-next-line no-constant-condition
		while(true) {
			let tailPointer = loadRawPointer(this.firstBlock.data, TAIL_INDEX);
			let view = this.getBufferView(tailPointer & positionMask);
			// Tail node lives in a buffer this thread hasn't synced yet - retry until it appears
			if(!view) {
				continue;
			}
			let tailNextIndex = ((tailPointer >>> positionBits) >>> 2) + NODE_NEXT_INDEX;
			let nextPointer = Atomics.load(view, tailNextIndex);

			// Re-check the hint hasn't moved out from under us before acting on what we read
			if(tailPointer !== loadRawPointer(this.firstBlock.data, TAIL_INDEX)) {
				continue;
			}

			if(nextPointer === 0) {
				if(Atomics.compareExchange(view, tailNextIndex, 0, newBlockPointer) === 0) {
					// Linked. Try to swing the hint forward - failure is harmless, the next enqueuer will help.
					replaceRawPointer(this.firstBlock.data, TAIL_INDEX, newBlockPointer, tailPointer);
					break;
				}
			} else {
				// Tail hint is lagging behind a linked node - help it catch up, then retry
				replaceRawPointer(this.firstBlock.data, TAIL_INDEX, nextPointer, tailPointer);
			}
		}

		Atomics.add(this.firstBlock.data, LENGTH_INDEX, 1);
	}

	deleteMatch(callback: (values: T, index: number) => boolean): boolean {
		for(let { data, index, deleteCurrent } of this) {
			if(callback(data, index)) {
				if(deleteCurrent()) {
					return true;
				}
			}
		}

		return false;
	}
	deleteIndex(deleteIndex: number): boolean {
		if(deleteIndex >= this.length || deleteIndex < 0) {
			return false;
		}

		// Compare on index only so the payload view is never materialized for an index-based delete
		for(let item of this) {
			if(item.index === deleteIndex) {
				if(item.deleteCurrent()) {
					return true;
				}
			}
		}

		return false;
	}
	deleteValue(deleteValues: T[number] | Array<T[number]>) {
		if(!Array.isArray(deleteValues)) {
			return this.deleteMatch(values => values[0] === deleteValues);
		} else {
			return this.deleteMatch(values => {
				if(values.length !== deleteValues.length) {
					return false;
				} else {
					for(let i = 0; i < values.length; i++) {
						if(values[i] !== deleteValues[i]) {
							return false;
						}
					}

					return true;
				}
			});
		}
	}

	// Reclaims tombstoned nodes: physically unlinks and frees them. Not safe to run concurrently with insert/delete.
	compact() {
		let prevPointer = this.firstBlock.pointer;
		let prevView = this.firstBlock.data;
		let prevNextIndex = NODE_NEXT_INDEX;
		let positionBits = this.positionBits;
		let positionMask = this.positionMask;
		let nextPointer = loadRawPointer(prevView, prevNextIndex);
		while(nextPointer) {
			let position = nextPointer & positionMask;
			let memPool = this.memory.buffers[position];
			if(!memPool) {
				break;
			}
			let view = this.getBufferView(position)!;
			let byteOffset = nextPointer >>> positionBits;
			let nodeIndex = byteOffset >>> 2;
			let followingPointer = Atomics.load(view, nodeIndex + NODE_NEXT_INDEX);

			if(Atomics.load(view, nodeIndex + NODE_DELETED_INDEX)) {
				// Skip over the tombstone and free it. onDelete already fired when the node was logically deleted.
				storeRawPointer(prevView, prevNextIndex, followingPointer);
				memPool.free(byteOffset);
			} else {
				prevPointer = nextPointer;
				prevView = view;
				prevNextIndex = nodeIndex + NODE_NEXT_INDEX;
			}

			nextPointer = followingPointer;
		}

		// The last surviving node (or the sentinel when everything is gone) is the new tail
		storeRawPointer(this.firstBlock.data, TAIL_INDEX, prevPointer);
	}

	clear() {
		// Detach the whole chain, then free it. Not safe to run concurrently with insert/delete.
		let firstBlockPointer;
		let updateWorked = false;
		while(!updateWorked) {
			firstBlockPointer = loadRawPointer(this.firstBlock.data, HEAD_INDEX);
			// Already cleared
			if(!firstBlockPointer) {
				return;
			}

			updateWorked = replaceRawPointer(this.firstBlock.data, HEAD_INDEX, 0, firstBlockPointer);
		}
		// Shouldn't be possible to hit: making Typescript happy
		if(!firstBlockPointer) {
			return;
		}

		// Reset the tail hint back to the sentinel
		storeRawPointer(this.firstBlock.data, TAIL_INDEX, this.firstBlock.pointer);

		let liveItems = 0;
		let positionBits = this.positionBits;
		let positionMask = this.positionMask;
		let nextBlockPointer = firstBlockPointer;
		while(nextBlockPointer) {
			let position = nextBlockPointer & positionMask;
			let memPool = this.memory.buffers[position];
			// Short circuit iterations if we can't access memory
			if(!memPool) {
				break;
			}

			let view = this.getBufferView(position)!;
			let byteOffset = nextBlockPointer >>> positionBits;
			let nodeIndex = byteOffset >>> 2;
			nextBlockPointer = Atomics.load(view, nodeIndex + NODE_NEXT_INDEX);

			if(!Atomics.load(view, nodeIndex + NODE_DELETED_INDEX)) {
				liveItems++;
				if(this.onDelete) {
					this.onDelete(this.getDataBlock(view.buffer, byteOffset));
				}
			}

			memPool.free(byteOffset);
		}

		// Only subtract the live nodes we detached so a concurrent insert's increment stays accurate
		Atomics.sub(this.firstBlock.data, LENGTH_INDEX, liveItems);
	}

	*[Symbol.iterator]() {
		let currentIndex = 0;
		let positionBits = this.positionBits;
		let positionMask = this.positionMask;
		let nextPointer = loadRawPointer(this.firstBlock.data, HEAD_INDEX);
		while(nextPointer) {
			let position = nextPointer & positionMask;
			let view = this.getBufferView(position);
			// Short circuit iterations if we can't access memory
			if(!view) {
				return;
			}
			let byteOffset = nextPointer >>> positionBits;
			let nodeIndex = byteOffset >>> 2;
			nextPointer = Atomics.load(view, nodeIndex + NODE_NEXT_INDEX);

			// Skip tombstoned nodes - they stay linked until a quiescent compact()/clear()
			if(Atomics.load(view, nodeIndex + NODE_DELETED_INDEX)) {
				continue;
			}

			let buffer = view.buffer;
			let deletedIndex = nodeIndex + NODE_DELETED_INDEX;
			// Plain object with an eager data view: V8 keeps this monomorphic and fast. A lazy `get data()` accessor is far
			// slower to allocate than the payload view it would save, so pay for the view up front.
			yield {
				data: this.getDataBlock(buffer, byteOffset),
				index: currentIndex,
				// Logical delete: tombstone the node and drop length. Returns false if another thread beat us to it.
				deleteCurrent: (): boolean => {
					if(Atomics.compareExchange(view, deletedIndex, 0, 1) === 0) {
						Atomics.sub(this.firstBlock.data, LENGTH_INDEX, 1);
						if(this.onDelete) {
							this.onDelete(this.getDataBlock(buffer, byteOffset));
						}
						return true;
					}

					return false;
				},
			};

			currentIndex++;
		}
	}

	forEach(callback: (data: T) => void) {
		for(let value of this) {
			callback(value.data);
		}
	}

	getSharedMemory(): SharedListMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory(),
		};
	}

	private getBufferView(position: number): Uint32Array | undefined {
		let view = this.bufferViews[position];
		if(view) {
			return view;
		}

		let buffer = this.memory.buffers[position];
		if(!buffer) {
			return undefined;
		}

		view = new Uint32Array(buffer.buf);
		this.bufferViews[position] = view;
		return view;
	}

	private getDataBlock(buffer: ArrayBufferLike, nodeByteOffset: number): T {
		const startIndex = nodeByteOffset + DATA_BLOCK_BYTE_OFFSET;
		return makeArrayView(this.cachedType, buffer, startIndex, this.cachedDataLength) as T;
	}

	free() {
		let { bufferPosition: nextBlockPosition, bufferByteOffset: nextBlockByteOffset } = loadPointer(this.firstBlock.data, HEAD_INDEX, this.positionBits);
		while(nextBlockByteOffset) {
			let allocatedMemory = new AllocatedMemory(this.memory, {
				bufferPosition: nextBlockPosition,
				bufferByteOffset: nextBlockByteOffset,
			});

			({ bufferPosition: nextBlockPosition, bufferByteOffset: nextBlockByteOffset } = loadPointer(allocatedMemory.data, NODE_NEXT_INDEX, this.positionBits));

			if(this.onDelete && !Atomics.load(allocatedMemory.data, NODE_DELETED_INDEX)) {
				this.onDelete(this.getDataBlock(allocatedMemory.data.buffer, allocatedMemory.data.byteOffset));
			}

			allocatedMemory.free();
		}

		this.firstBlock.free();
	}
}

interface SharedListConfig<T extends NumericArray> {
	initWithBlock?: SharedAllocatedMemory
	type?: TypedArrayConstructor<T>
	dataLength?: number
}
interface SharedListMemory {
	firstBlock: SharedAllocatedMemory
}

interface SharedListIterable<T extends NumericArray> {
	data: T
	index: number
	deleteCurrent: () => boolean
}

export { type SharedListMemory };
