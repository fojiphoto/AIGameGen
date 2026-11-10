import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'artifacts-pacmaze');
await mkdir(stage, { recursive: true });
await cp(join(import.meta.dirname, 'build', 'web'), join(stage, 'bundle'), { recursive: true });
const config = {
  meta: { title: 'Pac Maze', packageId: 'com.factorialstudio.pacmaze', orientation: 'sensorPortrait' },
  theme: { palette: { bg: '#080915', bgAccent: '#191b3c', ground: '#465eff', player: '#ffdf2b', obstacle: '#ff334f', accent: '#ffe4be' } },
};
await writeFile(join(stage, 'config.json'), JSON.stringify(config));
const result = spawnSync(process.execPath, [join(root, 'tools', 'build-apk.mjs'), stage], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
const out = join(import.meta.dirname, 'build', 'android');
await mkdir(out, { recursive: true });
await cp(join(stage, 'Pac-Maze.apk'), join(out, 'Pac-Maze.apk'));
