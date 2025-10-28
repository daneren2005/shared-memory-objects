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
Since indexed access is about 1/4 the speed of just using a native JS array, there needs to be a lot of work offloaded into a separate thread to make it worth it.

Shared Data Structures: 10000 iterations
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

Shared Data Structures: 1000 indexed locations
```
name                   hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared vector   27,325.20  0.0313  0.3615  0.0366  0.0333  0.0689  0.0859  0.2216  ±0.60%    13663
shared pool     31,568.26  0.0272  0.2785  0.0317  0.0295  0.0583  0.0692  0.1803  ±0.50%    15785
native array   114,517.08  0.0074  0.2652  0.0087  0.0079  0.0171  0.0254  0.1205  ±0.56%    57259

native array
3.63x faster than shared pool
4.19x faster than shared vector
```

Shared Data Structures: 1000 inserts
```
name                                                  hz     min      max    mean     p75      p99     p995     p999     rme  samples
shared list                                     2,154.19  0.4107   1.1497  0.4642  0.4531   0.8892   0.9123   1.0928  ±1.14%     1078
shared map                                        105.46  8.3417  15.2814  9.4824  9.5396  15.2814  15.2814  15.2814  ±4.05%       53
shared vector                                  11,058.22  0.0799   0.3675  0.0904  0.0863   0.2084   0.2340   0.2833  ±0.66%     5530
shared vector with correct amount initialized  16,369.28  0.0548   0.2825  0.0611  0.0575   0.1462   0.1620   0.2008  ±0.56%     8185
shared pool                                    10,653.47  0.0835   0.3480  0.0939  0.0900   0.2041   0.2222   0.2877  ±0.61%     5327
native array                                   96,437.13  0.0079   0.2799  0.0104  0.0097   0.0234   0.0681   0.1194  ±0.63%    48219

native array
5.89x faster than shared vector with correct amount initialized
8.72x faster than shared vector
9.37x faster than shared pool
44.77x faster than shared list
914.45x faster than shared map
```

Shared Data Structures: 1000 deletes random element
```
name                  hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared list      14.1243  60.2658  82.0964  70.7998  77.6842  82.0964  82.0964  82.0964  ±6.93%       10
shared vector     393.31   2.3719   3.4563   2.5425   2.5639   3.3824   3.4563   3.4563  ±0.81%      197
shared pool     8,824.76   0.1005   0.4998   0.1133   0.1085   0.2338   0.2631   0.3420  ±0.72%     4413
native array   10,750.49   0.0829   0.6180   0.0930   0.0908   0.1494   0.1592   0.2420  ±0.45%     5376

native array
1.22x faster than shared pool
27.33x faster than shared vector
761.13x faster than shared list
```

Shared Data Structures: 1000 insert and deleting random elements
```
name                  hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared list      23.3898  40.4675  46.8902  42.7537  43.4073  46.8902  46.8902  46.8902  ±3.04%       12
shared vector     848.84   1.0093   2.1141   1.1781   1.1890   1.9349   1.9559   2.1141  ±1.42%      425
shared pool     4,862.78   0.1822   0.6673   0.2056   0.1974   0.3683   0.3796   0.4319  ±0.75%     2432
native array   10,584.21   0.0808   0.3616   0.0945   0.0897   0.2304   0.2540   0.3033  ±0.71%     5293

native array
2.18x faster than shared pool
12.47x faster than shared vector
452.51x faster than shared list
```

## Credit
The entire core of this library is based on a fork of @thi.ng/malloc found at https://github.com/thi-ng/umbrella/blob/develop/packages/malloc.  The only big difference between our MemoryBuffer and their MemPool is making allocations/freeing memory thread safe.