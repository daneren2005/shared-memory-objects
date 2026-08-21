import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			root: fileURLToPath(new URL('./', import.meta.url)),
			globals: true,
			coverage: {
				enabled: true,
				reporter: ['html'],
			},
		},
	}),
);
