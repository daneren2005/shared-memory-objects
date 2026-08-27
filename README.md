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
- SharedQuadtree - a fixed-depth region quadtree for live, concurrent spatial updates.  The tree shape is allocated once and never subdivides at runtime, so different cells never contend and entities can be inserted/moved/removed from any thread.  Each entity lives in the single deepest cell that fully contains it; `search(x, y, width, height)` returns a broad-phase superset of candidate ids (same guarantee as quadtree-ts).  Configure with `{ bounds: { x, y, width, height }, maxLevels, maxEntities, type }`, where `type` is `Float32Array` (default) or `Float64Array` for the stored coordinate precision.
- SharedSpatialGrid - a uniform fixed grid for live, concurrent spatial updates, the flat-grid counterpart to `SharedQuadtree`.  The `cols x rows` array of cells is allocated once and never reshaped, so different cells never contend and entities can be inserted/moved/removed from any thread.  Unlike the quadtree, an entity is linked into *every* cell its rect overlaps, so a large or edge-straddling entity spans several cells; `search(x, y, width, height)` still returns each candidate id at most once (a per-slot anchor cell dedups without any shared state, so concurrent queries stay safe).  Locating a cell is O(1) arithmetic instead of a tree descent, which tends to beat the quadtree for evenly distributed, similarly-sized entities.  Configure with `{ bounds: { x, y, width, height }, gridSize, maxEntities, maxSlots, type }`, where `gridSize` defaults to `50` and `type` is `Float32Array` (default) or `Float64Array` for the stored coordinate precision.
- SharedSpatialMap - an unbounded spatial hash for live, concurrent spatial updates, the boundless counterpart to `SharedSpatialGrid`. It indexes the same way (an entity is linked into *every* virtual cell of side `gridSize` its rect overlaps) but drops the fixed `cols x rows` extent, so the world can be any size and cells may sit at any coordinate, positive or negative - there are no `bounds`. The table starts with `256` buckets by default and doubles when its slot load exceeds `0.5`, rehashing under an exclusive table lock while ordinary operations share the read side. Bucket storage grows in 256-bucket pages tracked by a `SharedStack`, so neither the final table nor its pointer spine is reserved up front. Configure with `{ gridSize, buckets, maxBuckets, maxEntities, maxSlots, type }`; `buckets` sets the initial count and `maxBuckets` optionally caps growth. Power-of-two counts use a bitmask instead of integer modulo.

All three spatial structures accept an optional ID predicate as the final search argument, such as `search(x, y, width, height, id => enemies.has(id))`. `searchInto(out, x, y, width, height, filter?)` provides the same filtering while appending matches to a reusable result array.

## Memory Usage
`SharedList`, `SharedVector`, `SharedPool`, and `SharedStack` each expose a `usedMemory` getter that returns the number of bytes the structure occupies in the heap, including every pointer resource it owns.  For example, `SharedStack.usedMemory` is its own internal memory plus the combined memory of each already allocated segment, and `SharedPool.usedMemory` includes each chunk buffer and the segments of its two internal stacks (but not those stacks' internal memory, since that is inlined into the pool's own internal memory).  The number is the aligned data size of each allocation and excludes the allocator's per-block header.  SharedStack and SharedPool get a lot of their close to native performance by allocating more memory than maybe needed and locking in max length up front.  This works well when used for a few high-performance structures, but if you are giving each entity in an ECS framework multiple SharedPools that memory is going to add up quickly.  Both SharedPool and SharedStack initial memory can be tweaked by lowering the maxLength param.

Freshly allocated with the default options:

| Structure                       | Used Memory |
| ------------------------------- | ----------- |
| SharedList                      | 16 bytes    |
| SharedVector                    | 32 bytes    |
| SharedStack                     | 144 bytes   |
| SharedPool                      | 664 bytes   |
| SharedMap                       | 216 bytes   |
| SharedQuadtree                  | 6064 bytes  |
| SharedQuadtree(6)               | 47024 bytes |
| SharedSpatialGrid (20x20 cells) | 8816 bytes  |
| SharedSpatialGrid (80x80 cells) | 56816 bytes |
| SharedSpatialMap (default)      | 8984 bytes  |
| SharedSpatialMap (2048 buckets) | 23384 bytes |

`SharedQuadtree`'s footprint is dominated by its fixed node array, which is allocated once up front and never grows.  The default `maxLevels` of 4 is a complete tree of 341 nodes (`(4^(maxLevels+1) - 1) / 3`), so the number scales with `maxLevels`: a deeper tree resolves smaller entities but costs `~2 u32` per node.  The rest is its internal `SharedPool` of entity records and the `SharedMap` that indexes entities by id, whose header blocks are inlined into the tree's own allocation (the same way `SharedPool` inlines its two stacks) so the whole spine is one contiguous block instead of three separate pointer resources.  The record (id, `x/y/w/h`, node, bucket link) is stored at the configured precision, defaulting to `Float32` to match a physics engine that keeps positions in `Float32`.  `Float32` stays exact as long as entity ids and the entity count both stay under 2^24 (~16.7M); pass `type: Float64Array` if you need ids or a capacity beyond that (constructing a `Float32` tree with `maxEntities` over 2^24 throws), at the cost of more memory per entity.

`SharedSpatialGrid`'s footprint is likewise dominated by its fixed cell array (`cols x rows` cells at `~2 u32` each), so it scales with cell count rather than `maxLevels`: `cols = ceil(width / gridSize)` and `rows = ceil(height / gridSize)`, so a smaller `gridSize` resolves finer at the cost of more cells (the 20x20 grid above is a 1000x1000 world at `gridSize` 50; the 80x80 grid is a 4000x4000 world at `gridSize` 50).  The rest is two inlined `SharedPool`s - one of entity records (the occupied cell rectangle, keyed by an inlined `SharedMap` of id -> index) and one of per-cell "slot" records (`id`, anchor cell, bucket link) - since a multi-cell entity needs one slot per cell it overlaps.  `maxSlots` therefore defaults to `maxEntities * 4` to leave headroom for spanning entities.  Coordinate precision follows the same `Float32`-default rule as the quadtree (ids, both pools' indices, and cell indices must stay under 2^24 for `Float32`; pass `type: Float64Array` otherwise).

`SharedSpatialMap` starts at 8984 bytes with its default 256 buckets, about 87% less than the former fixed 8192-bucket table's 70312 bytes. When the number of allocated slots exceeds half the active bucket count, it doubles the count and rebuilds the bucket chains. Its 256-bucket pages remain at stable addresses, while their pointers live in a `SharedStack` that grows in segments. `buckets` is therefore an initial size hint rather than a permanent sizing decision; `map.buckets` reports the current count. `maxBuckets` can stop growth for a deliberately collision-heavy or memory-capped table and otherwise defaults high enough to preserve the target load through `maxSlots`. The rest is the same two inlined `SharedPool`s as the grid - one of entity records and one of per-cell slot records. `maxSlots` defaults to `maxEntities * 4`, and coordinate precision follows the same `Float32`-default rule.

All three spatial indexes accept `bulkInsert(entities)`, where each entity has `{ id, x, y, width?, height? }`. Duplicate ids keep their last value. The method retains the normal thread-safety guarantees while reserving entity and slot ranges with one atomic operation, sizing the ID map once, and writing records directly into their pool blocks; `SharedSpatialMap` also sizes its bucket table once before linking a new batch. When an explicit entity or slot capacity is at most 16384, its pool uses one bounded contiguous chunk instead of a series of 100-record chunks. Larger and default capacities retain incremental allocation so an empty index does not reserve excessive memory.

## Thread Safety
- Memory allocations is thread safe as long as it does not need to create a new buffer.  Right now that can only be done from the main thread.  I just make sure there is always an extra empty buffer with SharedHeap.ensureSpareBuffer() before sending more work to worker threads.
- SharedList, SharedPool, SharedStack, and SharedMap are thread safe
- SharedVector is *not* thread safe and probably never will be - it is useful for updating in main thread and then sending off to works for processing
- SharedString is thread safe with a lock on read/write with a cached version of the string so it doesn't need to lock after the first read unless the string has changed.
- ConstantString is safe to read from any thread without a lock precisely because it is never written after construction
- SharedQuadtree is thread safe.  Its node structure never changes shape, so concurrency reduces to per-cell content updates guarded by a per-node lock
- SharedSpatialGrid is thread safe.  Its cell array never changes shape, so concurrency reduces to per-cell content updates guarded by a per-cell lock; a query racing an in-flight move sees the entity in its old or new cells (or briefly both), never neither
- SharedSpatialMap is thread safe. Normal operations share a table read lock and retain their per-bucket locks; a resize takes the exclusive table lock, doubles the bucket count, and rebuilds every live slot before atomically publishing the new count. Like the grid, a query racing an in-flight move sees the entity in its old or new cells (or briefly both), never neither.


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

### SharedQuadtree, SharedSpatialGrid & SharedSpatialMap vs quadtree-ts and Flatbush
`SharedQuadtree`, `SharedSpatialGrid`, and `SharedSpatialMap` are compared against [quadtree-ts](https://github.com/timohausmann/quadtree-ts) and [Flatbush](https://github.com/mourner/flatbush). 2000 entities are indexed in a 4000x4000 world at `maxLevels` 6 (the grid and map use a matching `gridSize` of `4000 / 2^6`; the map starts with its default 256 buckets and grows automatically), followed by 2000 broad-phase queries and separate nearest-neighbor workloads for one and ten entities within 500 units. The individual and bulk-insert benchmarks are separate; Flatbush rebuilds the same packed static index in both because it cannot insert into an existing index. Bulk insertion improves throughput by 35% for the quadtree, 38% for the grid, and 141% for the spatial map in this run. Flatbush remains 4.34-5.19x faster because it writes a static packed index without maintaining entity records, an ID map, mutable linked buckets, or concurrency locks. An exclusive-access prototype that skipped spatial locks was only another 5%, 16%, and 8% faster, respectively, so no unsafe API was retained. The 20% movement benchmark compares updating 400 entities in place against rebuilding the complete Flatbush index.

Spatial: insert 2000 entities individually
```
name                       hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared quadtree      1,212.63  0.7296  1.3859  0.8247  0.8331  1.2833  1.2873  1.3859  ±1.04%      607
shared spatial grid  1,375.28  0.6699  2.1926  0.7271  0.7180  1.1583  1.3865  2.1926  ±1.06%      688
shared spatial map     657.46  1.3579  3.0925  1.5210  1.6021  2.2632  2.8197  3.0925  ±1.48%      329
quadtree-ts          2,987.46  0.2852  0.8549  0.3347  0.3314  0.5781  0.6212  0.7504  ±1.08%     1494
flatbush             7,952.20  0.0842  3.5122  0.1258  0.1213  0.2721  0.3678  3.0778  ±3.40%     3977

flatbush
2.66x faster than quadtree-ts
5.78x faster than shared spatial grid
6.56x faster than shared quadtree
12.10x faster than shared spatial map
```

Spatial: bulk insert 2000 entities
```
name                       hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared quadtree      1,639.98  0.5159  1.2655  0.6098  0.6029  1.0288  1.1218  1.2655  ±1.24%      820
shared spatial grid  1,896.56  0.4640  1.2814  0.5273  0.5231  0.8856  0.9616  1.2814  ±1.03%      949
shared spatial map   1,587.58  0.5441  1.4163  0.6299  0.6269  1.0970  1.1545  1.4163  ±1.23%      794
quadtree-ts          2,949.02  0.2851  0.8573  0.3391  0.3366  0.6154  0.6671  0.7323  ±1.14%     1475
flatbush             8,239.33  0.0839  3.2123  0.1214  0.1167  0.2709  0.3513  2.8912  ±3.38%     4120

flatbush
2.79x faster than quadtree-ts
4.34x faster than shared spatial grid
5.02x faster than shared quadtree
5.19x faster than shared spatial map
```

Spatial: 2000 broad-phase queries
```
name                    hz     min      max    mean     p75      p99     p995     p999     rme  samples
shared quadtree        366.51  2.5524  4.3675  2.7284  2.7761  3.8666  4.3675  4.3675  ±1.29%      184
shared spatial grid  1,030.39  0.9007  1.6533  0.9705  0.9815  1.3996  1.4830  1.6533  ±0.87%      516
shared spatial map     695.37  1.3453  2.4798  1.4381  1.4295  2.1762  2.2132  2.4798  ±1.16%      348
quadtree-ts            486.60  1.9084  2.9569  2.0551  2.1063  2.7593  2.8674  2.9569  ±0.97%      244
flatbush             1,373.81  0.6734  1.1711  0.7279  0.7272  1.0091  1.0517  1.1711  ±0.75%      687

flatbush
1.33x faster than shared spatial grid
1.98x faster than shared spatial map
2.82x faster than quadtree-ts
3.75x faster than shared quadtree
```

Spatial: 2000 single nearest-neighbor queries (within 500 units)
```
name                     hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared quadtree      202.09  4.6839  5.7693  4.9483  5.0355  5.7382  5.7693  5.7693  ±0.87%      102
shared spatial grid  335.06  2.6652  4.6020  2.9845  3.0485  4.4999  4.6020  4.6020  ±1.85%      168
shared spatial map   411.41  2.0371  3.9992  2.4307  2.6217  3.6954  3.8876  3.9992  ±2.67%      206
flatbush             590.88  1.5631  3.1001  1.6924  1.6861  2.8048  2.9393  3.1001  ±1.27%      296

flatbush
1.44x faster than shared spatial map
1.76x faster than shared spatial grid
2.92x faster than shared quadtree
```

Spatial: 2000 ten nearest-neighbor queries (within 500 units)
```
name                      hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared quadtree      30.6419  30.8902  35.3604  32.6350  33.3034  35.3604  35.3604  35.3604  ±2.30%       16
shared spatial grid  37.4153  24.4494  31.1661  26.7271  28.9389  31.1661  31.1661  31.1661  ±3.97%       19
shared spatial map   82.6032  11.3958  14.0954  12.1061  12.3320  14.0954  14.0954  14.0954  ±1.24%       42
flatbush              264.77   3.5514   4.9065   3.7768   3.8120   4.8969   4.9065   4.9065  ±1.17%      133

flatbush
3.21x faster than shared spatial map
7.08x faster than shared spatial grid
8.64x faster than shared quadtree
```

Spatial: move 400 of 2000 entities one step
```
name                       hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared quadtree      12,139.41  0.0768  0.3493  0.0824  0.0800  0.1575  0.1898  0.2901  ±0.50%     6070
shared spatial grid  22,487.06  0.0337  3.0813  0.0445  0.0532  0.0983  0.1459  0.4174  ±1.72%    11244
shared spatial map   19,975.95  0.0296  0.1885  0.0501  0.0554  0.0707  0.0819  0.1385  ±0.45%     9989
flatbush (rebuild)    5,505.80  0.0860  3.4945  0.1816  0.1934  0.3027  0.3760  2.9520  ±2.87%     2754

shared spatial grid
1.13x faster than shared spatial map
1.85x faster than shared quadtree
4.08x faster than flatbush (rebuild)
```

Spatial: move all 2000 entities one step
```
name                      hz      min      max     mean      p75      p99     p995     p999      rme  samples
shared quadtree      1,355.57   0.4382   1.2586   0.7377   0.8367   1.0493   1.1394   1.2586  ±1.37%      678
shared spatial grid  3,121.59   0.2021   0.7684   0.3203   0.3794   0.4725   0.5177   0.7191  ±1.26%     1561
shared spatial map   3,450.37   0.1655   0.6403   0.2898   0.3147   0.4075   0.5172   0.5991  ±0.98%     1726
quadtree-ts           52.9839  13.9189  21.4902  18.8737  20.2757  21.4902  21.4902  21.4902  ±4.16%       27

shared spatial map
1.11x faster than shared spatial grid
2.55x faster than shared quadtree
65.12x faster than quadtree-ts
```

## Credit
The entire core of this library is based on a fork of @thi.ng/malloc found at https://github.com/thi-ng/umbrella/blob/develop/packages/malloc.  The only big difference between our MemoryBuffer and their MemPool is making allocations/freeing memory thread safe.
