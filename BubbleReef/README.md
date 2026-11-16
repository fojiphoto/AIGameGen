# Bubble Reef

Bubble Shooter with 100 boards across 10 underwater chapters. Aim and release to shoot, bank off the walls, and connect three same-color bubbles to pop them. Unsupported bubbles fall. The ceiling descends when the miss meter runs out. Clear the board to earn stars and unlock the next level.

Use mouse or touch to aim and release. On a keyboard, hold Left or Right to aim, press Space to shoot, X to swap with the next bubble, and Esc to pause. Bubble symbols can help distinguish colors. Level progress, stars, and settings save on the device.

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
