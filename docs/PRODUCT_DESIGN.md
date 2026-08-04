# Product Design Document — AI 2D Game Generator

**Codename:** Forge (placeholder — final brand TBD)
**Owner:** Factorial Studio Gaming
**Version:** 1.1
**Date:** 2026-08-03
**Status:** Phases 0–1 built and verified; the local SaaS layer (auth, credits, arcade,
admin, telemetry) is also built. Genres 2–5 are the remaining scope.
See [../README.md](../README.md) for what runs today and
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for how the SaaS layer was completed.

| Layer | Status |
|---|---|
| A — Genre engines | 🟡 1 of 5 (Endless Runner + endless mode) |
| B — AI orchestration | ✅ incl. deterministic planner **and** deterministic refiner |
| C — Generation core | ✅ curve, builder, validator, determinism |
| D — Build & distribution | ✅ Gradle-free APK, queue, signing, download |
| E — Frontend surfaces | ✅ landing, auth, studio, dashboard, game, export, arcade, billing, admin, legal |
| F — Platform & data | ✅ `node:sqlite`, append-only ledger, telemetry, rate limits, sessions |
| G — Trust & safety | ✅ IP blocklist, moderation queue, terms/privacy, consent gate |
| H — Business model | ✅ credits + mock checkout (real Stripe deferred) |

Deviations from this document, made during implementation and documented in the README:
**no Capacitor and no Gradle** (direct `aapt2`/`d8`/`apksigner`, ~5 s builds),
**no asset files** (procedural rendering from the palette), and
**`node:sqlite` instead of Postgres** for the local build.

---

## Table of Contents

1. [Product Definition](#1-product-definition)
2. [Core Architectural Decision](#2-core-architectural-decision)
3. [Module Map — Full Brainstorm](#3-module-map--full-brainstorm)
4. [Layer A — Genre Engines](#layer-a--genre-engines)
5. [Layer B — AI Orchestration](#layer-b--ai-orchestration)
6. [Layer C — Generation Core](#layer-c--generation-core)
7. [Layer D — Build & Distribution](#layer-d--build--distribution)
8. [Layer E — Frontend Surfaces](#layer-e--frontend-surfaces)
9. [Layer F — Platform & Data](#layer-f--platform--data)
10. [Layer G — Trust, Safety & Legal](#layer-g--trust-safety--legal)
11. [Layer H — Business Model](#layer-h--business-model)
12. [Technology Stack](#12-technology-stack)
13. [Repository Structure](#13-repository-structure)
14. [Unit Economics](#14-unit-economics)
15. [Build vs Buy](#15-build-vs-buy)
16. [Execution Roadmap](#16-execution-roadmap)
17. [Risk Register](#17-risk-register)
18. [Definition of Done — MVP](#18-definition-of-done--mvp)

---

## 1. Product Definition

### One-line

> A platform where one natural-language command produces a complete, polished 2D game — playable instantly in the browser, and downloadable as a signed offline Android APK.

### The three promises

| Promise | Why it matters | How we deliver |
|---|---|---|
| **One command → full game** | Zero learning curve. No engine, no code, no art skills. | Template + AI-config architecture (§2) |
| **20 levels with real progression** | A "game", not a tech demo. Easy → hard, always beatable. | Deterministic level builder + solvability validator (§C3, §C4) |
| **Downloadable offline APK** | The differentiator. Play anywhere, no internet, share the file. | Capacitor + Gradle build pipeline (§D2) |

### Target users

| Segment | Need | Willingness to pay |
|---|---|---|
| **Hobbyists / creators** | "I have a game idea, I can't code" | Low–Medium (credits) |
| **Content creators / streamers** | Custom game for a video/audience | Medium |
| **Small studios / agencies** | Fast prototypes for clients | High |
| **Educators / students** | Teaching game design without coding | Low (volume) |
| **Marketers** | Branded mini-game for a campaign | High |

### Explicit non-goals (v1)

Keeping this list honest protects the schedule.

- ❌ 3D games
- ❌ Multiplayer / networking
- ❌ iOS builds (requires macOS + $99/yr Apple account + notarization)
- ❌ Steam / desktop builds
- ❌ AI writing arbitrary game code (Pro-tier, later)
- ❌ In-game ad monetization for creators
- ❌ Google Play auto-publishing
- ❌ Full visual level editor (drag-drop tile painting)

---

## 2. Core Architectural Decision

**This is the single most important decision in the document. Everything else follows from it.**

### The wrong way: AI generates game code

Ask an LLM to write a complete Phaser game from a prompt. Works in a demo, fails as a product.

- Games crash or have subtly broken physics
- 20 levels come out inconsistent — level 7 harder than level 15
- 2–4 minutes of generation per game
- Every re-roll costs real money
- Impossible to debug: each game is unique code

### The right way: hand-crafted engines + AI-generated config

We build **5 polished, tested game engines by hand**. The AI never writes game code. Its only job is to read the user's prompt and emit a **validated JSON config** — theme, colors, physics constants, obstacle mix, difficulty curve.

```
Engine  = fixed, hand-crafted, tested   (written once, by us)
Config  = variable, AI-generated        (written per game, by Claude)
Levels  = deterministic from config+seed (written by code, not AI)
```

### Comparison

| Dimension | AI writes code | **Template + AI config** ✅ |
|---|---|---|
| Reliability | ~60% playable | **~100% playable** |
| Generation time | 2–4 min | **3–8 sec** |
| AI cost per game | $0.30–1.00 | **~$0.04** |
| Difficulty tuning | random | **exact, formula-driven** |
| Debuggability | every game unique | **one engine, one bug fix** |
| Art consistency | chaotic | **curated, professional** |
| Adding a genre | N/A | **plug in a new engine** |

### The tradeoff we accept

Users cannot invent genuinely novel mechanics in v1. They get deep customization *within* 5 genres. This is the correct tradeoff: 95% of users want "Flappy Bird but cyberpunk with my logo", not a new genre. Novel mechanics become a **Pro tier** feature later, built on this same foundation.

### Determinism requirement

`config + seed` **must always** produce a byte-identical game. This unlocks:

- Reproducible builds (rebuild an old game exactly)
- Caching (same input → skip generation)
- Shareable seeds
- Debuggable bug reports ("game X level 12 is broken" → reproduce exactly)

**Rule:** no `Math.random()` anywhere in generation. All randomness flows through a seeded PRNG (`mulberry32` or `xoshiro128`).

---

## 3. Module Map — Full Brainstorm

Every module in the system, grouped by layer. Each gets a detailed section below.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER E — FRONTEND SURFACES                                    │
│  E1 Marketing  E2 Auth/Onboarding  E3 Prompt Studio             │
│  E4 Tweak Panel  E5 Web Player  E6 My Games  E7 Export Center   │
│  E8 Arcade/Community  E9 Billing  E10 Admin Console             │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  LAYER B — AI ORCHESTRATION                                     │
│  B1 Intent Classifier   B2 Config Generator   B3 Schema Repair  │
│  B4 Asset Resolver      B5 Copy Generator     B6 Safety Filter  │
│  B7 Refinement Engine   B8 Cost Governor                        │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  LAYER C — GENERATION CORE  (pure code, no AI)                  │
│  C1 Engine Registry   C2 Difficulty Curve   C3 Level Builder    │
│  C4 Level Validator   C5 Asset Pipeline     C6 Bundler          │
│  C7 Seed/Determinism                                            │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  LAYER A — GENRE ENGINES  (hand-crafted Phaser)                 │
│  A1 Endless Runner  A2 Tap-to-Fly  A3 Platformer                │
│  A4 Match-3         A5 Bubble Pop                               │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  LAYER D — BUILD & DISTRIBUTION                                 │
│  D1 Web Publisher  D2 APK Build Worker  D3 Signing Service      │
│  D4 Build Queue    D5 Artifact Storage  D6 Download Delivery    │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│  LAYER F — PLATFORM & DATA          LAYER G — TRUST & SAFETY    │
│  F1 Database      F2 Credit Ledger   G1 IP/Trademark Filter     │
│  F3 Object Store  F4 Analytics       G2 Content Moderation      │
│  F5 Rate Limiting F6 Observability   G3 Terms / IP Ownership     │
│  F7 Job Orchestrator                 G4 Privacy / GDPR          │
└─────────────────────────────────────────────────────────────────┘
                    LAYER H — BUSINESS MODEL
```

### End-to-end request flow

```
User: "neon cyberpunk endless runner with a robot, make it hard"
   │
   ├─▶ [G1] Safety filter ─── blocked? → reject with reason
   │
   ├─▶ [B1] Intent Classifier (Haiku 4.5)
   │        → { genre: "endless_runner", theme: "cyberpunk",
   │            difficulty_bias: "hard", subject: "robot" }
   │
   ├─▶ [B2] Config Generator (Sonnet 5, structured output)
   │        → GameConfig JSON
   │        └─▶ [B3] Schema validate → invalid? repair loop (max 2 retries)
   │
   ├─▶ [B4] Asset Resolver → match sprite pack by style_tags + palette
   ├─▶ [B5] Copy Generator → title, level names, tutorial hints
   │
   ├─▶ [C2] Difficulty Curve → per-level parameters (levels 1–20)
   ├─▶ [C3] Level Builder → 20 levels from config + seed
   ├─▶ [C4] Level Validator → each level solvable? no → re-seed that level
   │
   ├─▶ [C5] Asset Pipeline → atlas pack, WebP, audio sprite
   ├─▶ [C6] Bundler → static bundle (index.html + game.js + assets/)
   │
   ├─▶ [D1] Web Publisher → CDN URL ──▶ 🎮 PLAY NOW (3–8 sec total)
   │
   └─▶ [D4] Build Queue (user clicks "Export APK")
            └─▶ [D2] APK Worker → Capacitor → Gradle
                     └─▶ [D3] Sign → [D5] Store → 📦 APK DOWNLOAD (60–120s)
```

---

## Layer A — Genre Engines

Hand-crafted Phaser 3 games. Written once, reused for every generated game.

### The Engine Interface — the key abstraction

Every genre implements this contract. Adding genre #6 becomes a plug-in, not a rewrite.

```ts
interface GenreEngine {
  id: GenreId                          // "endless_runner"
  displayName: string                  // "Endless Runner"  (never "Chrome Dino")

  configSchema: JSONSchema             // what the AI must produce
  configDefaults: Partial<GameConfig>  // safe fallbacks

  /** Deterministic: same (config, seed) → same levels, always */
  buildLevels(config: GameConfig, seed: number): Level[]

  /** Headless simulation — is this level actually beatable? */
  validateLevel(level: Level, config: GameConfig): ValidationResult

  /** Which art/audio slots this genre needs filled */
  assetSlots: AssetSlot[]              // ["player", "obstacle_a", "bg_far", ...]

  /** Phaser scene entry point */
  runtimeEntry: string
}
```

### A1 — Endless Runner  ⭐ *build first*

**Reference:** Chrome offline dino, Subway Surfers (2D)
**Core loop:** auto-run right, tap/space to jump, avoid obstacles, distance = score.

| Aspect | Detail |
|---|---|
| **Config knobs** | jumpVelocity, gravity, doubleJump, startSpeed, maxSpeed, speedCurve, spawnGapStart/End, obstacle mix + intro levels |
| **Level 1–20** | Each level = distance target. Speed and obstacle density scale up. New obstacle type unlocked every 4–5 levels. |
| **Endless mode** | Unlocked after level 20. Speed scales infinitely with soft cap. |
| **Validator** | Physics reachability — given jump arc (velocity, gravity), is every gap clearable? Is every obstacle pair spaced ≥ minimum safe distance? |
| **Difficulty** | Trivial to tune — single speed axis |
| **Build effort** | 🟢 **Low** — no solvability search needed |

**Why this is the first engine:** simplest physics, no combinatorial level validation, and it proves the *entire* pipeline including APK export. Ship this end-to-end before touching genre #2.

### A2 — Tap-to-Fly

**Reference:** Flappy Bird *(never use that name in UI — see §G1)*
**Core loop:** constant gravity pulls down, tap to flap, thread pipe gaps.

| Aspect | Detail |
|---|---|
| **Config knobs** | flapImpulse, gravity, terminalVelocity, gapHeight, gapVariance, pipeSpacing, scrollSpeed, moving-gap toggle |
| **Level 1–20** | Pipe count target per level. Gap height shrinks, spacing tightens, vertical gap drift introduced ~level 8, moving gaps ~level 14. |
| **Validator** | Critical — gap must be reachable from the previous gap's exit position given flap impulse and gravity. **Impossible gaps are the #1 source of 1-star reviews.** |
| **Build effort** | 🟢 **Low** — reuses runner's scroll + collision systems |

### A3 — Platformer

**Reference:** Super Meat Boy (simplified), classic Mario-style *(generic mechanics only)*
**Core loop:** run, jump, collect, reach the goal, avoid hazards/enemies.

| Aspect | Detail |
|---|---|
| **Config knobs** | moveSpeed, jumpHeight, coyoteTime, airControl, enemy types + patrol behavior, hazards, collectibles, level width, platform density |
| **Level 1–20** | Discrete hand-shaped-feeling levels from a tile grammar: chunk library (jump-gap, staircase, enemy-corridor, moving-platform) assembled with a weighted grammar that biases harder chunks at higher levels. |
| **Validator** | Pathfinding (A* over a jump-arc-aware graph) from spawn to goal. Must also verify every *required* collectible is reachable. |
| **Build effort** | 🟡 **Medium** — tilemap + chunk grammar + pathfinding |

### A4 — Match-3

**Reference:** generic match-3 *(never "Candy Crush" — King aggressively enforces the "Candy" trademark, see §G1)*
**Core loop:** swap adjacent tiles, match 3+, clear objectives within a move limit.

| Aspect | Detail |
|---|---|
| **Config knobs** | gridW/H, tileTypeCount, objective type (score / clear-N-color / drop-item), moveLimit, special tiles (bomb/line/rainbow), blockers (ice/stone/jelly) |
| **Level 1–20** | Grid grows, tile types increase (harder to match), move limit tightens relative to objective, blockers introduced progressively. |
| **Validator** | 🔴 **Hardest.** Two checks: (1) board always has ≥1 valid move after any cascade — else auto-reshuffle; (2) **Monte-Carlo solver** plays the level N=200 times with a greedy heuristic; level is accepted only if win rate lands in a target band (e.g. 35–70% for mid levels). |
| **Build effort** | 🔴 **High** — cascade physics, special-tile interactions, solver |

### A5 — Bubble Pop

**Reference:** generic bubble shooter (Puzzle Bobble lineage)
**Core loop:** aim, shoot colored bubble, match 3+ to pop, clear the board before it descends.

| Aspect | Detail |
|---|---|
| **Config knobs** | colorCount, rowCount, initial board pattern, shotLimit, ceilingDropInterval, wall-bounce toggle, aim-guide length |
| **Level 1–20** | Colors increase, board patterns get denser/awkward, shot limit tightens, aim guide shortens (removed entirely at high levels). |
| **Validator** | Trajectory raycasting including wall bounces — every cluster must be reachable by *some* shot. Plus a greedy solver to confirm clearable within shotLimit. |
| **Build effort** | 🟡 **Medium-High** — hex grid + bounce trajectory math |

### Shared engine runtime (build once, all genres use)

| Module | Responsibility |
|---|---|
| **Boot/Preload** | Asset loading with progress bar |
| **Scale manager** | Responsive: phone portrait, phone landscape, desktop, tablet — letterboxed safe area |
| **Input abstraction** | Touch, mouse, keyboard, gamepad → unified events |
| **Level select UI** | 20-level grid, stars, locked/unlocked state |
| **HUD** | Score, lives, level, pause |
| **Save system** | LocalStorage (web) / Capacitor Preferences (APK) — progress, stars, high scores |
| **Audio manager** | Music loop + SFX, mute toggle, ducking |
| **Theming layer** | Applies palette + sprite pack from config |
| **Pause/Game-over/Win screens** | Retry, next level, back to menu |
| **Tutorial overlay** | First-run hints driven by config text |
| **Telemetry hook** | Optional: level attempts, deaths, completion time |

> This shared runtime is roughly **40% of total engine work** and is the reason genres 2–5 get progressively cheaper to add.

---

## Layer B — AI Orchestration

### B1 — Intent Classifier

**Model:** Haiku 4.5 (cheap, fast — this is a classification task)
**Input:** raw user prompt
**Output (structured):**

```json
{
  "genre": "endless_runner",
  "confidence": 0.94,
  "theme": { "setting": "cyberpunk city", "mood": "energetic", "palette_hint": "neon" },
  "subject": "robot",
  "difficulty_bias": "hard",
  "explicit_requests": ["double jump"],
  "ambiguous": false
}
```

**Behavior:**
- `confidence < 0.7` → don't guess. Ask the user: *"Kaunsa style? [Runner] [Tap-to-Fly] [Platformer] [Match-3] [Bubble Pop]"*
- Unsupported request (e.g. "3D shooter") → clear message + nearest supported alternative
- Runs in ~300ms, costs ~$0.0005

### B2 — Config Generator

**Model:** Sonnet 5 (best structured-output quality per dollar)
**Method:** **Forced tool-calling with the genre's JSON Schema.** The model cannot return prose — it must call `emit_game_config` with a schema-conforming object. This eliminates parse failures.

**Prompt structure:**
```
System: You are a game designer. Emit a config for the {genre} engine.
        Constraints: {genre.configSchema}
        Design principles: {tuning guidelines, safe ranges per knob}
        Available sprite packs: {pack ids + style_tags}
Few-shot: 2–3 exemplar prompt→config pairs (hand-written, high quality)
User:   {classified intent + original prompt}
```

**Critical detail — hard clamps:** every numeric knob has a `min`/`max` in the schema, and the server clamps again after receiving. The AI can suggest `gravity: 50000`; the clamp prevents an unplayable game. **Never trust model output for physics constants.**

**Cost:** ~1k input / ~2k output ≈ **$0.033/game**

### B3 — Schema Validator + Repair Loop

```
generate → validate (Ajv/Zod)
   ├─ valid   → continue
   └─ invalid → feed errors back to model, retry (max 2)
                └─ still invalid → fall back to configDefaults + theme only
                                   (user still gets a working game)
```

**Principle: never show the user a failure.** Worst case they get a solid default-tuned game with their requested theme applied.

### B4 — Asset Resolver

Maps the AI's theme intent to concrete art.

**v1 strategy — curated packs + palette theming** *(strongly recommended)*

```
Sprite pack registry:
  { id: "robot_runner_v2", genre: "endless_runner",
    style_tags: ["scifi","neon","cyberpunk","mech"],
    slots: { player, obstacle_a, obstacle_b, bg_far, bg_near, ground },
    palette_zones: [...],  license: "CC0" }
```

Resolution: score packs by `style_tags` overlap with theme → pick best → apply AI-chosen palette via Phaser tint + pre-baked recolor variants.

**Launch content sourcing:** [Kenney.nl](https://kenney.nl) publishes large, professional, **CC0 (public domain)** 2D asset packs. This gives a zero-cost, zero-legal-risk launch library. Supplement with itch.io packs (check licenses) and commission an artist for 2–3 signature packs per genre later.

**Target at launch:** 3–5 packs per genre = **15–25 packs**. This is real content work — budget for it.

**v2 strategy — AI sprite generation:** deferred. Reasons: transparent backgrounds are unreliable, cross-sprite style consistency is poor, and animation frames (run cycle, jump) are very hard to keep coherent. Revisit when it's genuinely production-ready.

**Audio:** curated SFX + music loop library, tagged by mood. AI picks by tag. AI audio generation is not production-ready for game SFX.

### B5 — Copy Generator

Bundled into the B2 call (same request, extra tool fields) to avoid a second round-trip:
- Game title + tagline
- 20 level names (thematic, e.g. "Sector 7: Overdrive")
- Tutorial hint text
- Win/lose screen messages
- Store description (for the APK download page)

### B6 — Prompt Safety Filter

Runs **before** any generation. Two stages:

1. **Deterministic blocklist** — franchise names, characters, studios (fast, free, catches 90%)
2. **LLM classifier** (Haiku) — semantic evasion ("the plumber with a red cap who jumps on turtles")

Blocks: copyrighted IP, NSFW, hate/violence targeting real groups, real-person likeness. See §G1.

### B7 — Refinement Engine

**This is a major UX differentiator — design it in from day one.**

When a user says *"make it harder"* or *"change to space theme"*, do **not** regenerate the whole game. That destroys what they already liked and wastes money.

Instead: send the **current config + instruction** to the model and request a **JSON Patch (RFC 6902)** — a minimal diff.

```
Input:  currentConfig + "make levels 10-20 harder"
Output: [
  { "op": "replace", "path": "/difficulty/maxSpeed", "value": 1050 },
  { "op": "replace", "path": "/difficulty/spawnGapEnd", "value": 540 }
]
```

Benefits: ~$0.005 per tweak, <2s, preserves everything else, and gives a natural **version history** with undo/redo. Every patch creates a new `game_version` row.

### B8 — Cost Governor

- Per-user daily token ceiling (abuse protection)
- Per-request max output tokens
- Model routing: Haiku for classify/safety → Sonnet for config → Opus only for Pro-tier custom mechanics
- Log every AI call to `generations` table with token counts and USD cost — you need this to price credits correctly
- Circuit breaker: if provider errors spike, serve template-default games and flag degraded mode

---

## Layer C — Generation Core

**Zero AI in this layer.** Pure, deterministic, unit-testable code. This is where quality is actually enforced.

### C1 — Engine Registry

Central map `GenreId → GenreEngine`. Validates at boot that every registered engine satisfies the interface and that its schema compiles. Adding a genre = one registry entry.

### C2 — Difficulty Curve Engine

Shared across genres. Converts config knobs into per-level parameters.

```ts
type CurveShape = "linear" | "easeInQuad" | "easeOutQuad" | "sCurve" | "stepped"

function levelParams(level: number, cfg: GameConfig) {
  const t = (level - 1) / (cfg.progression.levels - 1)   // 0 → 1
  const e = applyCurve(t, cfg.difficulty.curve)

  return {
    speed:       lerp(cfg.difficulty.startSpeed, cfg.difficulty.maxSpeed, e),
    spawnGap:    lerp(cfg.difficulty.spawnGapStart, cfg.difficulty.spawnGapEnd, e),
    targetScore: Math.round(cfg.difficulty.baseTarget * Math.pow(1.18, level - 1)),
    activeTypes: cfg.obstacles.filter(o => o.introAtLevel <= level),
  }
}
```

**Design principles baked into the curve:**

| Principle | Implementation |
|---|---|
| **Gentle onboarding** | `easeInQuad` default — levels 1–4 are genuinely easy. Most churn happens in the first 90 seconds. |
| **Novelty beats numbers** | Introduce a new obstacle/mechanic every 4–5 levels. "Something new" feels better than "same thing faster". |
| **Relief valleys** | Levels 8 and 15 dip ~15% easier. A monotonic ramp feels punishing; valleys create rhythm. |
| **Difficulty bias** | AI's `difficulty_bias` shifts the whole curve ±25%, it doesn't change the shape. |
| **Hybrid progression** | Levels 1–20 structured → completing L20 unlocks **Endless Mode** with infinite soft-capped scaling. Exactly the requested model. |

### C3 — Procedural Level Builder

Per-genre `buildLevels(config, seed)`. Uses a **seeded PRNG** — never `Math.random()`.

Pattern: **chunk grammar**. Each genre has a library of hand-authored "chunks" (a jump sequence, an enemy corridor, a match-3 blocker pattern) tagged with a difficulty rating. The builder assembles chunks with weights biased by the level's difficulty parameters. Result: procedurally varied but *hand-crafted feeling*, because a human designed every chunk.

### C4 — Level Validator ⭐

**Read this twice. This module is the difference between a toy and a product.**

```ts
type ValidationResult =
  | { ok: true; metrics: { estimatedWinRate: number; optimalMoves: number } }
  | { ok: false; reason: "unreachable_gap" | "no_valid_move" | "unsolvable" | "too_easy" | "too_hard" }
```

Runs headless (Node, no rendering) on **every generated level**:

| Genre | Validation method |
|---|---|
| Endless Runner | Jump-arc physics: every gap clearable? every obstacle pair ≥ min safe spacing? |
| Tap-to-Fly | Gap-to-gap reachability given flap impulse + gravity + horizontal scroll speed |
| Platformer | A* over jump-arc-aware node graph, spawn → goal; required collectibles reachable |
| Match-3 | Monte-Carlo: 200 greedy playthroughs, win rate must land in target band |
| Bubble Pop | Bounce-aware trajectory raycast per cluster + greedy solver within shot limit |

**Repair loop:**
```
for attempt in 1..8:
    level = buildLevel(config, seed + attempt)
    if validate(level).ok: return level
# all attempts failed → relax constraints one notch, retry
# still failing → substitute a hand-authored fallback level for this slot
```

**Guarantee to the user: every shipped level is beatable.** No exceptions. This must be enforced by tests in CI.

### C5 — Asset Pipeline

| Step | Purpose |
|---|---|
| Slot resolution | Map `assetSlots` → concrete files from the chosen pack |
| Palette application | Pre-bake recolored variants (faster at runtime than shaders) |
| Texture atlas packing | All sprites → single atlas + JSON (drastically fewer draw calls) |
| WebP conversion | ~30% smaller than PNG, universally supported on Android WebView |
| Audio sprite | Concatenate SFX into one file + timing map (one HTTP request, no mobile audio-unlock issues) |
| Icon generation | App icon → all mipmap densities (mdpi→xxxhdpi) + adaptive icon layers via `sharp` |
| Budget enforcement | **Hard cap: 20 MB total assets.** Warn at 15 MB. Directly controls APK size. |

### C6 — Bundler

Produces a fully self-contained static bundle:

```
bundle/
  index.html          # inlined critical CSS
  game.js             # Phaser + engine + config, minified
  assets/
    atlas.webp  atlas.json
    audio.mp3   audio.json
    fonts/*.woff2     # LOCAL — never a CDN
  config.json         # the generated GameConfig
```

**Absolute requirement: zero network calls at runtime.** No Google Fonts, no CDN Phaser, no analytics beacon. This is what makes the APK truly offline. Enforce with a CI check that greps the bundle for external URLs.

### C7 — Seed & Determinism Manager

- Seed derived from `hash(gameId + version)` — stable across rebuilds
- Seeded PRNG (`mulberry32`) threaded explicitly through all generation
- CI test: generate the same config twice → assert byte-identical output
- Lint rule banning `Math.random()` in the generation packages

---

## Layer D — Build & Distribution

### D1 — Web Publisher

Bundle → object storage → CDN. URL shape: `play.<domain>/g/<gameId>/<version>/`

- Immutable versioned paths → `Cache-Control: max-age=31536000, immutable`
- Instant play, shareable link, embeddable iframe
- This path is **fast (3–8s)** and is what users see first

### D2 — APK Build Worker ⭐ *the differentiator*

**Technology choice: Capacitor.**

| Option | Verdict |
|---|---|
| **Capacitor** | ✅ **Chosen.** Actively maintained, true offline (assets bundled locally), good plugin ecosystem, clean Gradle integration |
| Cordova | ❌ Legacy, effectively deprecated |
| PWABuilder / Bubblewrap (TWA) | ❌ **Requires a live internet URL** — breaks the offline promise |
| React Native / Flutter wrapper | ❌ Unnecessary complexity for a canvas game |

**Pipeline:**

```
 1. Fetch static bundle from storage
 2. Copy → android/app/src/main/assets/public/
 3. Patch Android project:
      build.gradle    → applicationId, namespace, versionCode, versionName
      strings.xml     → app_name
      mipmap-*/       → generated icons
      splash assets   → themed splash screen
      AndroidManifest → orientation lock, screenOrientation, no INTERNET permission
 4. ./gradlew assembleRelease
 5. zipalign -p 4
 6. apksigner sign --ks <platform keystore>
 7. apksigner verify   (fail loudly if this fails)
 8. Upload to object storage → signed, expiring download URL
```

**Worker environment:**
- Docker image: JDK 17 + Android SDK cmdline-tools + build-tools 34 + platform-34 (~3.5 GB)
- **Pre-warm the Gradle cache in the image.** Cold build 4–6 min; warm build **60–120 s**. This single optimization is worth more than any other.
- RAM: ~3 GB per concurrent build → an 8 GB worker runs 2 concurrently
- Ephemeral workspace per build, cleaned after

**Non-obvious details that will bite you:**

| # | Issue | Handling |
|---|---|---|
| 1 | **Unsigned APKs will not install** | One platform keystore, all builds signed with it. Store in a secret manager — **never in the repo.** Losing it is unrecoverable for Play Store updates. |
| 2 | **Package ID must be unique per game** | `com.<brand>.g<shortid>` — otherwise installing game B overwrites game A. Segments cannot start with a digit; validate strictly. |
| 3 | **"Install unknown apps"** | Android 8+ requires the user to enable this per-source. Ship a clear 3-step visual guide on the download page or you will drown in support tickets. |
| 4 | **APK size** | Target < 25 MB. Phaser ≈ 1 MB gzipped; assets dominate. Enforced by C5's budget. |
| 5 | **Play Store needs AAB, not APK** | Direct download = APK ✅. If you ever add Play publishing, that's a separate AAB pipeline. |
| 6 | **Play Store spam policy** | Mass-produced near-identical games get rejected/banned. Document this clearly in your Terms so creators aren't surprised. |
| 7 | **No INTERNET permission** | Omitting it is a strong trust signal *and* forces true offline correctness. Do it. |
| 8 | **WebView version fragmentation** | Old Android WebViews lack newer JS features. Set a conservative build target (ES2019) and test on Android 8. |

**MVP shortcut worth taking:** use **GitHub Actions** as the initial build farm. Ubuntu runners ship with the Android SDK pre-installed, so you get a working APK pipeline with **zero infrastructure**. Downsides: 2–5 min queue latency and concurrency limits. Perfect for validating the product; migrate to dedicated workers once volume justifies it.

**Phase-3 optimization:** keep a pre-built unsigned APK shell per genre, swap only the `assets/` entries, then `zipalign` + `apksigner`. Skips Gradle entirely → **5–10 second builds**. Complexity: patching the package ID without Gradle requires `aapt2` work or a pool of pre-generated package IDs. Not for v1.

### D3 — Signing Service

Isolated service (or tightly-scoped worker step) holding the keystore. Keystore + passwords live in a secret manager (Google Secret Manager / AWS Secrets Manager / Doppler). Audit-log every signing operation. Never expose the keystore to the general build container if you can separate them.

### D4 — Build Queue

BullMQ + Redis (or Cloud Tasks). Requirements:

- Per-user concurrency limit (1 active build on free tier)
- Idempotency: `(gameId, version, platform)` → dedupe, return existing artifact
- Progress events streamed to the UI over SSE/WebSocket
- Retry with backoff on transient failures; do **not** retry on genuine build errors
- Timeout: 10 min hard kill
- Dead-letter queue with full logs for debugging

**Status state machine:**
```
queued → preparing → patching → gradle_build → signing → uploading → ready
                                                        ↘ failed(stage, log_url)
```

### D5 — Artifact Storage

**Cloudflare R2** recommended — S3-compatible with **zero egress fees**, which matters enormously when serving 20 MB APK downloads.

```
r2://forge-artifacts/
  games/<gameId>/<version>/bundle/        # web playable
  games/<gameId>/<version>/game.apk      # signed APK
  games/<gameId>/<version>/build.log
  packs/<packId>/...                     # source asset packs
```

**Retention policy (cost control):** free-tier APKs deleted after 30 days (rebuildable on demand, since builds are deterministic). Paid tiers retained indefinitely. Web bundles kept while the game is public.

### D6 — Download Delivery

- Signed, expiring URLs (24 h)
- Download page: QR code (scan → download on phone directly — big UX win), install guide, SHA-256 checksum
- Play-count / download-count tracking
- Optional: email the link to the user

---

## Layer E — Frontend Surfaces

### E1 — Marketing Site

Hero with a **live playable demo game embedded** (not a video — let them play in 2 seconds). Genre showcase, "how it works" in 3 steps, arcade highlights, pricing, FAQ.

*Learnings from the competitor audit (geniteam) — avoid these exact mistakes:* real meta description + OG tags + branded favicon, no placeholder footer text, no dead `href="#"` links, working robots.txt/sitemap, cookie consent banner before loading trackers, and no `console.log` in production.

### E2 — Auth & Onboarding

- Email/password + Google OAuth (Clerk or Supabase Auth — do not hand-roll)
- **Let users generate one game before signing up.** Gate only *saving* and *APK export*. This is the single highest-leverage conversion decision.
- Onboarding: pick a genre → prefilled example prompt → generate → play. Under 60 seconds to "wow".
- Starter grant: 30 free credits

### E3 — Prompt Studio *(the core surface)*

```
┌──────────────────────────────────────────────────────────┐
│  What game do you want to make?                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ neon cyberpunk runner with a robot, make it hard   │  │
│  └────────────────────────────────────────────────────┘  │
│  [🏃 Runner] [🐦 Tap-to-Fly] [🎮 Platformer]              │
│  [💎 Match-3] [🫧 Bubble Pop]      ← optional override   │
│                                                          │
│  Try: "underwater bubble game" · "jungle platformer"     │
│                                    [ ✨ Generate ]        │
└──────────────────────────────────────────────────────────┘
```

**Generation progress must be transparent** — a fake spinner feels broken. Stream real stages:

```
✓ Understanding your idea          (0.4s)
✓ Designing game rules             (2.1s)
✓ Building 20 levels               (0.8s)
✓ Checking every level is beatable (1.2s)   ← builds real trust
✓ Loading art & sound              (0.6s)
▸ Packaging your game...
```

That fourth line is a marketing asset. It tells the user something a competitor can't claim.

### E4 — Tweak Panel

Post-generation refinement without regenerating (powered by B7):

- **Chat refinement:** "make it harder", "change to space theme", "add double jump"
- **Sliders:** difficulty, speed, level count
- **Theme picker:** palette swatches, sprite pack alternatives
- **Level inspector:** view any of the 20 levels, see its validated difficulty score, re-roll a single level
- **Version history:** every patch = a version; undo/redo/restore

### E5 — Web Player

Embedded canvas, responsive, fullscreen toggle, share, restart. Mobile-first (most traffic will be phones). Must handle portrait/landscape gracefully.

### E6 — My Games Dashboard

Grid of games with thumbnail, genre badge, play/tweak/export actions, visibility toggle (private/public), plays + downloads count, delete.

### E7 — Export Center

Platform cards (Android APK ✅ available; iOS / Web-embed / Windows marked "coming soon"), app name + icon customization, live build progress, download history with version list, QR code, install guide.

### E8 — Arcade / Community

Browse public games, filter by genre, sort by trending/new/most-played, play instantly, **Remix** (fork someone's config into your account and tweak it), like, report.

> **Remix is your primary growth loop.** It lowers creation effort to near-zero and multiplies content. Design it prominently.

### E9 — Billing & Credits

Credit balance in the header, purchase packs (Stripe Checkout), transaction history from the ledger, per-action cost shown *before* spending ("Export APK — 15 credits"), low-balance nudge.

### E10 — Admin Console

**Protect it properly** — server-side authorization via custom claims, not a client-side check. (This was a real weakness in the competitor audit.)

Moderation queue (reported games), user management, build monitor + retry, AI cost dashboard, asset pack manager, feature flags, generation failure log.

---

## Layer F — Platform & Data

### F1 — Database Schema (Postgres)

```sql
users(id, email, display_name, avatar_url, plan, created_at, last_seen_at)

-- Append-only ledger. NEVER a lone mutable balance column.
credit_ledger(id, user_id, delta, reason, ref_type, ref_id,
              balance_after, created_at)

games(id, user_id, title, genre, seed, current_version,
      visibility, parent_game_id,        -- remix lineage
      thumbnail_url, play_count, download_count,
      status, created_at, updated_at)

game_versions(id, game_id, version, config_jsonb, patch_jsonb,
              bundle_url, created_at)

builds(id, game_id, version_id, platform, status, stage,
       artifact_url, size_bytes, package_id,
       error_message, log_url, started_at, finished_at)

asset_packs(id, name, genre, style_tags[], slots_jsonb,
            license, source_url, active)

generations(id, user_id, game_id, stage, model, prompt,
            input_tokens, output_tokens, cost_usd,
            status, latency_ms, created_at)   -- AI audit trail

plays(id, game_id, user_id, max_level, best_score,
      duration_s, device_type, created_at)

reports(id, game_id, reporter_id, reason, notes, status, resolved_by)
```

**Why Postgres over Firestore:** this data is deeply relational (users → games → versions → builds; credit ledger integrity; analytics aggregation). Firestore makes joins, transactional ledger writes, and reporting painful. `jsonb` handles the flexible config perfectly.

### F2 — Credit Ledger

**Design rule: append-only, double-entry style.** Every change is a row. `balance_after` is denormalized on each row for O(1) balance reads. Reconciliation job verifies `SUM(delta) == latest.balance_after`.

Charge **only on success** — if generation fails, no debit (or auto-refund). Nothing destroys trust faster than charging for a broken game.

| Action | Credits | Notes |
|---|---|---|
| Generate new game | 10 | |
| Refinement / tweak | 2 | cheap, encourage iteration |
| Re-roll single level | 1 | |
| **Export APK** | 15 | real compute cost |
| Rebuild same version | 0 | idempotent, cached |
| Remix a game | 5 | |
| AI sprite generation *(v2)* | 5 | |

### F3 — Object Storage

Cloudflare R2 (see §D5). Lifecycle rules for free-tier artifact expiry.

### F4 — Analytics

**Product analytics (web):** PostHog (self-hostable, generous free tier). Funnel: land → prompt → generate → play → signup → export → purchase. Instrument every step.

**In-game telemetry:** web player reports level attempts/deaths/completion → powers a **difficulty tuning feedback loop**. If level 12 has a 4% completion rate across all games, your curve formula needs adjustment. This data is a genuine long-term moat.

**APK telemetry:** the APK has no INTERNET permission → no telemetry. Correct tradeoff: privacy + true offline. Web player data is sufficient for tuning.

### F5 — Rate Limiting & Abuse Prevention

- Per-IP anonymous generation limit (1–2/hour before signup)
- Per-user daily generation + build ceilings by tier
- Prompt-length and complexity caps
- Duplicate-prompt detection → serve cached result
- Cloudflare Turnstile on signup and anonymous generation
- Alert on anomalous spend per user

### F6 — Observability

- Structured JSON logs with a `traceId` threaded from HTTP request → AI calls → generation → build
- Sentry for frontend + backend errors
- Metrics: generation p50/p95/p99 latency, validator failure rate by genre, build success rate, AI cost/day, queue depth
- Alerts: build success rate < 95%, validator failure > 10%, queue depth > 50, AI spend anomaly
- **Retain the full generation trace for every game** — when a user reports a broken game you need to replay exactly what happened

### F7 — Job Orchestrator

Generation is a multi-stage pipeline that can fail at any stage. Model it as an explicit state machine with a persisted status per stage, resumable from the last good stage. Do not build it as one long synchronous function — it will become unmaintainable.

---

## Layer G — Trust, Safety & Legal

### G1 — IP & Trademark Protection ⚠️ *do not skip this*

**Two separate risks:**

**Risk 1 — Your own UI naming.** Never label genres with famous game names.

| ❌ Never use | ✅ Use instead |
|---|---|
| Candy Crush | **Match-3 Puzzle** |
| Flappy Bird | **Tap-to-Fly** |
| Chrome Dino | **Endless Runner** |
| Subway Surfers | **Endless Runner** |
| Bubble Shooter | Bubble Pop *(generic — acceptable)* |

> King (Candy Crush) has trademarked the word **"Candy"** in a gaming context and enforces it aggressively. Do not put it in your UI, marketing, or genre labels.

**Risk 2 — User prompts requesting protected IP.** Users *will* ask for "make Mario", "Pokemon game", "Squid Game". Block it (B6) with a friendly message:

> *"We can't create games using copyrighted characters. Try describing your own character instead — e.g. 'a plumber in a mushroom world' works great!"*

Also: DMCA takedown process for public arcade games, and a report button on every community game.

### G2 — Content Moderation

- Automated screening at generation time (B6)
- Additional screening when a game is made **public**
- User reporting → admin queue (E10)
- Auto-unpublish at a report threshold, pending review
- Ban/suspend controls

### G3 — Terms of Service / IP Ownership

Must be explicit before launch:

- **User owns** their prompt, their generated config, and the resulting game
- **Platform grants** a license to bundled assets (make sure your asset licenses permit sublicensing — CC0 does, many commercial packs do not; **audit every pack's license**)
- **Platform retains** engine code ownership — users get a license to distribute the compiled output, not the engine source
- Commercial use rights: allowed on paid tiers, clearly stated
- Play Store publishing: user's responsibility; warn about the spam policy
- No exclusivity — procedurally similar games will exist; say so plainly

### G4 — Privacy & GDPR

- Cookie consent banner **before** loading any analytics/marketing tracker *(the competitor fails this)*
- Privacy policy, data export, account deletion
- APK collects nothing — a strong, honest marketing claim
- Data processing agreements with sub-processors (Anthropic, Stripe, PostHog)

---

## Layer H — Business Model

### Credit packs

| Pack | Price | Credits | Games (approx) | Effective |
|---|---|---|---|---|
| Starter | Free | 30 | 3 generations, 0 exports | — |
| Small | $9 | 100 | ~4 games with APK | $0.09/credit |
| Medium | $29 | 400 | ~16 games with APK | $0.073/credit |
| Large | $79 | 1,200 | ~48 games with APK | $0.066/credit |
| Studio | $199/mo | 4,000/mo | ~160 games/mo + priority builds, no branding | subscription |

Credits (not seats) fit lumpy creative usage and map cleanly to real variable costs.

### Free tier design

Free users get: **3 generations, unlimited web play, no APK export.** The APK is the paywall — it's the differentiated, expensive-to-produce artifact. Web play stays free forever because it drives the arcade, sharing, and virality.

### Growth loops

1. **Remix loop** — public game → remix → new creator with near-zero effort
2. **Share loop** — playable link shared on social → new visitors
3. **APK loop** — creator sends the APK to friends → in-game "Made with <brand>" splash (removable on paid tiers)
4. **Arcade SEO** — every public game is an indexable landing page

### Future revenue (post-v1)

Creator ad-revenue share, white-label for agencies, education licenses, iOS export as a premium add-on, marketplace for premium asset packs.

---

## 12. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Game engine | **Phaser 3** | Mature 2D: physics, tilemaps, atlases, audio, scaling. Huge ecosystem. |
| Game build | Vite | Fast, tiny output, same tooling as web app |
| Web frontend | React + Vite + TypeScript | Team familiarity |
| Styling | Tailwind + shadcn/ui | Fast, consistent |
| Backend | Node 22 + Fastify + TypeScript | Shared types with frontend; Fastify is fast with first-class schema validation |
| Validation | Zod (+ zod-to-json-schema) | One schema → TS types, runtime validation, *and* the AI's tool schema |
| Database | **Postgres** (Supabase or Neon) | Relational + `jsonb`; see §F1 |
| ORM | Drizzle | Type-safe, lightweight, good migrations |
| Queue | BullMQ + Redis | Mature, good observability |
| Object storage | **Cloudflare R2** | S3-compatible, **zero egress** — critical for APK downloads |
| CDN | Cloudflare | Same platform as R2 |
| Auth | Clerk *or* Supabase Auth | Never hand-roll auth |
| Payments | Stripe | Standard |
| AI | Claude — Haiku 4.5 (classify/safety), Sonnet 5 (config), Opus 5 (Pro custom) | Tiered by task cost/complexity; strong structured-output support |
| APK build | Capacitor + Gradle in Docker | §D2 |
| Analytics | PostHog | Self-hostable, generous free tier |
| Errors | Sentry | Standard |
| CI/CD | GitHub Actions | Also the MVP APK build farm (§D2) |
| Monorepo | pnpm workspaces + Turborepo | Shared schema package is essential |

---

## 13. Repository Structure

```
factorial-forge/
├── apps/
│   ├── web/                     # React marketing + studio + dashboard
│   ├── api/                     # Fastify REST API
│   ├── worker-generate/         # generation pipeline consumer
│   └── worker-apk/              # Capacitor + Gradle build worker
├── packages/
│   ├── schema/                  # ⭐ Zod schemas — SINGLE SOURCE OF TRUTH
│   │                            #    → TS types, runtime validation, AI tool schemas
│   ├── ai/                      # B1–B8: classifier, config gen, repair, refine
│   ├── generation/              # C1–C7: curve, level builder, validator, seed
│   ├── engines/
│   │   ├── shared/              # boot, scale, input, HUD, save, audio, theming
│   │   ├── endless-runner/      # A1  ⭐ first
│   │   ├── tap-to-fly/          # A2
│   │   ├── platformer/          # A3
│   │   ├── match-3/             # A4
│   │   └── bubble-pop/          # A5
│   ├── assets-registry/         # sprite/audio pack metadata + licenses
│   ├── bundler/                 # C6: static bundle producer
│   └── ui/                      # shared React components
├── android-template/            # pre-configured Capacitor project
├── infra/
│   ├── docker/apk-builder/      # JDK + Android SDK + warm Gradle cache
│   └── terraform/
└── docs/
    ├── PRODUCT_DESIGN.md        # this document
    ├── ENGINE_SPEC.md           # per-genre config schemas
    └── APK_PIPELINE.md          # build runbook
```

**`packages/schema` is the architectural keystone.** One Zod definition produces the TypeScript types, the runtime validator, *and* the JSON Schema handed to Claude as a tool definition. Change a knob in one place and the AI, API, and engine all stay in sync. Get this right early.

---

## 14. Unit Economics

### Cost per generated game

| Item | Cost |
|---|---|
| Intent classification (Haiku) | $0.0005 |
| Config + copy generation (Sonnet) | $0.033 |
| Safety filter (Haiku) | $0.0003 |
| Level generation + validation (CPU) | ~$0.001 |
| Web bundle storage (20 MB) | ~$0.0003/mo |
| **Subtotal — web game** | **≈ $0.035** |
| APK build (90 s worker time) | ~$0.002 |
| APK storage + delivery (R2, zero egress) | ~$0.0003/mo |
| **Total — game + APK** | **≈ $0.038** |

### Margin

At 25 credits (generate + export) on the Medium pack ($0.073/credit) → **revenue $1.83 vs cost $0.04**.

Gross margin ≈ **97%**. Even with heavy free-tier abuse the model is comfortable. **The economics are strongly favorable** — the constraint on this business is engineering time and content (asset packs), not marginal cost.

### Infrastructure baseline (monthly, early stage)

| Item | Cost |
|---|---|
| Postgres (Supabase/Neon) | $25 |
| Redis | $10 |
| API + web hosting | $20 |
| APK build worker (8 GB) | $40–60 |
| R2 storage + CDN | $5–15 |
| PostHog / Sentry | $0 (free tiers) |
| **Total** | **≈ $100–130/mo** |

One worker handles roughly **2,000+ APK builds/month**. Infrastructure is not the bottleneck.

---

## 15. Build vs Buy

| Component | Decision | Why |
|---|---|---|
| Auth | **Buy** (Clerk/Supabase) | Zero differentiation, high risk if wrong |
| Payments | **Buy** (Stripe) | Obviously |
| Analytics | **Buy** (PostHog) | Free tier is plenty |
| Error tracking | **Buy** (Sentry) | Standard |
| Database | **Buy managed** (Neon/Supabase) | Don't run Postgres yourself |
| Launch art assets | **Buy/adopt** (Kenney CC0 + itch.io) | Months of art work, near-zero cost |
| Game engine base | **Buy** (Phaser 3) | Don't write a renderer |
| **Genre engines** | **BUILD** ⭐ | Core IP and quality moat |
| **Level validators** | **BUILD** ⭐ | Core quality guarantee — nobody sells this |
| **AI config pipeline** | **BUILD** ⭐ | Core product |
| **APK pipeline** | **BUILD** ⭐ | The differentiator |
| Difficulty curve engine | **BUILD** | Tuned by your own telemetry — long-term moat |

The four ⭐ items are where every engineering hour should go. Everything else, buy.

---

## 16. Execution Roadmap

### Phase 0 — Foundation (1 week)

Monorepo scaffold · `packages/schema` with the first Zod config schema · Postgres schema + migrations · auth wired · CI green.
**Exit:** a user can sign up and see an empty dashboard.

### Phase 1 — Vertical Slice ⭐ (4–6 weeks) *← the critical phase*

**Scope: ONE genre (Endless Runner), the ENTIRE pipeline, end to end.**

| Week | Deliverable |
|---|---|
| 1 | Shared engine runtime (boot, scale, input, HUD, save, audio, theming) |
| 2 | Endless Runner engine + config schema + 3 CC0 sprite packs |
| 3 | Difficulty curve + level builder + **validator** + determinism tests |
| 4 | AI layer: classifier → config gen → schema repair → asset resolver |
| 5 | Prompt Studio UI + streaming progress + web player + dashboard |
| 6 | **APK pipeline** (GitHub Actions MVP) + signing + download page |

**Exit criteria — all must pass:**
- Type a prompt → playable 20-level game in **< 10 seconds**
- All 20 levels **proven beatable** by the validator, enforced in CI
- Click Export → **signed APK** downloads
- APK installs on a real Android phone and plays **fully offline (airplane mode)**
- Same config + seed → byte-identical rebuild

> **Do not start Phase 2 until every one of these passes.** Phase 1 de-risks the two things that can kill this product: level quality and APK builds.

### Phase 2 — Genre Expansion (3–4 weeks)

Tap-to-Fly + Platformer. Reuses ~60% of Phase 1 (shared runtime, curve, AI layer, build pipeline). Adds pathfinding validation. Refinement Engine (B7) + version history. Arcade + Remix.
**Exit:** 3 genres live, remix loop working.

### Phase 3 — Puzzle Genres (4–5 weeks)

Match-3 + Bubble Pop — the hard validators (Monte-Carlo solver, bounce trajectories). Level inspector UI. Migrate APK builds to dedicated workers.
**Exit:** all 5 genres live, sub-2-minute builds.

### Phase 4 — Monetization & Polish (3 weeks)

Stripe + credit ledger + purchase flow. Admin console. Moderation. Legal pages. SEO. Cookie consent. Onboarding polish. Load testing.
**Exit:** revenue-ready public launch.

### Phase 5 — Post-launch (ongoing)

Telemetry-driven difficulty tuning · more asset packs · AI sprite generation · iOS export · Pro tier with AI custom mechanics · web-embed SDK.

**Total to public launch: ~15–19 weeks** with a small focused team (2 engineers + part-time designer/artist).

---

## 17. Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| 1 | **APK pipeline harder than expected** | 🔴 Critical — kills the differentiator | Medium | **Build it in Phase 1, not later.** GitHub Actions fallback removes infra risk entirely. |
| 2 | **Generated levels feel bad/unfair** | 🔴 Critical — product feels cheap | Medium | Validator (C4) is non-negotiable + hand-authored chunk libraries + telemetry tuning loop |
| 3 | **Art looks inconsistent/amateur** | 🟠 High — kills perceived quality | High | Curated CC0 packs + palette theming. **No AI sprites in v1.** |
| 4 | **Trademark/IP claim** | 🟠 High — legal + takedown | Medium | §G1: generic genre names, prompt blocklist, DMCA process, license audit on every pack |
| 5 | **Scope creep across 5 genres** | 🟠 High — never ships | **High** | Phase gates with hard exit criteria. One genre fully done before the next. |
| 6 | **Play Store spam-policy bans** | 🟡 Medium — user frustration | Medium | Direct APK is the primary path; clear Terms warning about Play publishing |
| 7 | **AI cost overrun from abuse** | 🟡 Medium | Medium | B8 cost governor + F5 rate limits + spend alerts |
| 8 | **"Install unknown apps" friction** | 🟡 Medium — drop-off at the final step | High | QR code flow + clear visual 3-step guide + honest expectation-setting |
| 9 | **Asset pack content bottleneck** | 🟡 Medium | Medium | Start with Kenney CC0; commission signature packs only after PMF |
| 10 | **Competitor (geniteam) ships APK first** | 🟡 Medium | Low | Their architecture has no build infra; this is a multi-week moat if you move now |

---

## 18. Definition of Done — MVP

A user who has never written code can:

1. ✅ Land on the site and play a demo game within 3 seconds
2. ✅ Type one sentence describing a game idea
3. ✅ Receive a **playable 20-level game in under 10 seconds**
4. ✅ Experience genuine easy → hard progression, with **every level beatable**
5. ✅ Unlock **Endless Mode** after clearing level 20
6. ✅ Refine it conversationally ("make it harder", "space theme") in under 2 seconds
7. ✅ Sign up and save it
8. ✅ Buy credits with a card
9. ✅ Export a **signed Android APK**, delivered in under 2 minutes
10. ✅ Install it on a phone and play **fully offline in airplane mode**
11. ✅ Share a public link; someone else **remixes** it
12. ✅ Never see a crash, a broken level, or an unhandled error

---

## Immediate Next Steps

1. **Approve or amend this design** — especially §2 (template vs code-gen), §H (pricing), and the Phase 1 scope
2. **Lock the brand name** (replaces "Forge" throughout) and register the domain
3. **Audit asset licenses** — download Kenney CC0 packs, confirm sublicensing rights
4. **Spike the riskiest thing first:** a bare Capacitor project → Gradle → signed APK → install on a phone offline. **One or two days.** If this works, the product is viable.
5. **Then** begin Phase 0 scaffolding

---

*End of document.*
