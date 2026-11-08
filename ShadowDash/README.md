# SHADOW DASH: Ninja Quest

Original local-first action platformer for Factorial Studio. Three handcrafted chapters, an animated ninja, sword combat and a grave guardian boss. TypeScript simulation, original Canvas2D presentation and DOM interfaces; no Unity install, network services or external assets needed.

## Build and play

From the repository root:

```powershell
& C:/dev/node/node.exe ShadowDash/build.mjs
& C:/dev/node/node.exe tools/serve-static.mjs ShadowDash/build/web 18888
```

Open http://127.0.0.1:18888 in a browser. Standard Node 22+ installations can use `node` instead of the absolute path.

```powershell
& C:/dev/node/node.exe ShadowDash/build.mjs --test
& C:/dev/node/node.exe --test 'ShadowDash/test/*.test.mjs'
& C:/dev/node/node.exe node_modules/typescript/bin/tsc --noEmit -p ShadowDash/tsconfig.json
```

## Android development APK

Use the existing repository WebView packaging toolchain:

```powershell
$env:JAVA_HOME='C:/dev/java/jdk-21.0.11+10'
$env:ANDROID_HOME='C:/dev/Android/Sdk'
& C:/dev/node/node.exe ShadowDash/apk.mjs
```

This uses the repository's development signing key. No store account required. A built APK still needs device testing before release.

## Forge Arcade

Run `npm run publish:shadowdash` from the repository root to check the game and regenerate the arcade site. The output includes `docs/play/shadow-dash/`, an embed page, and the arcade card. GitHub Pages serves the committed `docs/` directory on `main`.

To refresh the Android download, build the APK above and copy `ShadowDash/build/android/Shadow-Dash-Ninja-Quest.apk` to `assets/apk/shadow-dash.apk` before regenerating the site. The publisher preserves existing APK downloads on subsequent rebuilds.

## Controls

- A/D or arrows: move. Ctrl: sprint.
- Space: jump; hold for height, press again for air jump.
- J or left mouse: sword attack. Tap to chain strikes; hold and release to charge.
- K or Shift: dash. L: spirit attack. S/down: fast fall.
- Escape: pause.
- Touch controls support simultaneous movement, jump and attacks. Enable them in settings on a desktop for UI testing.

Lanterns are checkpoints. Crates/urns contain rewards. Strike switches to open their gates. Shield guards reward positioning or charged attacks. Watch enemy telegraphs rather than trading damage.

## Organization

`src/core` contains simulation, content definitions, progression and save logic. `src/render` owns original procedural artwork, parallax, animation and VFX. `src/shell` owns HTML/CSS and synthesized audio. `src/main.ts` maps input and hosts the fixed-step game loop and UI flow. Add stages through the level data; balance actors and attacks through definitions.

The game stores versioned progression in browser localStorage. Storage failure must not prevent play. Blades are cosmetic purchases using earned coins. There are no real ads or payment SDKs in this build.

For automated local inspection, `?test=1&level=0` starts a chapter directly. Level values are zero-based. `window.__SHADOW_DEBUG__` exposes a fresh read-only summary; it is not a gameplay control API.

## Verification scope

Use the parent delivery/test notes for actual executed results. Compilation and automated checks do not establish physical-device performance or all-level playability by themselves. Original music/SFX are synthesized through WebAudio and start after user interaction.
