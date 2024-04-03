import type { SharedAllocatedMemory } from './allocated-memory';
import AllocatedMemory from './allocated-memory';
import type { TypedArrayConstructor } from './interfaces/typed-array-constructor';
import type MemoryHeap from './memory-heap';
import { getPointer, loadPointer, loadRawPointer, replaceRawPointer, storePointer, storeRawPointer } from './utils/pointer';

enum TYPE {
	uint32,
	int32,
	float32
}

// TODO: We need some sort of locking on insert/deletes!
const FIRST_BLOCK_RECORD_KEEPING_COUNT = 4;
const DATA_BLOCK_RECORD_KEEPING_COUNT = 1;
const LENGTH_INDEX = 2;
export default class SharedList<T extends Uint32Array | Int32Array | Float32Array = Uint32Array> implements Iterable<SharedListIterable<T>> {
	static readonly ALLOCATE_COUNT = FIRST_BLOCK_RECORD_KEEPING_COUNT;

	private memory: MemoryHeap;
	/* First block
		32 index 0
		uint16 0 - next buffer position
		uint16 1 - next buffer index
		32 index 1
		uint16 2 - last buffer position
		uint16 3 - last buffer index
		32 index 2
		uint32 4 - length
		32 index 3
		uint16 6 - type
		uint16 7 - data length (defaults to 1 number per data)
	*/
	/* Other blocks
		32 index 0
		uint16 0 - next buffer position
		uint16 1 - next buffer index
		32 index 1 => data
	*/
	private firstBlock: AllocatedMemory;
	private uint16Array: Uint16Array;

	get length(): number {
		return Atomics.load(this.firstBlock.data, LENGTH_INDEX);
	}
	
	get type(): number {
		return Atomics.load(this.uint16Array, 0);
	}
	private set type(value: number) {
		Atomics.store(this.uint16Array, 0, value);
	}
	get dataLength(): number {
		// Can technically be initialized by passing memory without actually every being called - need to make sure dataLength is always at least one
		return Math.max(1, Atomics.load(this.uint16Array, 1));
	}
	private set dataLength(value: number) {
		Atomics.store(this.uint16Array, 1, value);
	}

	constructor(memory: MemoryHeap, config?: SharedListConfig<T> | SharedListMemory) {
		this.memory = memory;

		if(config && 'firstBlock' in config) {
			this.firstBlock = new AllocatedMemory(memory, config.firstBlock);
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + (LENGTH_INDEX + 1) * Uint32Array.BYTES_PER_ELEMENT, 2);
		} else {
			if(config && config.initWithBlock) {
				this.firstBlock = new AllocatedMemory(memory, config.initWithBlock);
			} else {
				this.firstBlock = memory.allocUI32(FIRST_BLOCK_RECORD_KEEPING_COUNT);
			}
			this.uint16Array = new Uint16Array(this.firstBlock.data.buffer, this.firstBlock.bufferByteOffset + (LENGTH_INDEX + 1) * Uint32Array.BYTES_PER_ELEMENT, 2);

			const type = config?.type ?? Uint32Array;
			if(type === Uint32Array) {
				this.type = TYPE.uint32;
			}
			// @ts-expect-error
			else if(type === Int32Array) {
				this.type = TYPE.int32;
			}
			// @ts-expect-error
			else if(type === Float32Array) {
				this.type = TYPE.float32;
			}
			this.dataLength = config?.dataLength ?? 1;
		}
	}

	insert(values: number | Array<number>) {
		if(typeof values === 'number') {
			values = [values];
		}

		let dataLength = this.dataLength;
		if(values.length > dataLength) {
			throw new Error(`Can't insert ${values.length} array into shared list of ${dataLength} dataLength`);
		}
		let newBlock = this.memory.allocUI32(DATA_BLOCK_RECORD_KEEPING_COUNT + dataLength);
		let newData = this.getDataBlock(newBlock.data);
		let newBlockPointer = newBlock.pointer;
		
		for(let i = 0; i < values.length; i++) {
			if(newData instanceof Int32Array || newData instanceof Uint32Array) {
				Atomics.store(newData, i, values[i]);
			} else {
				// TODO: Should we replace with pass thru float32 conversion -> store?
				newData[i] = values[i];
			}
		}

		let lastBlockPointer;
		let updateWorked = false;
		while(!updateWorked) {
			lastBlockPointer = loadRawPointer(this.firstBlock.data, 1);
			updateWorked = replaceRawPointer(this.firstBlock.data, 1, newBlockPointer, lastBlockPointer);
		}

		if(lastBlockPointer) {
			let { bufferPosition: lastBlockPosition, bufferByteOffset: lastBlockByteOffset } = getPointer(lastBlockPointer);
			let lastBlock = new Uint32Array(this.memory.buffers[lastBlockPosition].buf, lastBlockByteOffset, 1);
			storeRawPointer(lastBlock, 0, newBlockPointer);
		} else {
			// First item - store on first block
			storeRawPointer(this.firstBlock.data, 0, newBlockPointer);
		}
		
		// Always update new last buffer position and length
		Atomics.add(this.firstBlock.data, LENGTH_INDEX, 1);
	}

	deleteMatch(callback: (values: T, index: number) => boolean): boolean {
		for(let { data, index, deleteCurrent } of this) {
			if(callback(data, index)) {
				deleteCurrent();
				return true;
			}
		}

		return false;
	}
	deleteIndex(deleteIndex: number): boolean {
		if(deleteIndex >= this.length || deleteIndex < 0) {
			return false;
		}

		return this.deleteMatch((values, index) => index === deleteIndex);
	}
	deleteValue(deleteValues: number | Array<number>) {
		if(typeof deleteValues === 'number') {
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

	*[Symbol.iterator]() {
		let currentIndex = 0;
		let { bufferPosition: nextBlockPosition, bufferByteOffset: nextBlockByteOffset } = loadPointer(this.firstBlock.data, 0);
		let lastBlockData = this.firstBlock.data;
		let lastBlockPosition = 0;
		let lastBlockByteOffset = 0;
		while(nextBlockByteOffset) {
			let memPool = this.memory.buffers[nextBlockPosition];
			let blockRecord = new Uint32Array(memPool.buf, nextBlockByteOffset, 2);
			let blockData = this.getDataBlock(blockRecord);

			let currentBlockPosition = nextBlockPosition;
			let currentBlockByteOffset = nextBlockByteOffset;
			({ bufferPosition: nextBlockPosition, bufferByteOffset: nextBlockByteOffset } = loadPointer(blockRecord, 0));

			let updateLastBlock = true;
			yield {
				data: blockData,
				index: currentIndex,
				deleteCurrent: () => {
					// Move previous index to point to one after
					storePointer(lastBlockData, 0, nextBlockPosition, nextBlockByteOffset);

					// If this is the last item, update last block to be previous location
					if(!nextBlockByteOffset) {
						storePointer(this.firstBlock.data, 1, lastBlockPosition, lastBlockByteOffset);
					}

					memPool.free(blockRecord.byteOffset);
					Atomics.sub(this.firstBlock.data, LENGTH_INDEX, 1);
					updateLastBlock = false;
				}
			};

			if(updateLastBlock) {
				lastBlockData = blockRecord;
				lastBlockPosition = currentBlockPosition;
				lastBlockByteOffset = currentBlockByteOffset;
				currentIndex++;
			}
		}
	}

	forEach(callback: (data: T) => void) {
		for(let value of this) {
			callback(value.data);
		}
	}

	getSharedMemory(): SharedListMemory {
		return {
			firstBlock: this.firstBlock.getSharedMemory()
		};
	}

	private getDataBlock(memory: Uint32Array): T {
		const startIndex = memory.byteOffset + DATA_BLOCK_RECORD_KEEPING_COUNT * memory.BYTES_PER_ELEMENT;

		switch(this.type) {
			case TYPE.int32:
				// @ts-expect-error
				return new Int32Array(memory.buffer, startIndex, this.dataLength);
			case TYPE.uint32:
				// @ts-expect-error
				return new Uint32Array(memory.buffer, startIndex, this.dataLength);
			case TYPE.float32:
				// @ts-expect-error
				return new Float32Array(memory.buffer, startIndex, this.dataLength);
			default:
				throw new Error(`Unknown data block type ${this.type}`);
		}
	}

	free() {
		let { bufferPosition: nextBlockPosition, bufferByteOffset: nextBlockByteOffset } = loadPointer(this.firstBlock.data, 0);
		while(nextBlockByteOffset) {
			let allocatedMemory = new AllocatedMemory(this.memory, {
				bufferPosition: nextBlockPosition,
				bufferByteOffset: nextBlockByteOffset
			});

			({ bufferPosition: nextBlockPosition, bufferByteOffset: nextBlockByteOffset } = loadPointer(allocatedMemory.data, 0));
			allocatedMemory.free();
		}

		this.firstBlock.free();
	}
}

interface SharedListConfig<T extends Uint32Array | Int32Array | Float32Array> {
	initWithBlock?: SharedAllocatedMemory
	type?: TypedArrayConstructor<T>
	dataLength?: number
}
interface SharedListMemory {
	firstBlock: SharedAllocatedMemory
}

interface SharedListIterable<T extends Uint32Array | Int32Array | Float32Array> {
	data: T
	index: number
	deleteCurrent: () => void
}

export { type SharedListMemory };