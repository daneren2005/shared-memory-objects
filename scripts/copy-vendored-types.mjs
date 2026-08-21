// `tsc --emitDeclarationOnly` generates declarations from .ts sources but never re-emits hand-written .d.ts
// inputs, so any vendored declaration under src/ (e.g. src/utils/typedarray.d.ts, whose types are referenced by
// the emitted memory-buffer.d.ts) would be missing from dist/.  This copies those hand-written declarations into
// dist/, preserving their path relative to src/ so they line up with the JS vite emits alongside them.
import { readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { resolve, dirname, relative } from 'node:path';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));

const vendoredDeclarations = readdirSync(srcDir, { recursive: true })
	.filter((file) => typeof file === 'string' && file.endsWith('.d.ts'))
	// vite-env.d.ts is just a build-time triple-slash reference and is not part of the published surface.
	.filter((file) => !file.endsWith('vite-env.d.ts'));

for(const file of vendoredDeclarations) {
	const from = resolve(srcDir, file);
	const to = resolve(distDir, relative(srcDir, from));
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}
