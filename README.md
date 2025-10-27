# Shared Memory Objects
A library to try to make making a multi-threaded game in Javascript possible.  This package is to provide a wrapper to create objects and data structures that are backed by a SharedArrayBuffer and can be shared between multiple threads.  The end result is a package that has all of the slowness of Javascript with all of the baggage of dealing with manual memory allocations.  If you need to multi-thread you are probably better of just using a different language and compiling to WebAssembly.  But if you, like me, just want to use Javascript/Typescript and are willing to deal with dealing with manual memory allocations then this library could save you some time.

A demo can be found at https://daneren2005.github.io/ecs-sharedarraybuffer-playground/#/shared-memory-objects  
The code is at https://github.com/daneren2005/ecs-sharedarraybuffer-playground/tree/dev/src/shared-memory-objects

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
- SharedPool - stable indexed data with a recycled pool and maximum internal array sizes
- SharedString

## Thread Safety
- Memory allocations is thread safe as long as it does not need to create a new buffer.  Right now that can only be done from the main thread.
- SharedList, SharedVector, and SharedMap are all not thread safe.
- SharedString is thread safe with a lock on read/write with a cached version of the string so it doesn't need to lock after the first read unless the string has changed.

## TODO
- Make creating new buffers from allocations possible from multiple threads
- Make data structures thread safe
- Add basic thread safe object example

## Performance
The tl;dr is that none of these data structures are close to what you can get by just using native data structures, but I wasn't expecting them to be with their overhead.
They are all significantly slower at iterating and accessing an indexed location.  The SharedList is slowest at everything.
The SharedPool is the closest to native performance when doing a bunch of random deletes and inserts, which is what I use it for as the memory storage for components in my own ECS framework.
Since indexed access is about 1/5 the speed of just using a native JS array, there needs to be a lot of work offloaded into a separate thread of make it worth it.

Shared Data Structures: 10000 iterations 36242ms
```
name                   hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared list      1,178.27  0.7080  1.8484  0.8487  0.9095  1.4762  1.5502  1.8484  ±1.38%      590
shared vector    2,071.17  0.4084  1.1862  0.4828  0.5102  0.8796  0.9150  1.0795  ±1.31%     1036
shared pool      1,944.70  0.4563  1.1443  0.5142  0.5139  0.8429  1.0326  1.1443  ±1.09%      973
native array   392,746.59  0.0021  0.1976  0.0025  0.0023  0.0059  0.0068  0.0148  ±0.25%   196374

native array
189.63x faster than shared vector
201.96x faster than shared pool
333.33x faster than shared list
```

Shared Data Structures: 1000 indexed locations 4258ms
```
name                   hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared vector   28,917.42  0.0311  0.2926  0.0346  0.0328  0.0631  0.0822  0.1994  ±0.50%    14459
shared pool     20,636.58  0.0446  0.2953  0.0485  0.0464  0.0851  0.1039  0.2063  ±0.45%    10319
native array   120,189.16  0.0073  0.2456  0.0083  0.0078  0.0144  0.0189  0.1003  ±0.47%    60095

native array
4.16x faster than shared vector
5.82x faster than shared pool
```

Shared Data Structures: 1000 inserts 3685ms
```
name                                                  hz     min      max    mean     p75      p99     p995     p999     rme  samples
shared list                                     2,154.19  0.4107   1.1497  0.4642  0.4531   0.8892   0.9123   1.0928  ±1.14%     1078
shared map                                        105.46  8.3417  15.2814  9.4824  9.5396  15.2814  15.2814  15.2814  ±4.05%       53
shared vector                                  11,058.22  0.0799   0.3675  0.0904  0.0863   0.2084   0.2340   0.2833  ±0.66%     5530
shared vector with correct amount initialized  16,369.28  0.0548   0.2825  0.0611  0.0575   0.1462   0.1620   0.2008  ±0.56%     8185
shared pool                                    16,496.33  0.0537   0.2538  0.0606  0.0573   0.1396   0.1635   0.2081  ±0.55%     8249
native array                                   96,437.13  0.0079   0.2799  0.0104  0.0097   0.0234   0.0681   0.1194  ±0.63%    48219

native array
5.85x faster than shared pool
5.89x faster than shared vector with correct amount initialized
8.72x faster than shared vector
44.77x faster than shared list
914.45x faster than shared map
```

Shared Data Structures: 1000 deletes random element 3803ms
```
name                  hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared list      15.0673  61.7598  82.5745  66.3688  66.1354  82.5745  82.5745  82.5745  ±6.77%       10
shared vector     392.32   2.3210   3.3845   2.5490   2.6034   3.2132   3.3845   3.3845  ±0.87%      197
shared pool     7,863.80   0.1107   0.6587   0.1272   0.1214   0.2658   0.2978   0.3581  ±0.76%     3932
native array   11,069.38   0.0810   0.2720   0.0903   0.0884   0.1469   0.1695   0.2330  ±0.39%     5536

native array
1.41x faster than shared pool
28.22x faster than shared vector
734.66x faster than shared list
```

Shared Data Structures: 1000 insert and deleting random elements 3046ms
```
name                  hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared list      23.7748  39.9588  45.1601  42.0613  42.5335  45.1601  45.1601  45.1601  ±2.42%       12
shared vector     902.76   0.9947   1.8245   1.1077   1.1230   1.5256   1.5723   1.8245  ±0.83%      452
shared pool     4,595.05   0.1917   0.5539   0.2176   0.2092   0.3902   0.4076   0.4921  ±0.73%     2298
native array   11,004.28   0.0785   0.3460   0.0909   0.0872   0.1865   0.2116   0.2406  ±0.54%     5503

native array
2.39x faster than shared pool
12.19x faster than shared vector
462.85x faster than shared list
```

## Credit
The entire core of this library is based on a fork of @thi.ng/malloc found at https://github.com/thi-ng/umbrella/blob/develop/packages/malloc.  The only big difference between our MemoryBuffer and their MemPool is making allocations/freeing memory thread safe.