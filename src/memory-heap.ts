import AllocatedMemory, { type SharedAllocatedMemory } from './allocated-memory';
import prettyBytes from 'pretty-bytes';
import { MAX_BYTE_OFFSET_LENGTH, MAX_POSITION_LENGTH } from './utils/pointer';
import MemoryBuffer from './memory-buffer';

const DEFAULT_BUFFER_SIZE = 8_192;
const BUFFER_SIZE_INDEX = 0;
const BUFFER_COUNT_INDEX = 1;
export default class MemoryHeap {
	buffers: Array<MemoryBuffer>;
	private onGrowBufferHandlers: Array<OnGrowBuffer> = [];
	isClone: boolean;
	private memory: AllocatedMemory;

	get bufferSize() {
		return this.memory.data[BUFFER_SIZE_INDEX];
	}

	constructor(config?: MemoryHeapConfig | MemoryHeapMemory) {
		if(config && 'buffers' in config) {
			this.buffers = config.buffers.map(buffer => {
				return new MemoryBuffer({
					buf: buffer,
					skipInitialization: true
				});
			});

			// TODO: This should be programic instead of hoping the first allocation is always byte 40
			this.memory = new AllocatedMemory(this, {
				bufferPosition: 0,
				bufferByteOffset: 40
			});
			this.isClone = true;
		} else {
			const bufferSize = config?.bufferSize ?? DEFAULT_BUFFER_SIZE;
			if(bufferSize > MAX_BYTE_OFFSET_LENGTH) {
				throw new Error(`Buffer size ${bufferSize} is greater than max ${MAX_BYTE_OFFSET_LENGTH} that we can reference with pointers`);
			}
			
			let startBuffer = this.createBuffer(bufferSize);
			this.buffers = [
				startBuffer
			];
			const data = startBuffer.callocAs('u32', 2);
			if(data) {
				this.memory = new AllocatedMemory(this, {
					bufferPosition: 0,
					bufferByteOffset: data.byteOffset
				});
			} else {
				throw new Error('Failed to initialize first byte from buffer');
			}
			this.memory.data[BUFFER_SIZE_INDEX] = bufferSize;
			this.memory.data[BUFFER_COUNT_INDEX] = 1;
			this.isClone = false;

			for(let i = 1; i < (config?.initialBuffers ?? 1); i++) {
				this.buffers.push(this.createBuffer(bufferSize));
			}
		}
	}

	addSharedBuffer(data: GrowBufferData) {
		this.buffers[data.bufferPosition] = new MemoryBuffer({
			buf: data.buffer,
			skipInitialization: true
		});
	}

	private createBuffer(bufferSize?: number): MemoryBuffer {
		// TODO: Look into if we should turn off splitting - I think memory is going to get fragmented really quick if we free an Entity with 100 bytes and re-allocate a new one with 80 bytes and just lose the rest
		//       As we add stuff like ListMemory that does tons of small allocations that might be fine since they can fill in any small space we have
		return new MemoryBuffer({
			buf: new SharedArrayBuffer(bufferSize ?? this.bufferSize)
		});
	}

	addOnGrowBufferHandlers(handler: OnGrowBuffer) {
		this.onGrowBufferHandlers.push(handler);
	}

	allocUI32(count: number): AllocatedMemory {
		for(let i = 0; i < this.buffers.length; i++) {
			const buffer = this.buffers[i];
			// Should just mean we haven't synced this buffer from another thread yet
			if(!buffer) {
				continue;
			}

			// Should be fine to initialize all values as 0s since unsigned/signed ints and floats all store 0 as all 0s
			const data = buffer.callocAs('u32', count);
			if(data) {
				return new AllocatedMemory(this, {
					data,
					buffer
				});
			}
		}

		if(this.buffers.length >= MAX_POSITION_LENGTH) {
			throw new Error(`Can't initialize a new buffer since it would have a position greater than the max of ${MAX_POSITION_LENGTH}`);
		}

		// If we get here we need to grow another buffer to continue allocating new memory
		const buffer = this.createBuffer();
		let nextBufferPosition = Atomics.add(this.memory.data, BUFFER_COUNT_INDEX, 1);
		// Setting index set by internal Atomic count so we can create new buffers from multiple threads and keep position consistent
		this.buffers[nextBufferPosition] = buffer;
		this.onGrowBufferHandlers.forEach(handler => handler({
			bufferPosition: nextBufferPosition,
			buffer: buffer.buf as SharedArrayBuffer
		}));

		const data = buffer.callocAs('u32', count);
		if(data) {
			return new AllocatedMemory(this, {
				data,
				buffer
			});
		} else {
			throw new Error(`Unable to allocate ${count} numbers even after adding a new buffer`);
		}
	}

	getFromSharedMemory(shared: SharedAllocatedMemory): AllocatedMemory | undefined {
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

	prettyMemory() {
		return `${myPrettyBytes(this.currentUsed)} / ${myPrettyBytes(this.totalAllocated)}`;
	}

	getSharedMemory(): MemoryHeapMemory {
		return {
			buffers: this.buffers.map(buffer => buffer.buf as SharedArrayBuffer)
		};
	}
}

function myPrettyBytes(bytes: number) {
	return prettyBytes(bytes, {
		binary: true,
		minimumFractionDigits: 1,
		maximumFractionDigits: 1
	});
}

type OnGrowBuffer = (newBuffer: GrowBufferData) => void;
interface GrowBufferData {
	bufferPosition: number
	buffer: SharedArrayBuffer
}

interface MemoryHeapConfig {
	bufferSize?: number
	initialBuffers?: number
}
interface MemoryHeapMemory {
	buffers: Array<SharedArrayBuffer>
}

export type { MemoryHeapConfig, MemoryHeapMemory, GrowBufferData };