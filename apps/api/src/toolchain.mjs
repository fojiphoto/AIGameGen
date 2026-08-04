/**
 * Android toolchain detection.
 *
 * Why this exists: the web half of this product runs anywhere Node runs, but APK builds
 * need a JDK and the Android SDK. No free Node host ships those. Without this check, a
 * deployed instance offers a "BUILD APK" button that fails several seconds later with a
 * spawn error — which reads as a broken product rather than a missing dependency.
 *
 * So the server checks once at boot and tells the truth: the export page says APK builds
 * are unavailable and why, and the build endpoint refuses immediately instead of charging
 * credits for work it cannot do.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? `${n}.exe` : n);

function latest(dir, filter = () => true) {
  try {
    const entries = readdirSync(dir).filter(filter);
    entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    return entries[0] ?? null;
  } catch {
    return null;
  }
}

let cached = null;

/** @returns {{available:boolean, reason:string|null, java:string|null, buildTools:string|null, platform:string|null}} */
export function checkToolchain(force = false) {
  if (cached && !force) return cached;

  const javaHome = process.env.JAVA_HOME;
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;

  const missing = [];
  if (!javaHome || !existsSync(join(javaHome, 'bin', exe('java')))) missing.push('JAVA_HOME (a JDK 17+)');
  if (!androidHome || !existsSync(androidHome)) missing.push('ANDROID_HOME (the Android SDK)');

  let buildTools = null;
  let platform = null;
  if (androidHome && existsSync(androidHome)) {
    buildTools = process.env.BUILD_TOOLS_VERSION || latest(join(androidHome, 'build-tools'));
    platform = process.env.ANDROID_PLATFORM || latest(join(androidHome, 'platforms'), (d) => d.startsWith('android-'));
    if (!buildTools) missing.push('Android build-tools');
    if (!platform) missing.push('an Android platform (android-34 or newer)');
    if (buildTools) {
      const bt = join(androidHome, 'build-tools', buildTools);
      for (const [label, p] of [
        ['aapt2', join(bt, exe('aapt2'))],
        ['aapt', join(bt, exe('aapt'))],
        ['zipalign', join(bt, exe('zipalign'))],
        ['d8.jar', join(bt, 'lib', 'd8.jar')],
        ['apksigner.jar', join(bt, 'lib', 'apksigner.jar')],
      ]) {
        if (!existsSync(p)) missing.push(label);
      }
    }
  }

  cached = {
    available: missing.length === 0,
    reason: missing.length
      ? `APK export needs ${missing.join(', ')}. Games still generate and play in the browser.`
      : null,
    java: javaHome ?? null,
    buildTools,
    platform,
  };
  return cached;
}

/** Throw a clean 503 rather than letting a child process fail confusingly. */
export function assertToolchain() {
  const t = checkToolchain();
  if (t.available) return t;
  const e = new Error(t.reason);
  e.code = 'APK_TOOLCHAIN_MISSING';
  e.statusCode = 503;
  throw e;
}
