import { build } from 'esbuild';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dirname;
const test = process.argv.includes('--test');
const out = join(root, 'build', test ? 'test' : 'web');
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src', test ? 'core.ts' : 'main.ts')],
  outfile: join(out, test ? 'core.mjs' : 'game.js'),
  bundle: true, format: test ? 'esm' : 'iife', target: 'es2020', minify: !test,
});
if (!test) {
  for (const file of ['index.html', 'style.css']) await copyFile(join(root, 'src', file), join(out, file));
  await cp(join(root, 'src', 'sfx'), join(out, 'sfx'), { recursive: true });
}
console.log('Bubble Reef built:', out);
