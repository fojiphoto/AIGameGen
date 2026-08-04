# Forge — AI 2D Game Generator

One command → a complete 2D game → a signed **offline Android APK**.

A working SaaS product running entirely on localhost: accounts, credits, an arcade with
remixing, an admin console, and a Gradle-free APK build pipeline.

- Product design: [docs/PRODUCT_DESIGN.md](docs/PRODUCT_DESIGN.md)
- Remaining-work plan: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- Frontend prompts: [docs/STITCH_PROMPTS.md](docs/STITCH_PROMPTS.md)

**Status:** local SaaS complete and verified — **58 unit tests + 77 end-to-end tests green**,
after one full audit→fix round that found and closed 4 high-severity defects
([details](#round-1-results)). One genre (Endless Runner) is live. Deployment, hosting and
real payments are deliberately deferred.

---

## Quick start

```bash
npm install
npm run build:engine
node apps/api/src/server.mjs
```

Open <http://localhost:8787>. A fresh install seeds three public demo games and prints an
admin login.

**Requirements:** Node ≥ 22, JDK 17+ (`JAVA_HOME`), Android SDK (`ANDROID_HOME`) with
build-tools and a platform. No Gradle, no Android Studio, no Capacitor, no database server.
`ANTHROPIC_API_KEY` is **optional** — see [Two execution modes](#two-execution-modes).

### Commands

```bash
npm test                                       # 58 unit tests
node tools/e2e.mjs                             # 67 integration tests (server must be running)
npm run build:engine                           # bundle the Phaser engine → dist/game.js
node tools/generate.mjs "<prompt>"             # CLI: prompt → validated bundle + ladder
node tools/build-apk.mjs artifacts/<gameId>    # CLI: signed APK
node tools/serve.mjs artifacts/<gameId>/bundle # preview one bundle
```

---

## What a visitor can actually do

Verified by `tools/e2e.mjs` on every run:

1. Land on a marketing page and play a real generated game immediately
2. Generate a game **without an account**, then have it claimed on signup
3. Sign up, receive 30 credits, watch real pipeline stages stream over SSE
4. Refine conversationally — "make it harder", "change to space theme", `mushkil banao` —
   **with no API key**
5. Inspect the 20-level difficulty ladder with per-level validation metrics
6. Build and download a **signed offline APK** in ~5 s, with install guidance
7. Publish to the arcade; a second account remixes it
8. Buy a credit pack (mocked) and see an append-only ledger
9. Be blocked when asking for copyrighted IP
10. Admin: moderate reports, monitor builds, review AI spend, read difficulty telemetry

---

## Architecture

```
packages/schema          Zod config + AI tool schemas  ← single source of truth
packages/generation      curve · level builder · validator · seeded PRNG
packages/ai              classify → config → repair → refine (+ deterministic planner & refiner)
packages/engine-runner   Phaser scenes, procedural textures, WebAudio, save, telemetry
packages/bundler         self-contained static bundle + offline assertion
packages/db              node:sqlite — users, sessions, credit ledger, games, builds, stats
apps/api                 Fastify: auth, routes, admin, SSE, build queue
apps/web                 multi-page frontend (landing, studio, dashboard, game, export,
                         arcade, billing, admin, legal)
android/                 AndroidManifest + WebView Activity
tools/                   generate · build-apk · serve · png · playtest-bot · e2e
.claude/agents/          code-auditor + fix-verifier
```

---

## Eight decisions worth knowing

### 1. The AI never writes game code

It emits a **validated JSON config**; the engine is hand-written and fixed. ~100% of
generated games are playable, ~80 ms per generation, ~$0.04 of tokens. `packages/schema` is
the single source of truth — one Zod definition produces the runtime validator **and** the
JSON Schema handed to Claude as a forced tool, so they cannot drift.

### 2. Every level is proven beatable before it ships

`packages/generation/src/validator.mjs` simulates each level headlessly against closed-form
jump physics: obstacle reachability, low-bar clearance, gap leapability, reaction time,
density, and the **dead zone** between "too close to land" and "too far to clear in one
jump". Failing levels are re-seeded (8 attempts), then difficulty-relaxed (3 bounded steps).
Enforced in CI across 40 prompts × 20 levels. **A refinement that would break beatability
is rejected, not shipped.**

### 3. The jump arc is closed-form, not integrated

`feetY(t) = feetY0 − (v0·t − ½·g·t²)`, evaluated directly. The validator's proof therefore
describes the game the player actually plays, and the jump is identical at 60 fps and at
30 fps on a cheap Android WebView.

### 4. No Gradle, no Capacitor

A generated game is one Activity, one WebView and static assets. Driving `aapt2` / `d8` /
`apksigner` directly gives **~5 s builds** and a 0.35 MB APK with no AGP upgrade treadmill.
Revisit when AdMob, IAP or Firebase is needed — that is what Gradle is good at.

### 5. Zero art files

Every sprite is drawn at boot from the config's 7-colour palette; SFX are synthesised with
WebAudio. Hence 0.35 MB, instant themeability, and no asset licences to audit.

### 6. Refinement patches, it doesn't regenerate

"Make it harder" produces an RFC-6902 patch against the existing config, preserving
everything the user liked and giving version history for free.

### 7. `node:sqlite` instead of a database server

Ships with Node ≥ 22: real transactions and foreign keys, zero dependencies, one file on
disk. The credit ledger is **append-only** — balances are derived, never edited, and a
reconciliation query asserts `SUM(delta) == latest.balance_after`.

### 8. Authorization is server-side, always

Every admin route sits behind a `requireAdmin` preHandler that reads the role from the
database. Ownership is checked in `assertCanEdit`/`assertCanView`. The frontend hiding a
button is decoration only — `tools/e2e.mjs` asserts a non-admin gets 403 from the API
directly. This project started by auditing a competitor whose admin gate was client-side;
not repeating that.

---

## Two execution modes

The whole product works with **no API key and no network**:

| | `ANTHROPIC_API_KEY` set | unset |
|---|---|---|
| Classify | Haiku 4.5 | keyword classifier |
| Config | Sonnet 5, forced tool-calling | rule-based planner + 12 curated palettes |
| Refine | Sonnet 5 → JSON Patch | rule-based refiner → same patch shape |
| Everything downstream | identical | identical |

The deterministic path is not a stub. It is the fallback when the model is down or its
output fails repair, it is what CI tests against, and for a zero-budget launch it is the
default. Suggested model: deterministic for free users ($0/game), AI for paid users
(~$0.04/game).

---

## Credits

| Action | Credits |
|---|---|
| Generate a game | 10 |
| Refine | 2 |
| Build APK | 15 |
| Rebuild the same version | 0 (idempotent) |
| Remix | 5 |

Signup grants 30. Charged **only on success**; a failed build refunds in full in the same
transaction. Checkout is mocked locally — a real Stripe webhook writes the same ledger row,
so switching it on is one handler.

---

## Verifying playability at runtime

`tools/playtest-bot.js` plays a generated game in the real Phaser engine, optimally, using
the same maths the validator uses. Serve a bundle, inject the file, then:

```js
FORGE_BOT.playAll()   // → { won: '20/20', failures: [] }
```

Verified against assets extracted from a built APK: **20/20 levels won, endless mode
1224 m** — the same bytes a phone runs. It also earned its keep by finding a validator hole
where a `low_bar` placed just after a jumpable obstacle was never checked, letting the
player be forced into it mid-air.

---

## The audit loop

Two subagents in `.claude/agents/`:

- **`code-auditor`** — read-only, adversarial, finds defects, fixes nothing. Given the
  codebase's invariants and an explicit list of what does *not* count as a finding.
- **`fix-verifier`** — independently verifies each finding, fixes only CONFIRMED ones,
  rejects false positives, and must prove each fix with tests.

The split exists because an auditor that also fixes will rationalise its own findings.
Invoke with the `Agent` tool, `code-auditor` first, then hand its report to `fix-verifier`.

### Round 1 results

The first pass over the SaaS layer found **4 high-severity defects, all real, all now fixed
with regression tests** in `tools/e2e.mjs`:

| Defect | Impact | Fix |
|---|---|---|
| Game id derived from `hashSeed(prompt)` with no owner scoping | Cross-tenant overwrite: a second account submitting the same prompt silently version-bumped and rewrote the first account's game — and was charged for a game it then got 403 on. Reproducible using a `/studio` example chip. | Id is now scoped to the owner, plus an ownership guard on the version-bump branch |
| Build queue deduped by key but the route charged first | A double-click charged 15 credits twice; the second build's worker — which contained the refund path — was silently discarded, leaving the row stuck at `queued` forever | Active build is detected *before* charging and returns the existing `buildId` |
| `/report` had no auth, no rate limit, no reporter de-dup | Three anonymous POSTs unpublished any public game | Rate limited, and de-duplicated per reporter so the threshold counts *distinct* people |
| `trustProxy: true` + `clientIp()` reading `x-forwarded-for` | Rotating the header gave unlimited free anonymous generation | `trustProxy` is env-gated (off by default) and `clientIp()` uses `req.ip` only |

Two of these violated stated invariants (credits charged only on success; authorization
server-side), which is exactly what the invariant list in the auditor's brief exists to
catch. Worth re-running the loop after any significant change.

---

## APK details

| | |
|---|---|
| Size | **0.35 MB** |
| Build time | **~5 s** |
| minSdk / targetSdk | 24 (Android 7.0) / 36 |
| Signing | v2 + v3, dev keystore auto-created at `android/keys/dev.keystore` |
| Permissions | **none — not even INTERNET** |

Assets are stored **flat** in `assets/`: aapt2's `-A` packaging emits OS-native separators
for nested asset paths on Windows, producing entries like `assets/public\index.html` that
`AssetManager` cannot resolve. The build asserts final entry names so this cannot regress.

**Installing:** Android 8+ requires allowing install from unknown sources. The export page
ships a 3-step guide; without it you will drown in support tickets.

---

## Before shipping to real users

1. **Replace the dev keystore.** `android/keys/dev.keystore` uses password `forgedev`.
   Production signing must come from a secret manager — losing the keystore means never
   being able to update a published app.
2. **Change `ADMIN_PASSWORD`.** The default seeded admin is `admin@factorialstudio.com` /
   `forge-admin-2026`.
3. **Test an APK on a physical device in airplane mode.** Everything here is verified in a
   headless browser and against the APK's own extracted bytes, but nothing substitutes for
   a real phone.
4. **Bundle brand fonts.** The engine uses a system font stack because Google Fonts would
   break the offline guarantee. Ship Bungee + Fredoka as local `woff2`.
5. **Set `NODE_ENV=production`** so cookies get the `secure` flag (off locally because
   localhost is http).

---

## Not built yet

| | Why |
|---|---|
| **Genres 2–5** (Tap-to-Fly, Platformer, Match-3, Bubble Pop) | Deferred. Needs `GameConfigSchema` converted to a discriminated union plus genre dispatch through `clampNumbers`, the planner, `buildGame`, textures, the engine registry, the bundler payload and the frontend picker. First task next session. |
| Real Stripe | Local demo uses a mock that writes the same ledger row |
| Deployment / hosting / domains | Owner's decision to defer |
| Play Store publishing (AAB) | Direct APK download is the shipping path |
| iOS export | Needs macOS + a paid Apple account |

Two files are the seams for leaving local dev: `packages/db/src/index.mjs`
(SQLite → Postgres) and `apps/api/src/queue.mjs` (in-process → BullMQ + Redis).
