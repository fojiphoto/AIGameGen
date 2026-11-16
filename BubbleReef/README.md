# Bubble Reef

Bubble Shooter with a 100-level campaign and an Endless survival mode. Aim and release to shoot, bank off the walls, and connect three same-color bubbles to pop them. Unsupported bubbles fall. In Campaign, misses lower the ceiling. Clear the board to earn stars and unlock the next level. In Endless, new rows arrive faster as you survive. The run ends when a bubble reaches the dashed line.

Use mouse or touch to aim and release. The magician shoots the top bubble in the triangle, and the panda feeds the next one. Tap a reserve bubble to load it. Right-click the arena or press X to rotate all three colors. On a keyboard, hold Left or Right to aim, press Space to shoot, and Esc to pause. Bubble symbols can help distinguish colors. Level progress, stars, the Endless high score, and settings save on the device.

From the workspace root with Node 22 or later:

```powershell
node BubbleReef/build.mjs
node tools/serve-static.mjs BubbleReef/build/web 18884
```

Open `http://127.0.0.1:18884/`. The signed Android build also works offline in portrait orientation. Run `node BubbleReef/apk.mjs` after the web build with Java and the Android SDK configured. The APK is written to `BubbleReef/build/android/Bubble-Reef.apk`.

```powershell
node node_modules/typescript/bin/tsc -p BubbleReef/tsconfig.json
node BubbleReef/build.mjs --test
node --test BubbleReef/test/game.test.mjs
```

Campaign verification uses the same shot trajectory, colors, swap, and ceiling pressure rules as the playable build. It finds a winning sequence for every board.
