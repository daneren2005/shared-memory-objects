import AllocatedMemory, { type AllocatedMemoryPointer, type SharedAllocatedMemory } from './allocated-memory';
import { MAX_BYTE_OFFSET_LENGTH, positionBitsForBufferSize } from './utils/pointer';
import MemoryBuffer, { SIZEOF_MEM_BLOCK, SIZEOF_STATE } from './memory-buffer';

const DEFAULT_BUFFER_SIZE = MAX_BYTE_OFFSET_LENGTH;
const MAX_BUFFER_SIZE = Math.pow(2, 31);
const BUFFER_SIZE_INDEX = 0;
const BUFFER_COUNT_INDEX = 1;
const BUFFER_AUTO_GROW_INDEX = 2;
const BUFFER_POSITION_BITS_INDEX = 3;
const HEAP_STATE_COUNT = 4;
export default class MemoryHeap {
	buffers: Array<MemoryBuffer>;
	private onGrowBufferHandlers: Array<OnGrowBuffer> = [];
	isClone: boolean;
	private memory: AllocatedMemory;

	positionBits: number;
	// Max buffer position (count) and max byte offset the split can address
	get maxBuffers() {
		return Math.pow(2, this.positionBits);
	}

	get bufferSize() {
		return this.memory.data[BUFFER_SIZE_INDEX];
	}

	// Largest u32 count a single fresh buffer can hand out in one allocation: the buffer minus the allocator state and the
	// block header. A structure that grows in segments must keep each segment within this or the allocation can never fit.
	get maxAllocationLength() {
		return Math.floor((this.bufferSize - SIZEOF_STATE - SIZEOF_MEM_BLOCK) / Uint32Array.BYTES_PER_ELEMENT);
	}

	constructor(config?: MemoryHeapConfig | MemoryHeapMemory) {
		if(config && 'buffers' in config) {
			this.buffers = config.buffers.map(buffer => {
				return new MemoryBuffer({
					buf: buffer,
					skipInitialization: true,
				});
			});

			// TODO: This should be programic instead of hoping the first allocation is always byte 40
			this.memory = new AllocatedMemory(this, {
				bufferPosition: 0,
				bufferByteOffset: 40,
			} satisfies AllocatedMemoryPointer);
			this.positionBits = this.memory.data[BUFFER_POSITION_BITS_INDEX];
			this.isClone = true;
		} else {
			if(!('SharedArrayBuffer' in globalThis)) {
				console.warn('SharedArrayBuffer is not working: falling back to ArrayBuffer');
			}

			const bufferSize = config?.bufferSize ?? DEFAULT_BUFFER_SIZE;
			if(bufferSize > MAX_BUFFER_SIZE) {
				throw new Error(`Buffer size ${bufferSize} is greater than max ${MAX_BUFFER_SIZE} that we can reference with pointers`);
			}
			this.positionBits = positionBitsForBufferSize(bufferSize);

			let startBuffer = this.createBuffer(bufferSize);
			this.buffers = [
				startBuffer,
			];
			const data = startBuffer.callocAs('u32', HEAP_STATE_COUNT);
			if(data) {
				this.memory = new AllocatedMemory(this, {
					bufferPosition: 0,
					bufferByteOffset: data.byteOffset,
				});
			} else {
				throw new Error('Failed to initialize first byte from buffer');
			}
			this.memory.data[BUFFER_SIZE_INDEX] = bufferSize;
			this.memory.data[BUFFER_COUNT_INDEX] = 1;
			this.memory.data[BUFFER_AUTO_GROW_INDEX] = config?.autoGrowSize ?? 100;
			this.memory.data[BUFFER_POSITION_BITS_INDEX] = this.positionBits;
			this.isClone = false;

			for(let i = 1; i < (config?.initialBuffers ?? 1); i++) {
				this.buffers.push(this.createBuffer(bufferSize));
			}
		}
	}

	addSharedBuffer(data: GrowBufferData) {
		this.buffers[data.bufferPosition] = new MemoryBuffer({
			buf: data.buffer,
			skipInitialization: true,
		});
	}

	private growBuffer() {
		const buffer = this.createBuffer();
		let nextBufferPosition = Atomics.add(this.memory.data, BUFFER_COUNT_INDEX, 1);
		// Setting index set by internal Atomic count so we can create new buffers from multiple threads and keep position consistent
		this.buffers[nextBufferPosition] = buffer;
		this.onGrowBufferHandlers.forEach(handler => handler({
			bufferPosition: nextBufferPosition,
			buffer: buffer.buf as SharedArrayBuffer,
		}));

		return buffer;
	}
	private createBuffer(bufferSize?: number): MemoryBuffer {
		const usedBufferSize = bufferSize ?? this.bufferSize;
		let buf: ArrayBuffer | SharedArrayBuffer;
		if('SharedArrayBuffer' in globalThis) {
			buf = new SharedArrayBuffer(usedBufferSize);
		} else {
			buf = new ArrayBuffer(usedBufferSize);
		}

		return new MemoryBuffer({
			buf,

			// We can't use this unless we can 100% guarantee that every thread will stop using memory the instant it is freed
			// ex: Allocate 16 bytes.  Thread A frees that allocation and then allocates 12 bytes and 4 bytes, but Thread B is mid-execution
			// on the old allocation can changes the internal state of the 4-byte allocation breaking everything
			// After the internal state is wrong MemoryBuffer will loose track of which blocks are where and how big they are
			compact: false,
			split: false,
		});
	}

	addOnGrowBufferHandlers(handler: OnGrowBuffer) {
		this.onGrowBufferHandlers.push(handler);
	}

	// Guarantees at least one completely-empty buffer exists and (via the grow handlers) has been fanned out to every
	// thread. Call this on the owning thread before dispatching work that allocates on another thread (a worker): that
	// allocation then lands in a buffer everyone already holds instead of forcing growBuffer on the worker, which would
	// create a buffer only the worker can see and leave every other thread unable to resolve pointers into it. Returns
	// true if it had to grow one.
	ensureSpareBuffer(): boolean {
		for(let i = 0; i < this.buffers.length; i++) {
			const buffer = this.buffers[i];
			if(buffer && buffer.isEmpty) {
				return false;
			}
		}

		this.growBuffer();
		return true;
	}

	allocUI32(count: number): AllocatedMemory {
		count = Math.ceil(count);
		for(let i = 0; i < this.buffers.length; i++) {
			const buffer = this.buffers[i];
			// Should just mean we haven't synced this buffer from another thread yet
			if(!buffer) {
				continue;
			}

			// Should be fine to initialize all values as 0s since unsigned/signed ints and floats all store 0 as all 0s
			const data = buffer.callocAs('u32', count);
			if(data) {
				// Auto grow when nearly full when we need buffer to already be sync'd between threads BEFORE we try to use it
				if(
					i === (this.buffers.length - 1)
					&& Atomics.load(this.memory.data, BUFFER_COUNT_INDEX) === this.buffers.length
					&& this.memory.data[BUFFER_AUTO_GROW_INDEX] < 100
					&& this.memory.data[BUFFER_AUTO_GROW_INDEX] > 0
				) {
					const percentFull = buffer.top / buffer.end;
					if(percentFull > (this.memory.data[BUFFER_AUTO_GROW_INDEX] / 100)) {
						this.growBuffer();
					}
				}

				return new AllocatedMemory(this, {
					data,
					buffer,
				});
			}
		}

		if(this.buffers.length >= this.maxBuffers) {
			throw new Error(`Can't initialize a new buffer since it would have a position greater than the max of ${this.maxBuffers}`);
		}

		// If we get here we need to grow another buffer to continue allocating new memory
		let buffer = this.growBuffer();
		const data = buffer.callocAs('u32', count);
		if(data) {
			return new AllocatedMemory(this, {
				data,
				buffer,
			});
		} else {
			throw new Error(`Unable to allocate ${count} numbers even after adding a new buffer`);
		}
	}

	getSharedAlloc(shared: SharedAllocatedMemory): AllocatedMemory | undefined {
		// Should just mean it hasn't synced to this thread yet
		if(this.buffers[shared.bufferPosition] === undefined) {
			return undefined;
		}

		return new AllocatedMemory(this, shared);
	}

	get currentUsed() {
		return this.totalAllocated - this.buffers.reduce((total, memPool) => total + memPool.stats().available, 0);
	}
	get totalAllocated() {
		return this.buffers[0].buf.byteLength * this.buffers.length;
	}

	getSharedMemory(): MemoryHeapMemory {
		return {
			buffers: this.buffers.map(buffer => buffer.buf as SharedArrayBuffer),
		};
	}
}

type OnGrowBuffer = (newBuffer: GrowBufferData) => void;
interface GrowBufferData {
	bufferPosition: number
	buffer: SharedArrayBuffer
}

interface MemoryHeapConfig {
	bufferSize?: number
	initialBuffers?: number
	autoGrowSize?: number
}
interface MemoryHeapMemory {
	buffers: Array<SharedArrayBuffer>
}

export type { MemoryHeapConfig, MemoryHeapMemory, GrowBufferData };
