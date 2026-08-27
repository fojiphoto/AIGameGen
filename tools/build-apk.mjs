#!/usr/bin/env node
/**
 * §D2 APK Build Worker — Gradle-free.
 *
 *   node tools/build-apk.mjs artifacts/<gameId>
 *
 * WHY NO GRADLE / CAPACITOR
 * A generated game is one Activity, one WebView and a folder of static assets.
 * Gradle + AGP would add a ~3.5 GB toolchain image, 60-120s per build, and a
 * permanent AGP-vs-Gradle version compatibility tax — to orchestrate three
 * commands we can call directly. Driving aapt2 / d8 / apksigner ourselves gives:
 *
 *   • ~5-10s builds instead of 60-120s
 *   • no Node/npm/Capacitor in the build image
 *   • no AGP upgrade treadmill
 *   • byte-reproducible output
 *
 * The tradeoff: no Gradle plugin ecosystem. The moment this app needs AdMob, IAP
 * or Firebase, revisit — that is what Gradle is actually good at.
 *
 * PIPELINE
 *   patch manifest+java → icons → javac → d8 → aapt2 compile → aapt2 link
 *   → add dex → zipalign → apksigner sign → apksigner verify
 */

import { spawnSync } from 'node:child_process';
import {
  mkdir, writeFile, readFile, rm, cp, stat, readdir,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { renderIcon, MIPMAPS } from './png.mjs';

// ── environment ─────────────────────────────────────────────────────────────

const JAVA_HOME = process.env.JAVA_HOME;
const ANDROID_HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const BUILD_TOOLS_VERSION = process.env.BUILD_TOOLS_VERSION || null;
const PLATFORM = process.env.ANDROID_PLATFORM || null;

const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? `${n}.exe` : n);
const bat = (n) => (isWin ? `${n}.bat` : n);

function die(msg) {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
}

if (!JAVA_HOME || !existsSync(JAVA_HOME)) die(`JAVA_HOME is not set or missing: ${JAVA_HOME}`);
if (!ANDROID_HOME || !existsSync(ANDROID_HOME)) die(`ANDROID_HOME is not set or missing: ${ANDROID_HOME}`);

async function pickLatest(dir, filter = () => true) {
  const entries = (await readdir(dir)).filter(filter);
  // numeric-aware descending sort so "36.0.0" beats "9.0.0"
  entries.sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })
  );
  return entries[0];
}

const btVersion =
  BUILD_TOOLS_VERSION || (await pickLatest(join(ANDROID_HOME, 'build-tools')));
const platform =
  PLATFORM || (await pickLatest(join(ANDROID_HOME, 'platforms'), (d) => d.startsWith('android-')));

const BT = join(ANDROID_HOME, 'build-tools', btVersion);
const ANDROID_JAR = join(ANDROID_HOME, 'platforms', platform, 'android.jar');
const AAPT2 = join(BT, exe('aapt2'));
const AAPT = join(BT, exe('aapt'));
const ZIPALIGN = join(BT, exe('zipalign'));
const JAVA = join(JAVA_HOME, 'bin', exe('java'));
const JAVAC = join(JAVA_HOME, 'bin', exe('javac'));
const KEYTOOL = join(JAVA_HOME, 'bin', exe('keytool'));

/**
 * d8 and apksigner ship as .bat/.sh wrappers around a jar. We invoke the jars
 * through `java` directly instead:
 *   • Node >=20 refuses to spawnSync a .bat without shell:true (CVE-2024-27980),
 *     and shell:true drags in Windows quoting rules for every path argument
 *   • calling the jar is identical on Windows and on a Linux build worker
 */
const D8_JAR = join(BT, 'lib', 'd8.jar');
const APKSIGNER_JAR = join(BT, 'lib', 'apksigner.jar');
const d8Cmd = (args) => [JAVA, ['-cp', D8_JAR, 'com.android.tools.r8.D8', ...args]];
const apksignerCmd = (args) => [JAVA, ['-jar', APKSIGNER_JAR, ...args]];

for (const [label, p] of [
  ['aapt2', AAPT2], ['aapt', AAPT], ['zipalign', ZIPALIGN],
  ['java', JAVA], ['javac', JAVAC], ['keytool', KEYTOOL],
  ['d8.jar', D8_JAR], ['apksigner.jar', APKSIGNER_JAR],
  ['android.jar', ANDROID_JAR],
]) {
  if (!existsSync(p)) die(`${label} not found at ${p}`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  if (r.error) throw new Error(`${basename(cmd)} failed to spawn: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `${basename(cmd)} exited ${r.status}\n` +
        `  cmd: ${cmd} ${args.join(' ')}\n` +
        `${(r.stderr || r.stdout || '').split('\n').slice(0, 25).map((l) => '  ' + l).join('\n')}`
    );
  }
  return (r.stdout || '') + (r.stderr || '');
}

const stages = [];
async function stage(name, fn) {
  const t = Date.now();
  process.stdout.write(`  ${name.padEnd(22)}`);
  try {
    const out = await fn();
    const ms = Date.now() - t;
    stages.push({ name, ms });
    console.log(`\x1b[32mok\x1b[0m  \x1b[2m${ms}ms\x1b[0m${out ? '  ' + out : ''}`);
  } catch (err) {
    console.log(`\x1b[31mFAILED\x1b[0m`);
    throw err;
  }
}

// ── inputs ──────────────────────────────────────────────────────────────────

const gameDir = resolve(process.argv[2] ?? die('usage: build-apk.mjs <artifacts/gameId>'));
const bundleDir = join(gameDir, 'bundle');
const configPath = join(gameDir, 'config.json');

if (!existsSync(bundleDir)) die(`no bundle at ${bundleDir} — run tools/generate.mjs first`);
if (!existsSync(configPath)) die(`no config.json at ${configPath}`);

const config = JSON.parse(await readFile(configPath, 'utf8'));
const pkg = config.meta.packageId;
const label = config.meta.title;
/**
 * Portrait games exist, and locking one to landscape ships a tall sliver between two black
 * bars. Whoever stages the bundle knows the aspect ratio, so they pass it through.
 */
const orientation = config.meta.orientation || 'sensorLandscape';
const versionCode = Number(process.env.VERSION_CODE || 1);
const versionName = process.env.VERSION_NAME || '1.0.0';

const ROOT = resolve(import.meta.dirname, '..');
const TEMPLATE = join(ROOT, 'android');
const work = join(gameDir, 'android-build');
const outApk = join(gameDir, `${sanitize(config.meta.title)}.apk`);

function sanitize(s) {
  return String(s).trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
}

console.log(`\n\x1b[1mFORGE — build apk\x1b[0m`);
console.log(`game      ${label}`);
console.log(`package   ${pkg}`);
console.log(`toolchain build-tools ${btVersion} · ${platform} · jdk ${javaVersion()}\n`);

function javaVersion() {
  const out = run(join(JAVA_HOME, 'bin', exe('java')), ['-version']);
  const m = out.match(/version "([^"]+)"/);
  return m ? m[1] : '?';
}

const t0 = Date.now();

/** Every file under `dir`, as slash-separated paths relative to it. */
async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/** Asset paths that live in a subdirectory, appended after the link step. See below. */
const nestedAssets = [];

// ── 1. workspace ────────────────────────────────────────────────────────────

const pkgPath = pkg.split('.').join('/');
let srcFile;

await stage('workspace', async () => {
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, 'src', pkgPath), { recursive: true });
  await mkdir(join(work, 'classes'), { recursive: true });
  await mkdir(join(work, 'dex'), { recursive: true });
  await mkdir(join(work, 'assets'), { recursive: true });
  await mkdir(join(work, 'res'), { recursive: true });

  /**
   * Assets are split in two, and the reason is a real Windows defect rather than taste.
   *
   * aapt2's `-A` writes OS-native separators for *nested* asset paths on Windows, producing zip
   * entries like "assets/runtime\main.wasm" that AssetManager cannot resolve — a build that
   * succeeds and a game that shows a blank screen. So only the top level goes through `-A`;
   * anything in a subdirectory is appended afterwards with `aapt add`, which stores the path
   * exactly as given and therefore keeps forward slashes on every platform.
   *
   * Most games are flat and never touch the second path at all. The ones that are not are the
   * WebAssembly games, whose runtime is a tree of several hundred files.
   */
  for (const rel of await listFiles(bundleDir)) {
    const src = join(bundleDir, rel);
    if (rel.includes('/')) {
      nestedAssets.push(rel);
      const dest = join(work, 'nested', 'assets', rel);
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest);
    } else {
      await cp(src, join(work, 'assets', rel));
    }
  }

  const manifest = (await readFile(join(TEMPLATE, 'AndroidManifest.xml'), 'utf8'))
    .replaceAll('__PACKAGE__', pkg)
    .replaceAll('__LABEL__', escapeXml(label))
    .replaceAll('__VERSION_CODE__', String(versionCode))
    .replaceAll('__VERSION_NAME__', versionName)
    .replaceAll('__ORIENTATION__', orientation);
  await writeFile(join(work, 'AndroidManifest.xml'), manifest, 'utf8');

  const java = (await readFile(join(TEMPLATE, 'java', 'MainActivity.java'), 'utf8'))
    .replaceAll('__PACKAGE__', pkg);
  srcFile = join(work, 'src', pkgPath, 'MainActivity.java');
  await writeFile(srcFile, java, 'utf8');
  return '';
});

// ── 2. icons ────────────────────────────────────────────────────────────────

await stage('icons', async () => {
  for (const [dir, size] of MIPMAPS) {
    await mkdir(join(work, 'res', dir), { recursive: true });
    await writeFile(join(work, 'res', dir, 'ic_launcher.png'), renderIcon(size, config.theme.palette));
  }
  return `${MIPMAPS.length} densities`;
});

// ── 3. javac ────────────────────────────────────────────────────────────────

await stage('javac', () => {
  // -source/-target 17: d8 is happiest with <=17 bytecode, and nothing here needs
  // newer language features. -Xlint:-options silences the bootclasspath notice.
  run(JAVAC, [
    '-source', '17', '-target', '17',
    '-Xlint:-options', '-nowarn',
    '-classpath', ANDROID_JAR,
    '-d', join(work, 'classes'),
    srcFile,
  ]);
  return '';
});

// ── 4. d8 → classes.dex ─────────────────────────────────────────────────────

await stage('d8 (dex)', async () => {
  const classDir = join(work, 'classes', pkgPath);
  const classes = (await readdir(classDir))
    .filter((f) => f.endsWith('.class'))
    .map((f) => join(classDir, f));
  run(...d8Cmd([
    '--release',
    '--min-api', '24',
    '--lib', ANDROID_JAR,
    '--output', join(work, 'dex'),
    ...classes,
  ]));
  const s = await stat(join(work, 'dex', 'classes.dex'));
  return `${(s.size / 1024).toFixed(0)} KB`;
});

// ── 5. aapt2 compile resources ──────────────────────────────────────────────

await stage('aapt2 compile', () => {
  run(AAPT2, ['compile', '--dir', join(work, 'res'), '-o', join(work, 'res.zip')]);
  return '';
});

// ── 6. aapt2 link (packages assets) ─────────────────────────────────────────

const baseApk = join(work, 'base.apk');
await stage('aapt2 link', () => {
  run(AAPT2, [
    'link',
    '-o', baseApk,
    '-I', ANDROID_JAR,
    '--manifest', join(work, 'AndroidManifest.xml'),
    '-R', join(work, 'res.zip'),
    '--auto-add-overlay',
    '-A', join(work, 'assets'),
  ]);
  return '';
});

// ── 6b. nested assets ───────────────────────────────────────────────────────

if (nestedAssets.length) {
  await stage('add nested assets', () => {
    // In batches: a WebAssembly runtime is several hundred files, and one `aapt add` per file
    // would spend more time starting processes than writing zip entries. The paths are passed
    // with forward slashes and stored verbatim, which is the whole point of doing it here
    // rather than through aapt2's -A.
    const cwd = join(work, 'nested');
    for (let i = 0; i < nestedAssets.length; i += 60) {
      const batch = nestedAssets.slice(i, i + 60).map((rel) => `assets/${rel}`);
      run(AAPT, ['add', '-f', baseApk, ...batch], { cwd });
    }
    return `${nestedAssets.length} files`;
  });
}

// ── 7. inject classes.dex ───────────────────────────────────────────────────

await stage('add dex', () => {
  // aapt2 link cannot embed dex; `aapt add` appends into the zip. cwd matters —
  // the entry is stored under the path given, so it must be a bare filename.
  run(AAPT, ['add', '-f', baseApk, 'classes.dex'], { cwd: join(work, 'dex') });
  return '';
});

// ── 8. zipalign ─────────────────────────────────────────────────────────────

const alignedApk = join(work, 'aligned.apk');
await stage('zipalign', () => {
  run(ZIPALIGN, ['-p', '-f', '4', baseApk, alignedApk]);
  return '';
});

// ── 9. keystore ─────────────────────────────────────────────────────────────

const keysDir = join(TEMPLATE, 'keys');
const ksPath = process.env.KEYSTORE_PATH || join(keysDir, 'dev.keystore');
const ksPass = process.env.KEYSTORE_PASSWORD || 'forgedev';
const keyAlias = process.env.KEY_ALIAS || 'forge';
const keyPass = process.env.KEY_PASSWORD || ksPass;

await stage('keystore', async () => {
  if (existsSync(ksPath)) return 'reused';
  await mkdir(keysDir, { recursive: true });
  // DEV ONLY. Production signing must use a keystore from a secret manager —
  // losing it means never being able to update a published app again.
  run(KEYTOOL, [
    '-genkeypair', '-v',
    '-keystore', ksPath,
    '-alias', keyAlias,
    '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '10950',
    '-storepass', ksPass, '-keypass', keyPass,
    '-dname', 'CN=Factorial Studio Forge Dev, O=Factorial Studio, C=PK',
  ]);
  return 'created (dev)';
});

// ── 10. sign + verify ───────────────────────────────────────────────────────

await stage('apksigner sign', () => {
  run(...apksignerCmd([
    'sign',
    '--ks', ksPath,
    '--ks-pass', `pass:${ksPass}`,
    '--key-pass', `pass:${keyPass}`,
    '--ks-key-alias', keyAlias,
    '--min-sdk-version', '24',
    '--out', outApk,
    alignedApk,
  ]));
  return '';
});

let verifyOut = '';
await stage('apksigner verify', () => {
  verifyOut = run(...apksignerCmd(['verify', '--verbose', '--print-certs', outApk]));
  const schemes = ['v1', 'v2', 'v3', 'v4']
    .filter((v) => new RegExp(`APK Signature Scheme ${v}\\b.*true`, 'i').test(verifyOut))
    .join('+');
  return schemes ? `signed ${schemes}` : 'verified';
});

// ── 11. structural verification ─────────────────────────────────────────────
// The build can "succeed" and still ship a blank screen: a mis-named asset entry,
// a missing dex, or an accidentally added permission. Assert the invariants that
// actually determine whether the APK works on a device.

let declaredPerms = [];
await stage('verify contents', () => {
  const entries = run(AAPT, ['list', outApk]).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const problems = [];

  const bad = entries.filter((e) => e.includes('\\'));
  if (bad.length) {
    problems.push(
      `${bad.length} zip entr${bad.length === 1 ? 'y' : 'ies'} contain a backslash and will be ` +
        `unreachable at runtime (e.g. "${bad[0]}")`
    );
  }

  for (const required of ['assets/index.html', 'classes.dex', 'resources.arsc', 'AndroidManifest.xml']) {
    if (!entries.includes(required)) problems.push(`missing required entry: ${required}`);
  }

  /**
   * The page must bring its scripts with it.
   *
   * This used to require `assets/game.js` by name, which quietly assumed every game came out of
   * the generator. It did not: the hand-built ones ship `app.js` and `engine.js`. What actually
   * matters is that every local script the page asks for is inside the APK — a missing one is a
   * blank screen on a device and nothing at all in this log.
   *
   * The distinction that matters is between a file *packaging dropped* and one that was never
   * there to begin with. A WebAssembly loader probes for optional pieces that are 404 on the
   * live site too, and reproducing that faithfully is correct behaviour, not a defect. So a
   * reference with no matching file in the input bundle is a note; a file that was in the bundle
   * and is not in the APK is a build failure.
   */
  const html = readFileSync(join(work, 'assets', 'index.html'), 'utf8');
  const wanted = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !/^(https?:)?\/\//.test(src));
  const optional = [];
  for (const src of wanted) {
    // Absolute, relative and double-slashed forms all name the same asset. Normalise the way
    // the app's own asset server does, or this check reports files that are really there.
    const clean = src.split(/[?#]/)[0].replace(/^\.\//, '').replace(/\/+/g, '/').replace(/^\//, '');
    if (entries.includes(`assets/${clean}`)) continue;
    if (existsSync(join(bundleDir, clean))) {
      problems.push(`packaging dropped assets/${clean}, which index.html loads`);
    } else {
      optional.push(clean);
    }
  }
  if (!entries.some((e) => /^assets\/.+\.js$/.test(e))) {
    problems.push('no JavaScript in assets — the APK would open to a blank page');
  }
  if (optional.length) {
    console.log(
      `
  [33mnote[0m ${optional.length} script${optional.length === 1 ? '' : 's'} ` +
      `referenced by the page but absent from the bundle, exactly as on the website: ` +
      `${optional.join(', ')}`
    );
  }

  for (const rel of nestedAssets) {
    if (!entries.includes(`assets/${rel}`)) problems.push(`nested asset dropped: assets/${rel}`);
  }

  const icons = entries.filter((e) => /^res\/mipmap-.*ic_launcher\.png$/.test(e));
  if (icons.length < MIPMAPS.length) {
    problems.push(`only ${icons.length}/${MIPMAPS.length} launcher icon densities present`);
  }

  // permissions read from the built APK, not from our own template
  declaredPerms = run(AAPT, ['dump', 'permissions', outApk])
    .split(/\r?\n/)
    .filter((l) => l.includes('uses-permission'))
    .map((l) => l.trim());

  const badging = run(AAPT, ['dump', 'badging', outApk]);
  if (!new RegExp(`launchable-activity: name='${pkg.replace(/\./g, '\\.')}\\.MainActivity'`).test(badging)) {
    problems.push('no launchable activity — the app would install but not appear in the launcher');
  }
  if (!badging.includes(`package: name='${pkg}'`)) problems.push(`package id mismatch in built APK`);

  if (problems.length) {
    throw new Error(`APK failed structural verification:\n${problems.map((p) => '  - ' + p).join('\n')}`);
  }
  return `${entries.length} entries, ${icons.length} icons`;
});

// ── report ──────────────────────────────────────────────────────────────────

const apkStat = await stat(outApk);
const total = Date.now() - t0;

console.log(`\n\x1b[32m✓ APK built in ${(total / 1000).toFixed(1)}s\x1b[0m`);
console.log(`  file     ${outApk}`);
console.log(`  size     ${(apkStat.size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  package  ${pkg}`);
console.log(`  version  ${versionName} (${versionCode})`);
console.log(`  minSdk   24 (Android 7.0)   targetSdk 36`);

console.log(
  `  perms    ${
    declaredPerms.length
      ? `\x1b[33m${declaredPerms.length} declared\x1b[0m — ${declaredPerms.join(', ')}`
      : 'none — fully offline'
  }`
);

console.log(`\n\x1b[2mstages\x1b[0m`);
for (const s of stages) console.log(`  ${s.name.padEnd(22)} ${String(s.ms).padStart(6)}ms`);

console.log(`\n\x1b[2minstall on a device:\x1b[0m`);
console.log(`  adb install -r "${outApk}"\n`);

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}
