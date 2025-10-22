import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
// @ts-expect-error
import dts from 'unplugin-dts/vite';

export default defineConfig({
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url))
		}
	},

	build: {
		lib: {
			entry: resolve(__dirname, 'src/main.ts'),
			name: 'SharedMemoryObjects',
			fileName: 'shared-memory-objects'
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
