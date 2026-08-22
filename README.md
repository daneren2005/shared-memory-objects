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

## Thread Safety
- Memory allocations is thread safe as long as it does not need to create a new buffer.  Right now that can only be done from the main thread.
- SharedList, SharedPool and SharedStack are thread safe
- SharedVector is *not* thread safe and probably never will be - it is useful for updating in main thread and then sending off to works for processing
- SharedMap is *not* thread safe and is honestly so slow as to be basically worthless
- SharedString is thread safe with a lock on read/write with a cached version of the string so it doesn't need to lock after the first read unless the string has changed.
- ConstantString is safe to read from any thread without a lock precisely because it is never written after construction

## TODO
- Make creating new buffers from allocations possible from multiple threads
- Make map structure that isn't so slow as to be useless

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

## Credit
The entire core of this library is based on a fork of @thi.ng/malloc found at https://github.com/thi-ng/umbrella/blob/develop/packages/malloc.  The only big difference between our MemoryBuffer and their MemPool is making allocations/freeing memory thread safe.