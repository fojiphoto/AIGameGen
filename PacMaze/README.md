# PAC MAZE

A classic maze chase for Factorial Studio. Board 1 uses the familiar blue maze and 244 collectibles. Boards 2–40 rearrange routes through four districts. The ghosts close the speed gap, spend longer in chase mode, and recover sooner after each power pellet.

Play with arrow keys, WASD, a swipe across the maze, or the directional pad. Press Esc or P to pause. You start with three lives and gain one at 10,000 points. The arcade run saves at the start of each board. Practice lets you replay unlocked boards with a separate score.

The four ghosts have direct pursuit, ambush, flanking, and retreat behaviors. Power pellets temporarily make them vulnerable. Eaten ghosts return to the central house. Each board has a side tunnel and two bonus fruit opportunities.

## Run locally

From the workspace root with Node 22+:

```powershell
node PacMaze/build.mjs
node tools/serve-static.mjs PacMaze/build/web 18882
```

Open `http://127.0.0.1:18882/`. The web build uses local files and saves progress in the browser. The artwork and sound are drawn and synthesized in code.

## Verify and package

```powershell
node node_modules/typescript/bin/tsc -p PacMaze/tsconfig.json
node PacMaze/build.mjs --test
node --test PacMaze/test/game.test.mjs
node PacMaze/apk.mjs
```

The APK step uses the workspace Android SDK and Java configuration, and writes `PacMaze/build/android/Pac-Maze.apk`. The APK runs offline in portrait.

The tests check all 40 layouts, difficulty parameters, controls, ghost behavior, scoring, respawn, and storage. The campaign traversal test clears all 40 boards with ghosts held in their house to isolate layout and progression from combat. The first board was also checked interactively in the browser. Physical Android hardware and an unaided 40-board run were outside the verification completed for this build.
