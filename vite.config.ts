import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import dts from 'unplugin-dts/vite';

// Every source module is built 1:1 into dist/ (preserveModules) so a consumer imports exactly the module it needs
// - e.g. '@daneren2005/shared-memory-objects/utils/atomic-math' - rather than a single barrel.  A barrel is a
// liability here: a single-entry consumer build (like a Web Worker) cannot tree-shake a re-export barrel and ends
// up pulling the whole library, so there deliberately is no index/main entry.  Each .ts under src is its own
// build entry; the JS lands at dist/<path>.js and its declaration (emitted by unplugin-dts) at dist/src/<path>.d.ts,
// which the wildcard `exports` in package.json maps together.
const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const entry = readdirSync(srcDir, { recursive: true })
	.filter((file): file is string => typeof file === 'string' && file.endsWith('.ts') && !file.endsWith('.d.ts'))
	.filter(file => !file.includes('__tests__'))
	.map(file => resolve(srcDir, file));

export default defineConfig({
	resolve: {
		alias: {
			'@': srcDir
		}
	},

	build: {
		sourcemap: true,
		lib: {
			entry,
			formats: ['es']
		},
		rollupOptions: {
			output: {
				preserveModules: true,
				preserveModulesRoot: 'src',
				entryFileNames: '[name].js'
			}
		}
	},
	plugins: [dts({ tsconfigPath: './tsconfig.app.json' })],

	server: {
		port: 8080,
		host: '127.0.0.1',
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		}
	},
	preview: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		}
	}
});
