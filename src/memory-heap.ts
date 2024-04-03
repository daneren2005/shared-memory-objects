import AllocatedMemory from './allocated-memory';
import prettyBytes from 'pretty-bytes';
import { MAX_BYTE_OFFSET_LENGTH, MAX_POSITION_LENGTH } from './utils/pointer';
import MemoryBuffer from './memory-buffer';

// TODO: Once we are certain this behaves correctly we should probably up to something like 1MB - we will have a ton of entities so don't want to waste time allocating new buffers constantly
const DEFAULT_BUFFER_SIZE = 8_192;
export default class MemoryHeap {
	buffers: Array<MemoryBuffer>;
	onGrowBufferHandlers: Array<OnGrowBuffer> = [];
	isClone: boolean;
	private memory: AllocatedMemory;

	get bufferSize() {
		return this.memory.data[0];
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
			const data = startBuffer.callocAs('u32', 1);
			if(data) {
				this.memory = new AllocatedMemory(this, {
					bufferPosition: 0,
					bufferByteOffset: data.byteOffset
				});
			} else {
				throw new Error('Failed to initialize first byte from buffer');
			}
			this.memory.data[0] = bufferSize;
			this.isClone = false;

			for(let i = 1; i < (config?.initialBuffers ?? 1); i++) {
				this.buffers.push(this.createBuffer(bufferSize));
			}
		}
	}

	addSharedBuffer(buffer: SharedArrayBuffer) {
		this.buffers.push(new MemoryBuffer({
			buf: buffer,
			skipInitialization: true
		}));
	}

	private createBuffer(bufferSize?: number): MemoryBuffer {
		if(this.isClone) {
			throw new Error('Creating new buffer from worker threads not currently supported');
		}

		// TODO: Look into if we should turn off splitting - I think memory is going to get fragmented really quick if we free an Entity with 100 bytes and re-allocate a new one with 80 bytes and just lose the rest
		//       As we add stuff like ListMemory that does tons of small allocations that might be fine since they can fill in any small space we have
		return new MemoryBuffer({
			buf: new SharedArrayBuffer(bufferSize ?? this.bufferSize)
		});
	}

	allocUI32(count: number): AllocatedMemory {
		for(let i = 0; i < this.buffers.length; i++) {
			const buffer = this.buffers[i];
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
		this.buffers.push(buffer);
		this.onGrowBufferHandlers.forEach(handler => handler(buffer.buf as SharedArrayBuffer));

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

type OnGrowBuffer = (newBuffer: SharedArrayBuffer) => void;

interface MemoryHeapConfig {
	bufferSize?: number
	initialBuffers?: number
}
interface MemoryHeapMemory {
	buffers: Array<SharedArrayBuffer>
}

export type { MemoryHeapConfig, MemoryHeapMemory };