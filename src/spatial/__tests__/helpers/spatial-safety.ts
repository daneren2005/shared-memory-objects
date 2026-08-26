import { TestWorker, bundleWorker } from '../../../__tests__/helpers/worker-threads';
import type { SpatialKind } from './spatial-safety.worker';

// Shared driver for the quadtree / grid / spatial-map safety specs - the vitest version of the runners under runners/,
// driving node worker_threads instead of browser Web Workers.
//
// Each worker owns a disjoint id range (worker N owns [N * ID_RANGE, N * ID_RANGE + insertPerWorker)) so every entity has
// exactly one writer - the standard shared-memory pattern. Workers insert their own entities and then move them around
// the world for several rounds, all concurrently, hammering the per-node/cell/bucket locks. Afterwards a full-world
// retrieve must return exactly the surviving ids, each valid and unique: a torn link or lost update would show up as a
// garbage id, a duplicate, or a count mismatch.
export const ID_RANGE = 1_000_000;
export const WORLD = { x: 0, y: 0, width: 4000, height: 4000 };

interface SpatialStructure {
	size: number
	retrieve(x: number, y: number, width: number, height: number): Array<number>
	getSharedMemory(): { firstBlock: unknown }
}
// Counts the caller asserts on in one go: in a clean run every one of them equals the number of entities inserted.
export interface SpatialSafetyResult {
	workerTotal: number
	size: number
	retrieved: number
	uniqueRetrieved: number
	inWorkerRange: number
	foundAtLastPosition: number
	stillOwned: number
}

// The shape a clean run produces, so a spec can assert the whole result in a single expect
export function expectedSpatialResult(entityCount: number): SpatialSafetyResult {
	return {
		workerTotal: entityCount,
		size: entityCount,
		retrieved: entityCount,
		uniqueRetrieved: entityCount,
		inWorkerRange: entityCount,
		foundAtLastPosition: entityCount,
		stillOwned: entityCount,
	};
}

interface SpatialSafetyConfig {
	kind: SpatialKind
	heap: { getSharedMemory(): unknown }
	structure: SpatialStructure
	workerCount: number
	insertPerWorker: number
	updateRounds: number
}

export function bundleSpatialWorker(): Promise<string> {
	return bundleWorker(new URL('./spatial-safety.worker.ts', import.meta.url));
}

export async function runSpatialSafety(workerFile: string, config: SpatialSafetyConfig): Promise<SpatialSafetyResult> {
	let { kind, heap, structure, workerCount, insertPerWorker, updateRounds } = config;

	let workers: Array<TestWorker> = [];
	for(let index = 0; index < workerCount; index++) {
		workers.push(new TestWorker(workerFile, {
			kind,
			heap: heap.getSharedMemory(),
			structure: structure.getSharedMemory(),
			idBase: (index + 1) * ID_RANGE,
			insertCount: insertPerWorker,
			updateRounds,
			world: WORLD,
		}));
	}

	// Wait until every worker has attached to the heap before any of them starts writing
	await Promise.all(workers.map(worker => worker.nextMessage<{ ready: true }>()));

	workers.forEach(worker => worker.postMessage({ run: true }));
	let results = await Promise.all(workers.map(worker => worker.nextMessage<{ expectedCount: number }>()));

	// A full-world query returns every stored id. Each must be unique and fall inside some worker's id range - anything
	// else means a corrupted bucket link or a torn item record.
	let all = structure.retrieve(WORLD.x, WORLD.y, WORLD.width, WORLD.height);
	let unique = new Set(all);
	let inWorkerRange = [...unique].filter(id => {
		let workerNumber = Math.floor(id / ID_RANGE);
		let offset = id - workerNumber * ID_RANGE;
		return workerNumber >= 1 && workerNumber <= workerCount && offset >= 0 && offset < insertPerWorker;
	}).length;

	// Every entity must still resolve at the position its owner last moved it to
	workers.forEach(worker => worker.postMessage({ check: true }));
	let checks = await Promise.all(workers.map(worker => worker.nextMessage<{ missing: Array<number>, total: number }>()));

	return {
		workerTotal: results.reduce((total, result) => total + result.expectedCount, 0),
		size: structure.size,
		retrieved: all.length,
		uniqueRetrieved: unique.size,
		inWorkerRange,
		stillOwned: checks.reduce((total, check) => total + check.total, 0),
		foundAtLastPosition: checks.reduce((total, check) => total + check.total - check.missing.length, 0),
	};
}
