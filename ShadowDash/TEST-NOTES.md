# Shadow Dash local verification — 2026-11-08

- TypeScript compilation passed.
- 16 simulation/save tests passed: movement, variable/double jump, dash cooldown, attack hit deduplication, shields, wall occlusion, lever, boss phases and damage, checkpoint safety, gap reach, retry, corrupt storage, upgrades and rewards.
- Browser smoke checks: menu, movement, jumping, sword attack, charged attack, dash, pause, settings, resume and touch buttons. Forest and graveyard rendered; fortress checked earlier. No captured browser warnings/errors during final smoke check.
- Landscape checked at 960 x 540; portrait checked at 390 x 844. Canvas now preserves 16:9 proportions instead of stretching. Landscape is recommended.
- Android APK rebuilt; package contents and v2/v3 signature verification passed. Offline package, no Android permissions.

Limits: this is a playable first local version using original procedural Canvas art, not a claim of AAA production art. Automated combat tests and browser smoke checks are not a complete manual three-chapter playthrough. Physical Android device performance, audio quality on speakers and simultaneous multi-finger hardware input remain unverified. No platform publication or store upload performed.

Source and run instructions: README.md. Browser output: build/web. Development APK: build/android/Shadow-Dash-Ninja-Quest.apk.
