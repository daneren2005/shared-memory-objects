import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// The safety specs drive real worker_threads and are the only tests that can catch a race, so they are worth running
// over and over: a bug that shows up one run in five is invisible in a single pass. They are excluded from the normal
// unit run (see vitest.config.ts) and live here instead, where each one repeats and nothing else competes for the CPU.
export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			root: fileURLToPath(new URL('./', import.meta.url)),
			globals: true,
			include: ['src/**/*.safety.ts'],
			// v8 coverage never sees the worker threads anyway, and it slows the run it does instrument
			coverage: {
				enabled: false,
			},
			// One spec file at a time: several files' worth of workers at once oversubscribes the CPU and turns a slow run
			// into a spurious timeout
			fileParallelism: false,
			// vitest 4 has no config-level repeats, so the specs read this and pass it as a per-test option
			env: {
				SAFETY_REPEATS: '50',
			},
		},
	}),
);
