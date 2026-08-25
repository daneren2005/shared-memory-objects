# Shared Memory Objects
A library to try to make making a multi-threaded game in Javascript possible.  This package is to provide a wrapper to create objects and data structures that are backed by a SharedArrayBuffer and can be shared between multiple threads.  The end result is a package that has all of the slowness of Javascript with all of the baggage of dealing with manual memory allocations.  If you need to multi-thread you are probably better of just using a different language and compiling to WebAssembly.  But if you, like me, just want to use Javascript/Typescript and are willing to deal with dealing with manual memory allocations then this library could save you some time.

A demo can be found at https://daneren2005.github.io/ecs-sharedarraybuffer-playground/#/shared-memory-objects  
The code is at https://github.com/daneren2005/ecs-sharedarraybuffer-playground/tree/dev/src/shared-memory-objects
This project is used as a base for an ECS framework at github.com/daneren2005/shared-memory-ecs

## Basics
The core of this package is the MemoryHeap.  You should usually just have a single heap that is shared between all of your different threads.  Each heap can have multiple MemoryBuffers.  By default each buffer is only 8KB but it can be configured up to 1MB, and you can have up to 4k buffers for a total of 4GB.  When you allocate memory, if there is not enough space it will allocate another buffers automatically.  When allocating memory, you will get a AllocatedMemory object that is a wrapper around the allocated memory by calling `heap.allocUI32({count of 32 bit numbers})`.  By default AllocatedMemory is backed by a Uint32Array but you can get any type of array from `AllocatedMemory.getArray(Int32Array);`.

Each allocated memory location can be stored as an int pointer.  You can use `getPointer(int)` to get the bufferPosition (ie: buffer index in the heap) and bufferByteOffset that the memory location points to.  You can also convert a bufferPosition/bufferByteOffset pair to an int pointer with `createPointer(bufferPosition, bufferByteOffset)`.  The pointer format is uses 12 bits for the buffer index and the remaining 20 bits for the byte offset in that buffer for a total of 1MB per buffer and 4GB total of memory.  Each allocated memory object can return either a pointer via `allocatedMemory.pointer` or the raw position/byte offset via `allocatedMemory.getSharedMemory()`.

When passing memory to another thread you can either pass a pointer or a serialized version of the buffer position/byte offset in order to re-create the object in the other thread.

## Getting Started
`npm install @daneren2005/shared-memory-objects`

Example to update blocks of memory from a thread.
```
let heap = new MemoryHeap();
let memory = heap.allocUI32(4);

// Pass memory to another thread
thread.postMessage({
	heap: heap.getSharedMemory(),
	memory: memory.getSharedMemory()
});

// From worker thread re-construct memory and change it
self.onmessage = (e) => {
	let heap = new MemoryHeap(e.data.heap);
	let memory = new AllocatedMemory(heap, e.data.memory);
	memory.data[2] = 5;
};
```

// Example to work with data structures from a thread.  When constructing a new structure you just pass the heap.  When re-creating a structure from an already initialized memory location pass the heap and the shared memory location for it.
```
let heap = new MemoryHeap();
let list = new SharedList(heap);

// Pass memory to another thread
thread.postMessage({
	heap: heap.getSharedMemory(),
	list: list.getSharedMemory()
});

// From worker thread re-construct memory and change it
self.onmessage = (e) => {
	let heap = new MemoryHeap(e.data.heap);
	let list = new SharedList(heap, e.data.list);

	list.push(5);
};
```
let mainList = new SharedList(memory);
let secondList = new SharedList(memory, mainList.getSharedMemory());

## Data Structures
- SharedList - linked list
- SharedVector - growable array
- SharedMap - growable hash map
- LocalPool - stable indexed data with a recycled pool that can only be pushed/deleted from main thread but can pass TypedArrays to other threads to operate on
- SharedPool - stable indexed data with a recycled pool and maximum internal array sizes
- SharedStack - push/pop with exponentially growing internal segments.
- SharedString
- ConstantString - an immutable SharedString: the value is written once and never changes, so it drops the lock word and all of SharedString's read/write locking
- SharedQuadtree - a fixed-depth region quadtree for live, concurrent spatial updates.  The tree shape is allocated once and never subdivides at runtime, so different cells never contend and entities can be inserted/moved/removed from any thread.  Each entity lives in the single deepest cell that fully contains it; `retrieve(x, y, width, height)` returns a broad-phase superset of candidate ids (same guarantee as quadtree-ts).  Configure with `{ bounds: { x, y, width, height }, maxLevels, maxEntities, type }`, where `type` is `Float32Array` (default) or `Float64Array` for the stored coordinate precision.
- SharedSpatialGrid - a uniform fixed grid for live, concurrent spatial updates, the flat-grid counterpart to `SharedQuadtree`.  The `cols x rows` array of cells is allocated once and never reshaped, so different cells never contend and entities can be inserted/moved/removed from any thread.  Unlike the quadtree, an entity is linked into *every* cell its rect overlaps, so a large or edge-straddling entity spans several cells; `retrieve(x, y, width, height)` still returns each candidate id at most once (a per-slot anchor cell dedups without any shared state, so concurrent queries stay safe).  Locating a cell is O(1) arithmetic instead of a tree descent, which tends to beat the quadtree for evenly distributed, similarly-sized entities.  Configure with `{ bounds: { x, y, width, height }, gridSize, maxEntities, maxSlots, type }`, where `gridSize` defaults to `50` and `type` is `Float32Array` (default) or `Float64Array` for the stored coordinate precision.
- SharedSpatialMap - an unbounded spatial hash for live, concurrent spatial updates, the boundless counterpart to `SharedSpatialGrid`.  It indexes the same way (an entity is linked into *every* virtual cell of side `gridSize` its rect overlaps) but drops the fixed `cols x rows` extent, so the world can be any size and cells may sit at any coordinate, positive or negative - there are no `bounds`.  A cell is hashed into a fixed array of `buckets` (a lock-striped separate-chaining hash table) that is allocated once and never resized, so different buckets never contend and only cells that collide onto one bucket serialize; `buckets` trades memory for that contention.  `retrieve(x, y, width, height)` still returns each candidate id at most once (the same per-slot anchor-cell dedup).  Configure with `{ gridSize, buckets, maxEntities, maxSlots, type }`, where `gridSize` defaults to `50`, `buckets` defaults to `8192`, and `type` is `Float32Array` (default) or `Float64Array` for the stored coordinate precision.  A power-of-two `buckets` (like the default) is hashed with a bitmask instead of an integer modulo, so it locates a bucket faster; any other value still works but falls back to the modulo.

## Memory Usage
`SharedList`, `SharedVector`, `SharedPool`, and `SharedStack` each expose a `usedMemory` getter that returns the number of bytes the structure occupies in the heap, including every pointer resource it owns.  For example, `SharedStack.usedMemory` is its own internal memory plus the combined memory of each already allocated segment, and `SharedPool.usedMemory` includes each chunk buffer and the segments of its two internal stacks (but not those stacks' internal memory, since that is inlined into the pool's own internal memory).  The number is the aligned data size of each allocation and excludes the allocator's per-block header.  SharedStack and SharedPool get a lot of their close to native performance by allocating more memory than maybe needed and locking in max length up front.  This works well when used for a few high-performance structures, but if you are giving each entity in an ECS framework multiple SharedPools that memory is going to add up quickly.  Both SharedPool and SharedStack initial memory can be tweaked by lowering the maxLength param.

Freshly allocated with the default options:

| Structure         | Used Memory |
| -------------     | ----------- |
| SharedList        | 16 bytes    |
| SharedVector      | 32 bytes    |
| SharedStack       | 144 bytes   |
| SharedPool        | 656 bytes   |
| SharedMap         | 216 bytes   |
| SharedQuadtree    | 6064 bytes  |
| SharedQuadtree(6) | 47024 bytes |
| SharedSpatialGrid (20x20 cells) | 7216 bytes  |
| SharedSpatialGrid (80x80 cells) | 55216 bytes |
| SharedSpatialMap (2048 buckets) | 21160 bytes |
| SharedSpatialMap (8192 buckets) | 70312 bytes |

`SharedQuadtree`'s footprint is dominated by its fixed node array, which is allocated once up front and never grows.  The default `maxLevels` of 4 is a complete tree of 341 nodes (`(4^(maxLevels+1) - 1) / 3`), so the number scales with `maxLevels`: a deeper tree resolves smaller entities but costs `~2 u32` per node.  The rest is its internal `SharedPool` of entity records and the `SharedMap` that indexes entities by id, whose header blocks are inlined into the tree's own allocation (the same way `SharedPool` inlines its two stacks) so the whole spine is one contiguous block instead of three separate pointer resources.  The record (id, `x/y/w/h`, node, bucket link) is stored at the configured precision, defaulting to `Float32` to match a physics engine that keeps positions in `Float32`.  `Float32` stays exact as long as entity ids and the entity count both stay under 2^24 (~16.7M); pass `type: Float64Array` if you need ids or a capacity beyond that (constructing a `Float32` tree with `maxEntities` over 2^24 throws), at the cost of more memory per entity.

`SharedSpatialGrid`'s footprint is likewise dominated by its fixed cell array (`cols x rows` cells at `~2 u32` each), so it scales with cell count rather than `maxLevels`: `cols = ceil(width / gridSize)` and `rows = ceil(height / gridSize)`, so a smaller `gridSize` resolves finer at the cost of more cells (the 20x20 grid above is a 1000x1000 world at `gridSize` 50; the 80x80 grid is a 4000x4000 world at `gridSize` 50).  The rest is two inlined `SharedPool`s - one of entity records (the occupied cell rectangle, keyed by an inlined `SharedMap` of id -> index) and one of per-cell "slot" records (`id`, anchor cell, bucket link) - since a multi-cell entity needs one slot per cell it overlaps.  `maxSlots` therefore defaults to `maxEntities * 4` to leave headroom for spanning entities.  Coordinate precision follows the same `Float32`-default rule as the quadtree (ids, both pools' indices, and cell indices must stay under 2^24 for `Float32`; pass `type: Float64Array` otherwise).

`SharedSpatialMap`'s footprint is dominated by its fixed bucket array (`buckets` at `~2 u32` each) rather than a cell array, so it scales with `buckets` instead of world size - the whole point is that the world has no fixed extent.  More buckets means shorter hash chains (less contention and faster queries) at the cost of more memory; the default of `8192` is the bulk of the 70312 bytes above.  The rest is the same two inlined `SharedPool`s as the grid - one of entity records (the occupied cell rectangle, keyed by an inlined `SharedMap` of id -> index) and one of per-cell "slot" records - except each slot also stores its own `(col, row)` (a bucket mixes slots from every cell that hashes to it, so a walk must filter to the cell it is looking at).  `maxSlots` again defaults to `maxEntities * 4`, and coordinate precision follows the same `Float32`-default rule (ids and both pools' indices under 2^24, and cell `(col, row)` within `±2^24`, for `Float32`; pass `type: Float64Array` otherwise).

## Thread Safety
- Memory allocations is thread safe as long as it does not need to create a new buffer.  Right now that can only be done from the main thread.  I just make sure there is always an extra empty buffer with SharedHeap.ensureSpareBuffer() before sending more work to worker threads.
- SharedList, SharedPool, SharedStack, and SharedMap are thread safe
- SharedVector is *not* thread safe and probably never will be - it is useful for updating in main thread and then sending off to works for processing
- SharedString is thread safe with a lock on read/write with a cached version of the string so it doesn't need to lock after the first read unless the string has changed.
- ConstantString is safe to read from any thread without a lock precisely because it is never written after construction
- SharedQuadtree is thread safe.  Its node structure never changes shape, so concurrency reduces to per-cell content updates guarded by a per-node lock
- SharedSpatialGrid is thread safe.  Its cell array never changes shape, so concurrency reduces to per-cell content updates guarded by a per-cell lock; a query racing an in-flight move sees the entity in its old or new cells (or briefly both), never neither
- SharedSpatialMap is thread safe.  Its bucket array never changes shape (it is sized up front and never rehashed), so concurrency reduces to per-bucket content updates guarded by a per-bucket lock; like the grid, a query racing an in-flight move sees the entity in its old or new cells (or briefly both), never neither


## Performance
The tl;dr is that none of these data structures are close to what you can get by just using native data structures, but I wasn't expecting them to be with their overhead.
They are all significantly slower at iterating and accessing an indexed location.  The SharedList is slowest at everything.
The SharedPool/LocalPool is the closest to native performance when doing a bunch of random deletes and inserts, which is what I use it for as the memory storage for components in my own ECS framework.
Since indexed access is about 1/4 the speed of just using a native JS array, there needs to be a lot of work offloaded into a separate thread to make it worth it.

Shared Data Structures: 10000 iterations
```
name                                     hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared list                          755.39  0.7416  2.0011  1.3238  1.5941  1.9200  1.9620  2.0011  ±2.47%      378
shared vector                      1,735.74  0.3005  2.0113  0.5761  0.6570  0.9432  1.0866  2.0113  ±1.75%      869
shared vector:getCurrentArray()   29,243.46  0.0316  0.2897  0.0342  0.0339  0.0463  0.0516  0.0921  ±0.22%    14622
local pool                         1,590.94  0.3345  1.1394  0.6286  0.7300  0.9928  1.0538  1.1394  ±1.73%      796
shared pool                        1,529.85  0.3597  1.2081  0.6537  0.7537  1.0264  1.0463  1.2081  ±1.66%      765
native array                     212,637.57  0.0022  0.3723  0.0047  0.0056  0.0084  0.0090  0.0218  ±0.36%   106319

native array
7.27x faster than shared vector:getCurrentArray()
122.51x faster than shared vector
133.65x faster than local pool
138.99x faster than shared pool
281.50x faster than shared list
```

Shared Data Structures: 1000 indexed locations
```
name                  hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared vector  20,541.58  0.0276  0.3767  0.0487  0.0567  0.0723  0.0787  0.2623  ±0.61%    10271
local pool     56,652.29  0.0100  0.3999  0.0177  0.0196  0.0284  0.0366  0.2630  ±0.73%    28327
shared pool    22,493.94  0.0257  0.4569  0.0445  0.0531  0.0680  0.0752  0.2056  ±0.63%    11248
native array   78,307.78  0.0076  0.3687  0.0128  0.0145  0.0196  0.0277  0.1941  ±0.66%    39154

native array
1.38x faster than local pool
3.48x faster than shared pool
3.81x faster than shared vector
```

Shared Data Structures: 1000 inserts
```
name                                                  hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared list                                     1,272.17  0.4398  1.3941  0.7861  0.9512  1.1298  1.1923  1.3941  ±1.72%      637
shared vector                                   9,683.24  0.0540  0.6074  0.1033  0.1197  0.1526  0.1682  0.4297  ±0.82%     4842
shared vector with correct amount initialized  14,788.92  0.0375  0.4177  0.0676  0.0821  0.1074  0.1267  0.3625  ±0.77%     7395
shared stack                                   11,462.41  0.0455  0.6411  0.0872  0.1002  0.1331  0.2250  0.3797  ±0.84%     5732
local pool                                     29,158.47  0.0177  0.4517  0.0343  0.0395  0.0555  0.0632  0.2701  ±0.65%    14580
shared pool                                    12,844.76  0.0429  0.4365  0.0779  0.0957  0.1330  0.1678  0.3488  ±0.82%     6423
shared pool with already deleted elements      13,185.21  0.0429  0.4298  0.0758  0.0876  0.1115  0.1737  0.3632  ±0.78%     6593
native array                                   63,492.15  0.0090  0.4731  0.0157  0.0172  0.0280  0.0373  0.2477  ±0.88%    31747

native array
2.18x faster than local pool
4.29x faster than shared vector with correct amount initialized
4.82x faster than shared pool with already deleted elements
4.94x faster than shared pool
5.54x faster than shared stack
6.56x faster than shared vector
49.91x faster than shared list
```

Shared Data Structures: 1000 deletes end element
```
name                   hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared list        151.97  4.6282  7.9438  6.5802  7.2367  7.9438  7.9438  7.9438  ±2.80%       76
shared vector   15,976.11  0.0322  0.4207  0.0626  0.0747  0.1032  0.3006  0.3641  ±1.00%     7989
shared stack    19,098.35  0.0294  0.3758  0.0524  0.0614  0.0794  0.0952  0.3304  ±0.74%     9550
shared pool     15,707.23  0.0354  0.4088  0.0637  0.0754  0.0953  0.1056  0.3452  ±0.73%     7854
native array   717,416.85  0.0009  0.2655  0.0014  0.0016  0.0022  0.0025  0.0092  ±0.24%   358709

native array
37.56x faster than shared stack
44.91x faster than shared vector
45.67x faster than shared pool
4720.76x faster than shared list
```

Shared Data Structures: 1000 deletes random element
NOTE: Local pool is faster than native because array slice is slower than push/pop to a native recycle array
```
name                  hz      min     max    mean     p75     p99    p995    p999     rme  samples
shared list       9.6443  97.5153  111.98  103.69  107.47  111.98  111.98  111.98  ±3.26%       10
shared vector     313.84   2.7000  3.7852  3.1863  3.3988  3.7169  3.7852  3.7852  ±1.25%      157
local pool     32,625.26   0.0162  0.4183  0.0307  0.0336  0.0510  0.2434  0.3195  ±1.05%    16313
shared pool     8,120.56   0.0656  0.8481  0.1231  0.1427  0.1786  0.2318  0.4631  ±0.94%     4061
native array    7,462.53   0.0905  0.3646  0.1340  0.1527  0.1772  0.1888  0.2701  ±0.60%     3732

local pool
4.02x faster than shared pool
4.37x faster than native array
103.96x faster than shared vector
3382.86x faster than shared list
```

Shared Data Structures: 1000 insert and deleting random elements
```
name                  hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared list      14.1602  65.0318  77.6125  70.6203  71.9693  77.6125  77.6125  77.6125  ±3.81%       10
shared vector     525.78   1.1896   2.5440   1.9019   2.2080   2.4257   2.4653   2.5440  ±2.11%      264
local pool     13,953.14   0.0442   0.4062   0.0717   0.0783   0.1249   0.3229   0.3712  ±0.90%     6977
shared pool     5,439.53   0.1048   0.6860   0.1838   0.2188   0.3715   0.4840   0.5319  ±1.10%     2720
native array    7,400.28   0.0844   0.5230   0.1351   0.1494   0.2955   0.4118   0.4543  ±0.88%     3701

local pool
1.89x faster than native array
2.57x faster than shared pool
26.54x faster than shared vector
985.37x faster than shared list
```

### SharedMap vs native Map
`SharedMap` uses open-addressing with linear probing over a contiguous SharedArrayBuffer table, so it stays within a small constant factor of the native `Map` rather than the order-of-magnitude gap seen elsewhere.  Iterating and deleting are the closest to native; sets are the slowest since they can trigger a rehash.  Keys of 1000 numbers, values randomized:

Shared Map: 1000 sets
```
name               hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared map   7,565.94  0.1166  1.1183  0.1322  0.1278  0.2565  0.2973  0.3598  ±0.76%     3783
native map  48,357.73  0.0177  0.2432  0.0207  0.0199  0.0808  0.0934  0.1398  ±0.57%    24179

native map
6.39x faster than shared map
```

Shared Map: 1000 overwrites
```
name               hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared map  16,906.24  0.0551  0.2499  0.0591  0.0569  0.1194  0.1433  0.1940  ±0.43%     8454
native map  83,196.44  0.0105  0.1686  0.0120  0.0119  0.0197  0.0231  0.0465  ±0.27%    41599

native map
4.92x faster than shared map
```

Shared Map: 1000 gets
```
name               hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared map  16,598.62  0.0494  0.3111  0.0602  0.0593  0.1121  0.1279  0.1718  ±0.70%     8300
native map  93,483.83  0.0073  2.7586  0.0107  0.0138  0.0222  0.0255  0.0398  ±1.23%    46742

native map
5.63x faster than shared map
```

Shared Map: 1000 deletes
```
name               hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared map  17,590.31  0.0497  0.2837  0.0568  0.0526  0.1252  0.1393  0.1909  ±0.59%     8796
native map  59,139.95  0.0147  0.2453  0.0169  0.0164  0.0291  0.0349  0.1017  ±0.36%    29570

native map
3.36x faster than shared map
```

Shared Map: iterate 1000 entries
```
name               hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared map  31,900.32  0.0213  0.4626  0.0313  0.0375  0.0552  0.2321  0.3119  ±1.03%    15951
native map  93,101.22  0.0068  0.1661  0.0107  0.0127  0.0194  0.0224  0.0320  ±0.25%    46551

native map
2.92x faster than shared map
```

### SharedQuadtree, SharedSpatialGrid & SharedSpatialMap vs quadtree-ts
`SharedQuadtree`, `SharedSpatialGrid`, and `SharedSpatialMap` are compared against [quadtree-ts](https://github.com/timohausmann/quadtree-ts).  2000 entities in a 4000x4000 world at `maxLevels` 6 (the grid uses a matching `gridSize` of `4000 / 2^6`; the map uses that `gridSize` with `8192` buckets), 2000 broad-phase queries.  The grid and map lose to the quadtree on build (they write a slot per overlapped cell rather than one record per entity) but win on moves - locating a cell is O(1) arithmetic, so they never walk a tree.  The map trails the grid on queries by ~20% (it pays a hash plus a chain filter per cell instead of a direct array index) in exchange for supporting a world of any size, and edges ahead of it on moves.  Keeping `buckets` a power of two (the default `8192` is) lets the hash fold with a bitmask instead of an integer modulo, which is the bulk of that query gap.

Spatial: build a tree of 2000 entities
```
name                     hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared quadtree    1,436.15  0.6209  1.3570  0.6963  0.7027  1.1195  1.2089  1.3570  ±1.07%      719
shared grid        1,374.14  0.6542  1.2853  0.7277  0.7477  1.1090  1.1732  1.2853  ±0.90%      688
shared spatial map 1,400.20  0.6582  1.3059  0.7142  0.6994  1.0970  1.2237  1.3059  ±0.92%      701
quadtree-ts        3,046.65  0.2783  0.8150  0.3282  0.3204  0.5779  0.6358  0.7510  ±1.10%     1524

quadtree-ts
2.12x faster than shared quadtree
2.18x faster than shared spatial map
2.22x faster than shared grid
```

Spatial: 2000 broad-phase queries
```
name                   hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared quadtree     371.48  2.5098  3.4806  2.6920  2.7648  3.4707  3.4806  3.4806  ±1.10%      186
shared grid        1,070.21 0.8526  1.6428  0.9344  0.9378  1.4434  1.5309  1.6428  ±1.05%      536
shared spatial map  872.88  1.0642  2.1479  1.1456  1.1538  1.5745  1.7456  2.1479  ±0.91%      437
quadtree-ts         468.88  1.9026  3.4872  2.1327  2.2241  2.8745  2.9228  3.4872  ±1.31%      235

shared grid
1.23x faster than shared spatial map
2.28x faster than quadtree-ts
2.88x faster than shared quadtree
```

Spatial: move all 2000 entities one step
```
name                     hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared quadtree    2,141.72   0.4201   1.4691   0.4669   0.4566   0.8083   0.9164   0.9715  ±0.98%     1071
shared grid        5,975.70   0.1585   0.3740   0.1673   0.1652   0.2599   0.2882   0.3438  ±0.38%     2988
shared spatial map 6,102.92   0.1500   0.4624   0.1639   0.1621   0.2762   0.2985   0.3736  ±0.51%     3052
quadtree-ts        91.1875  10.4286  14.0798  10.9664  10.9999  14.0798  14.0798  14.0798  ±1.87%       46

shared spatial map
1.02x faster than shared grid
2.85x faster than shared quadtree
66.93x faster than quadtree-ts
```

## Credit
The entire core of this library is based on a fork of @thi.ng/malloc found at https://github.com/thi-ng/umbrella/blob/develop/packages/malloc.  The only big difference between our MemoryBuffer and their MemPool is making allocations/freeing memory thread safe.