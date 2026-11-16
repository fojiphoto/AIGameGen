# Color Loop

Paper.io style territory capture with original toy mascots and bright paper arenas. Steer out of your territory to draw a ribbon. Reconnect to claim the enclosed area. Cut an exposed rival ribbon to eliminate that rider. Edges, bumpers, and crossing your own ribbon end the run.

- Campaign has 15 stages across three worlds, with territory targets from 12% to 50%. Later stages add rivals, faster AI, and bumpers.
- Endless has respawning AI rivals. Claim 100% of the playable cells to advance to the next island. Your best share is saved.
- Eight mascots can be unlocked through campaign clears and Endless records. Progress and sound preferences save locally.

Use arrow keys, WASD, drag gestures, or the on-screen direction buttons. Esc pauses or resumes. The match waits for your first steering input.

From the workspace root:

```powershell
node ColorLoop/build.mjs
node tools/serve-static.mjs ColorLoop/build/web 18883
```

Open `http://127.0.0.1:18883/`. To check the TypeScript and run the simulation tests:

```powershell
node node_modules/typescript/bin/tsc -p ColorLoop/tsconfig.json
node ColorLoop/build.mjs --test
node --test ColorLoop/test/game.test.mjs
```

Run `node ColorLoop/apk.mjs` after the web build with the workspace Java and Android SDK setup. The offline portrait APK is written to `ColorLoop/build/android/Color-Loop.apk`.
