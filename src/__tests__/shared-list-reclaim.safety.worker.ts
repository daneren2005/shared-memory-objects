import { parentPort, workerData } from 'node:worker_threads';
import MemoryHeap, { type MemoryHeapMemory } from '../memory-heap';
import SharedList, { type SharedListMemory } from '../shared-list';

interface ReclaimWorkerData {
	heap: MemoryHeapMemory
	list: SharedListMemory
	base: number
	permanentCount: number
	churnIterations: number
}

const { heap: heapMemory, list: listMemory, base, permanentCount, churnIterations } = workerData as ReclaimWorkerData;
const port = parentPort!;

const heap = new MemoryHeap(heapMemory);
const list = new SharedList(heap, listMemory);

port.on('message', (message: { run?: boolean }) => {
	if(!message.run) {
		return;
	}

	// Permanents (disjoint per worker) must survive every reclaim untouched
	for(let i = 0; i < permanentCount; i++) {
		list.insert(base + i);
	}

	// Churn drives the dead-node count up so autoReclaim fires and frees interior nodes while other workers are still
	// inserting. Each temp value is unique so deleteValue removes exactly the node we just added.
	for(let j = 0; j < churnIterations; j++) {
		let temp = base + 500_000 + j;
		list.insert(temp);
		list.deleteValue(temp);
	}

	port.postMessage({ done: true, permanentCount });
});

port.postMessage({ ready: true });
