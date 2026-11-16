import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'artifacts-bubblereef');
await mkdir(stage, { recursive: true });
await cp(join(import.meta.dirname, 'build', 'web'), join(stage, 'bundle'), { recursive: true });
await writeFile(join(stage, 'config.json'), JSON.stringify({
  meta: { title: 'Bubble Reef', packageId: 'com.factorialstudio.bubblereef', orientation: 'sensorPortrait' },
  theme: { palette: { bg: '#194da0', bgAccent: '#453478', ground: '#ffd567', player: '#159bea', obstacle: '#cd32f1', accent: '#ffc321' } },
}));
const env = { VERSION_CODE: '2', VERSION_NAME: '1.1.0', ...process.env };
const result = spawnSync(process.execPath, [join(root, 'tools', 'build-apk.mjs'), stage], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
const out = join(import.meta.dirname, 'build', 'android');
await mkdir(out, { recursive: true });
await cp(join(stage, 'Bubble-Reef.apk'), join(out, 'Bubble-Reef.apk'));
