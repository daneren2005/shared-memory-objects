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
- SharedPool and SharedStack are thread safe
- SharedList, SharedVector, and SharedMap are *not* thread safe.
- SharedString is thread safe with a lock on read/write with a cached version of the string so it doesn't need to lock after the first read unless the string has changed.
- ConstantString is safe to read from any thread without a lock precisely because it is never written after construction

## TODO
- Make creating new buffers from allocations possible from multiple threads
- Make data structures thread safe
- Make map structure that isn't so slow as to be useless

## Performance
The tl;dr is that none of these data structures are close to what you can get by just using native data structures, but I wasn't expecting them to be with their overhead.
They are all significantly slower at iterating and accessing an indexed location.  The SharedList is slowest at everything.
The SharedPool/LocalPool is the closest to native performance when doing a bunch of random deletes and inserts, which is what I use it for as the memory storage for components in my own ECS framework.
Since indexed access is about 1/4 the speed of just using a native JS array, there needs to be a lot of work offloaded into a separate thread to make it worth it.

Shared Data Structures: 10000 iterations
```
name                   hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared list      1,040.61  0.7898  2.1673  0.9610  1.0080  1.6299  1.7740  2.1673  ±1.49%      521
shared vector    2,447.08  0.3489  0.8944  0.4086  0.4369  0.7289  0.7887  0.8457  ±1.12%     1224
local pool       2,661.05  0.3266  0.9810  0.3758  0.3751  0.6516  0.7423  0.9332  ±1.05%     1331
shared pool      2,052.60  0.4255  1.1583  0.4872  0.4878  0.8323  0.8735  1.0186  ±1.10%     1027
native array   379,950.63  0.0021  0.1505  0.0026  0.0023  0.0062  0.0070  0.0218  ±0.28%   189976

native array
142.78x faster than local pool
155.27x faster than shared vector
185.11x faster than shared pool
365.12x faster than shared list
```

Shared Data Structures: 1000 indexed locations
```
name                   hz     min     max    mean     p75     p99    p995    p999     rme  samples
shared vector   28,713.93  0.0276  1.1649  0.0348  0.0335  0.0767  0.1276  0.2245  ±0.86%    14357
local pool      88,708.78  0.0099  0.2418  0.0113  0.0105  0.0192  0.0261  0.1700  ±0.62%    44369
shared pool     33,795.16  0.0270  0.1868  0.0296  0.0287  0.0536  0.0631  0.1376  ±0.36%    16898
native array   126,855.06  0.0072  0.2046  0.0079  0.0076  0.0129  0.0146  0.0993  ±0.42%    63428

native array
1.43x faster than local pool
3.75x faster than shared pool
4.42x faster than shared vector
```

Shared Data Structures: 1000 inserts
```
name                                                  hz     min      max    mean     p75      p99     p995     p999     rme  samples
shared list                                     1,989.04  0.4176   1.2361   0.5028   0.5238   0.9547   1.0934   1.2361  ±1.49%      995
shared map                                       98.3711  8.8636  13.3231  10.1656  10.7163  13.3231  13.3231  13.3231  ±3.14%       50
shared vector                                  15,559.65  0.0529   0.4758   0.0643   0.0609   0.1405   0.1849   0.2850  ±0.71%     7780
shared vector with correct amount initialized  22,386.17  0.0372   0.3258   0.0447   0.0415   0.0968   0.1167   0.2119  ±0.61%    11194
local pool                                     43,012.42  0.0173   0.3407   0.0232   0.0210   0.0706   0.0933   0.2009  ±0.79%    21507
shared pool                                     9,873.77  0.0794   0.5068   0.1013   0.1013   0.2696   0.3232   0.4319  ±1.06%     4937
shared pool with already deleted elements      13,396.59  0.0643   0.3341   0.0746   0.0700   0.1830   0.2322   0.2799  ±0.70%     6699
native array                                   94,368.06  0.0084   0.4662   0.0106   0.0101   0.0236   0.0498   0.1181  ±0.61%    47186

native array
2.19x faster than local pool
4.22x faster than shared vector with correct amount initialized
6.06x faster than shared vector
7.04x faster than shared pool with already deleted elements
9.56x faster than shared pool
47.44x faster than shared list
959.31x faster than shared map
```

Shared Data Structures: 1000 deletes random element
NOTE: Local pool is faster than native because array slice is slower than push/pop to a native recycle array
```
name                  hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared list      13.1818  68.1220  83.8157  75.8622  79.3236  83.8157  83.8157  83.8157  ±4.40%       10
shared vector     387.53   2.3857   3.0819   2.5804   2.6409   3.0624   3.0819   3.0819  ±0.70%      194
local pool     71,370.27   0.0105   0.5406   0.0140   0.0122   0.1055   0.1351   0.1960  ±1.07%    35686
shared pool    13,049.38   0.0689   0.2990   0.0766   0.0746   0.1439   0.1681   0.2269  ±0.51%     6525
native array   10,559.95   0.0827   0.2363   0.0947   0.0941   0.1532   0.1693   0.2037  ±0.45%     5281

local pool
5.47x faster than shared pool
6.76x faster than native array
184.17x faster than shared vector
5414.30x faster than shared list
```

Shared Data Structures: 1000 insert and deleting random elements
```
name                  hz      min      max     mean      p75      p99     p995     p999     rme  samples
shared list      20.5573  43.7463  57.7009  48.6445  50.4710  57.7009  57.7009  57.7009  ±5.73%       11
shared vector     752.07   1.0805   2.4937   1.3297   1.3769   2.1734   2.3537   2.4937  ±1.81%      377
local pool     22,453.72   0.0388   0.3417   0.0445   0.0417   0.1214   0.1574   0.2231  ±0.63%    11227
shared pool     5,684.68   0.1490   1.7416   0.1759   0.1703   0.4351   0.5387   0.9790  ±1.37%     2843
native array   11,030.10   0.0793   0.2980   0.0907   0.0866   0.1808   0.1976   0.2412  ±0.54%     5516

local pool
2.04x faster than native array
3.95x faster than shared pool
29.86x faster than shared vector
1092.25x faster than shared list
```

## Credit
The entire core of this library is based on a fork of @thi.ng/malloc found at https://github.com/thi-ng/umbrella/blob/develop/packages/malloc.  The only big difference between our MemoryBuffer and their MemPool is making allocations/freeing memory thread safe.