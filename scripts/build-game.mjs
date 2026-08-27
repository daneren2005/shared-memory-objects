// Copies the freshly built `dist/` into a sibling game repo's node_modules so the
// game picks up local ECS changes without a publish. Usage:
//   npm run build:game -- <game-repo-name>
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const game = process.argv[2];
if(!game) {
	console.error('Usage: npm run build:game -- <game-repo-name>');
	process.exit(1);
}

const source = resolve(repoRoot, 'dist');
if(!existsSync(source)) {
	console.error(`No build output at ${source}. Run the build first.`);
	process.exit(1);
}

const target = resolve(repoRoot, '..', game, 'node_modules', '@daneren2005', 'shared-memory-objects', 'dist');
const gameRoot = resolve(repoRoot, '..', game);
if(!existsSync(gameRoot)) {
	console.error(`Sibling game repo not found at ${gameRoot}.`);
	process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
// oxlint-disable-next-line
console.log(`Copied dist -> ${target}`);
