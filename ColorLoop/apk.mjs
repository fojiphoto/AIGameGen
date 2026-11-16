import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'artifacts-colorloop');
await mkdir(stage, { recursive: true });
await cp(join(import.meta.dirname, 'build', 'web'), join(stage, 'bundle'), { recursive: true });
await writeFile(join(stage, 'config.json'), JSON.stringify({
  meta: { title: 'Color Loop', packageId: 'com.factorialstudio.colorloop', orientation: 'sensorPortrait' },
  theme: { palette: { bg: '#fff6e1', bgAccent: '#eedcfc', ground: '#c9f67d', player: '#5bcf36', obstacle: '#ae65ef', accent: '#fd83cb' } },
}));
const result = spawnSync(process.execPath, [join(root, 'tools', 'build-apk.mjs'), stage], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
const out = join(import.meta.dirname, 'build', 'android');
await mkdir(out, { recursive: true });
await cp(join(stage, 'Color-Loop.apk'), join(out, 'Color-Loop.apk'));
