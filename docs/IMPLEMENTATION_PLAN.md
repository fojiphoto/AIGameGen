# Implementation Plan — Local SaaS Completion

**Goal:** a complete, demonstrable SaaS product running entirely on localhost, presentable
to a prospect or investor without apologies.

**Explicitly out of scope** (owner's decision, deferred to the end): deployment, hosting,
domains, real payment processing, Play Store publication. Everything here runs locally.

Design reference: [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md). Phase 1 (vertical slice) is
already complete — see [../README.md](../README.md).

---

## Constraints shaping every decision

| Constraint | Consequence |
|---|---|
| **Zero budget** — free tiers only | `node:sqlite` (built into Node, no server), `node:crypto` scrypt (no bcrypt dep), mock checkout instead of Stripe |
| **No `ANTHROPIC_API_KEY`** | Every AI feature needs a working deterministic path. Refinement currently has none — that is a gap to close, not a nice-to-have. |
| **Localhost only** | No S3/R2, no Redis. Filesystem artifacts + in-process queue stay. |
| **Must look like a real SaaS** | Auth, credits, billing, arcade, admin, legal pages are all required, not optional polish. |

---

## Workstreams

### 1. Data layer — `packages/db`

Replaces the filesystem store. Built on **`node:sqlite`** (shipped with Node ≥ 22, zero
dependencies, single file on disk — the cheapest possible real database).

```
users(id, email, password_hash, password_salt, display_name, role, created_at, last_seen_at)
sessions(token, user_id, created_at, expires_at, ip)
credit_ledger(id, user_id, delta, reason, ref_type, ref_id, balance_after, created_at)
games(id, user_id, title, genre, seed, current_version, visibility,
      parent_game_id, play_count, download_count, status, created_at, updated_at)
game_versions(id, game_id, version, config_json, patch_json, created_at)
builds(id, game_id, version, platform, status, stage, artifact_path,
       size_bytes, package_id, error, started_at, finished_at)
plays(id, game_id, user_id, max_level, best_score, duration_s, device, created_at)
level_stats(game_id, level, attempts, clears, deaths)   -- difficulty tuning feedback
reports(id, game_id, reporter_id, reason, notes, status, created_at)
generations(id, user_id, game_id, stage, model, prompt, in_tokens, out_tokens,
            cost_usd, status, latency_ms, created_at)
```

**Invariants to enforce in code, not convention:**
- `credit_ledger` is append-only. Balance is read from the latest `balance_after`, and a
  reconciliation query asserts `SUM(delta) == latest.balance_after`.
- All SQL parameterised. No string concatenation.
- Migrations are idempotent and versioned so the DB file survives restarts.

### 2. Auth, sessions, rate limiting

- `scrypt` password hashing with a per-user salt (`node:crypto`, no dependency).
- Opaque session tokens in an `httpOnly`, `sameSite=lax` cookie. No JWT — a server-side
  session table means logout actually revokes.
- **Anonymous generation before signup.** One free game per IP, then a signup wall. This is
  the highest-leverage conversion decision in the product (§E2); it must survive.
- Rate limits: per-IP anonymous generation, per-user daily generation and build ceilings.
- **Server-side authorization only.** `role = 'admin'` on the user row, checked in a Fastify
  `preHandler`. The competitor audit that started this project found a client-side admin
  gate; not repeating that.

### 3. Credits

| Action | Cost |
|---|---|
| Generate a game | 10 |
| Refine / tweak | 2 |
| Re-roll one level | 1 |
| Build APK | 15 |
| Rebuild identical version | 0 (idempotent) |
| Remix | 5 |

Charged **only on success**; a failed generation or build auto-refunds in the same
transaction. Signup grants 30 credits. Mock checkout grants a pack and writes a ledger row
with `reason = 'purchase.mock'` — the real Stripe webhook writes the same row later, so the
swap touches one handler.

### 4. Deterministic refinement — closes the no-API-key gap

`refine()` currently requires the API key, so the primary user path is broken for a
zero-budget deployment. Add a rule-based refiner producing the same JSON Patch shape:

| Instruction pattern | Patch |
|---|---|
| harder / mushkil / faster / tez | raise `maxSpeed`, tighten `spawnGapEnd`, shift curve |
| easier / asaan / slower | inverse |
| `<theme>` keyword | swap `theme.palette` from the curated library |
| add/remove double jump | `player.doubleJump` |
| more/fewer obstacles | adjust `weight` distribution |
| no gaps / no flying | drop those obstacles from the roster |

Every patch runs through `clampNumbers` → schema validation → `buildGame`. **A patch that
would make any level unbeatable is rejected, not shipped** — same rule as generation.

### 5. Second genre — Tap-to-Fly

Proves the engine registry is a real abstraction rather than one game with extra files.
Reuses the shared runtime, difficulty curve, AI layer, bundler and APK pipeline.

New work: config schema, gap-to-gap reachability validator (the critical check — an
unreachable pipe gap is the classic unfair-Flappy bug), level builder, Phaser scene.

Named **Tap-to-Fly** everywhere. Never the other name — see §G1 on trademarks.

### 6. Frontend — multi-page SaaS

Replaces the single-page dev UI. Factorial theme tokens throughout.

`/` landing · `/login` `/signup` · `/studio` (SSE progress) · `/dashboard` ·
`/game/:id` (play + tweak + level inspector) · `/export/:id` (build, QR, install guide) ·
`/arcade` (browse + remix) · `/billing` · `/admin` · `/terms` `/privacy` + cookie consent.

Server-rendered shell + vanilla JS islands. No React build step — it keeps the whole thing
runnable with `node apps/api/src/server.mjs` and one npm install, which matters more for a
local demo than framework ergonomics.

### 7. Admin console + telemetry

Admin: moderation queue, users, build monitor, AI spend, generation failure log.

Telemetry: the web player posts level attempts / deaths / clears to `/api/telemetry`,
aggregated into `level_stats`. This closes the loop described in §F4 — if level 12 has a 4%
clear rate across all games, the curve formula is wrong, and now there is data proving it.
APKs send nothing (no INTERNET permission), which is the correct tradeoff.

### 8. Audit loop, then final verification

Two subagents, defined in `.claude/agents/`:

1. **`code-auditor`** — read-only, adversarial, finds defects, fixes nothing. Given the
   codebase's invariants (determinism, beatability, physics parity, offline guarantee,
   append-only credits, server-side authz, parameterised SQL) and an explicit list of what
   does *not* count as a finding.
2. **`fix-verifier`** — independently verifies each finding, fixes only CONFIRMED ones,
   rejects false positives, and must prove each fix with tests.

The split exists because an auditor that also fixes will rationalise its own findings.
Separating "find" from "confirm and fix" means a wrong finding gets thrown out instead of
turned into a wrong edit.

Loop until the auditor returns clean, then run the full end-to-end pass: signup → generate
both genres → refine → build both APKs → download → remix → admin → telemetry.

---

## Order of execution

Data layer first because auth, credits, arcade and admin all sit on it. Refinement before
the frontend so the UI is built against a feature that actually works. Second genre before
the frontend so the genre picker is real rather than a placeholder.

```
1  plan + agents            ✔ this document
2  packages/db
3  auth + rate limit + credits
4  deterministic refinement
5  Tap-to-Fly genre
6  frontend
7  admin + telemetry
8  audit loop + final e2e
```

## Definition of done

A visitor can, entirely on localhost:

1. Land on a real marketing page and play a demo game in seconds
2. Generate a game anonymously, then hit a signup wall to save it
3. Sign up and receive starter credits
4. Generate in **two** genres, watching real pipeline stages stream
5. Refine conversationally — **with no API key**
6. See the difficulty ladder and per-level validation metrics
7. Build and download a signed offline APK, with install guidance
8. Publish to the arcade; another account remixes it
9. Buy a credit pack (mock) and see the ledger
10. Be blocked when asking for copyrighted IP
11. Admin: moderate a report, watch a build, review AI spend
12. `npm test` green; every generated level proven beatable
