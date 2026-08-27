import MemoryHeap from '../dist/memory-heap.js';
import SharedList from '../dist/shared-list.js';
import SharedMap from '../dist/shared-map.js';
import SharedPool from '../dist/shared-pool.js';
import SharedStack from '../dist/shared-stack.js';
import SharedVector from '../dist/shared-vector.js';
import SharedQuadtree from '../dist/spatial/shared-quadtree.js';
import SharedSpatialGrid from '../dist/spatial/shared-spatial-grid.js';
import SharedSpatialMap from '../dist/spatial/shared-spatial-map.js';

const bounds = (size) => ({ x: 0, y: 0, width: size, height: size });
const measure = (create) => create(new MemoryHeap()).usedMemory;

const rows = [
	['SharedList', measure(memory => new SharedList(memory))],
	['SharedVector', measure(memory => new SharedVector(memory))],
	['SharedStack', measure(memory => new SharedStack(memory))],
	['SharedPool', measure(memory => new SharedPool(memory))],
	['SharedMap', measure(memory => new SharedMap(memory))],
	['SharedQuadtree', measure(memory => new SharedQuadtree(memory, { bounds: bounds(1000) }))],
	['SharedQuadtree(6)', measure(memory => new SharedQuadtree(memory, { bounds: bounds(1000), maxLevels: 6 }))],
	['SharedSpatialGrid (20x20 cells)', measure(memory => new SharedSpatialGrid(memory, { bounds: bounds(1000) }))],
	['SharedSpatialGrid (80x80 cells)', measure(memory => new SharedSpatialGrid(memory, { bounds: bounds(4000) }))],
	['SharedSpatialMap (default)', measure(memory => new SharedSpatialMap(memory))],
	['SharedSpatialMap (2048 buckets)', measure(memory => new SharedSpatialMap(memory, { buckets: 2048 }))],
];

const headers = ['Structure', 'Used Memory'];
const values = rows.map(([name, bytes]) => [name, `${bytes} bytes`]);
const widths = headers.map((header, column) => Math.max(header.length, ...values.map(row => row[column].length)));
const formatRow = row => `| ${row.map((value, column) => value.padEnd(widths[column])).join(' | ')} |`;
const separator = `| ${widths.map(width => '-'.repeat(width)).join(' | ')} |`;

process.stdout.write(`${[formatRow(headers), separator, ...values.map(formatRow)].join('\n')}\n`);
