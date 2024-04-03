import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			root: fileURLToPath(new URL('./', import.meta.url)),
			globals: true,
			coverage: {
				enabled: true,
				reporter: ['html']
			}
		}
	})
);
