export function get32BitHash<K extends string | number>(key: K): number {
	if(typeof key === 'number') {
		return key;
	} else if(typeof key === 'string') {
		return hashString(key);
	} else {
		return key;
	}
}

// Copied from https://github.com/mmomtchev/SharedMap/blob/master/index.js - MurmurHash2
export function hashString(str: string): number {
	let
		l = str.length,
		h = 17 ^ l,
		i = 0,
		k;
	while(l >= 4) {
		k =
			((str.charCodeAt(i) & 0xff)) |
			((str.charCodeAt(++i) & 0xff) << 8) |
			((str.charCodeAt(++i) & 0xff) << 16) |
			((str.charCodeAt(++i) & 0xff) << 14);
		k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
		k ^= k >>> 14;
		k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
		h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16)) ^ k;
		l -= 4;
		++i;
	}
	/* eslint-disable no-fallthrough */
	switch(l) {
		case 3: h ^= (str.charCodeAt(i + 2) & 0xff) << 16;
		case 2: h ^= (str.charCodeAt(i + 1) & 0xff) << 8;
		case 1: h ^= (str.charCodeAt(i) & 0xff);
			h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
	}
	/* eslint-enable no-fallthrough */
	h ^= h >>> 13;
	h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
	h ^= h >>> 15;
	h = h >>> 0;
	return h;
}

// Fibonacci/avalanche mix so patterned integer keys (e.g. sequential ids) spread across a power-of-two table instead of
// clustering. Returns an unsigned 32-bit value; callers mask with (capacity - 1).
export function mix32(h: number): number {
	h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
	h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
	h = (h ^ (h >>> 16)) >>> 0;
	return h;
}
