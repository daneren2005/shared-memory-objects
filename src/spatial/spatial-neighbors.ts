interface NeighborCandidate {
	id: number
	distance: number
}

interface NearestNeighbor {
	id: number | undefined
	distance: number
}

class MinPriorityQueue<T> {
	private values: Array<T> = [];
	private priorities: Array<number> = [];

	get length(): number {
		return this.values.length;
	}

	get priority(): number {
		return this.priorities[0] ?? Infinity;
	}

	push(value: T, priority: number) {
		let index = this.values.length;
		this.values.push(value);
		this.priorities.push(priority);
		while(index > 0) {
			let parent = (index - 1) >> 1;
			if(this.priorities[parent] <= priority) {
				break;
			}
			this.values[index] = this.values[parent];
			this.priorities[index] = this.priorities[parent];
			index = parent;
		}
		this.values[index] = value;
		this.priorities[index] = priority;
	}

	pop(): T | undefined {
		let root = this.values[0];
		let lastValue = this.values.pop();
		let lastPriority = this.priorities.pop();
		if(this.values.length === 0 || lastValue === undefined || lastPriority === undefined) {
			return root;
		}

		let index = 0;
		while(true) {
			let left = index * 2 + 1;
			if(left >= this.values.length) {
				break;
			}
			let right = left + 1;
			let child = right < this.values.length && this.priorities[right] < this.priorities[left] ? right : left;
			if(this.priorities[child] >= lastPriority) {
				break;
			}
			this.values[index] = this.values[child];
			this.priorities[index] = this.priorities[child];
			index = child;
		}
		this.values[index] = lastValue;
		this.priorities[index] = lastPriority;
		return root;
	}
}

function distanceSquaredToRect(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number): number {
	let dx = Math.max(minX - x, x - maxX, 0);
	let dy = Math.max(minY - y, y - maxY, 0);
	return dx * dx + dy * dy;
}

function addCandidate(candidates: Array<NeighborCandidate>, id: number, distance: number, maxResults: number) {
	let low = 0;
	let high = candidates.length;
	while(low < high) {
		let mid = (low + high) >> 1;
		let candidate = candidates[mid];
		if(candidate.distance < distance || (candidate.distance === distance && candidate.id < id)) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	if(low < maxResults) {
		candidates.splice(low, 0, { id, distance });
		if(candidates.length > maxResults) {
			candidates.pop();
		}
	}
}

function candidateLimit(candidates: Array<NeighborCandidate>, maxResults: number, maxDistanceSquared: number): number {
	return candidates.length === maxResults ? Math.min(maxDistanceSquared, candidates[candidates.length - 1].distance) : maxDistanceSquared;
}

export { MinPriorityQueue, addCandidate, candidateLimit, distanceSquaredToRect };
export type { NeighborCandidate, NearestNeighbor };
