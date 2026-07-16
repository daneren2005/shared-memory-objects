import prettyBytes from 'pretty-bytes';
import type MemoryHeap from '../src/memory-heap';

export default function prettyMemory(heap: MemoryHeap) {
	return `${myPrettyBytes(heap.currentUsed)} / ${myPrettyBytes(heap.totalAllocated)}`;
}

function myPrettyBytes(bytes: number) {
	return prettyBytes(bytes, {
		binary: true,
		minimumFractionDigits: 1,
		maximumFractionDigits: 1
	});
}
