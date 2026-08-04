# Stitch / AI UI Prompts — Forge Studio

Copy-paste prompts for generating the frontend. Each is self-contained: paste one,
get one screen. Written for Google Stitch but they work in any AI UI tool
(v0, Lovable, Figma AI, Claude artifacts).

**Important:** these tools produce *design + markup*. They do not wire up to a backend.
After generating, the API calls need to be connected — use
[`apps/web/index.html`](../apps/web/index.html) as the working reference. It already talks
to every endpoint correctly (SSE progress, build polling, downloads), so it is the source
of truth for behaviour; Stitch just makes it look better.

---

## The design system — paste this block at the top of EVERY prompt

```
DESIGN SYSTEM (use these exact values):

Colors
  --ink      #06281c   page background (very dark green)
  --g900     #064e3b   deep green
  --g800     #0a5a42   card background / elevated surfaces
  --g700     #11704f   borders, muted fills
  --leaf     #7cb342   primary green accent
  --leaf2    #a3d977   bright green (highlights, success)
  --gold     #fbbf24   PRIMARY CTA colour
  --gold2    #f59e0b   gold hover
  --orange   #ff7043   errors, destructive, warnings
  --text     #eaf5ee   body text
  --muted    #a9c6b5   secondary text

Typography
  Display / headings: 'Bungee', cursive — ALWAYS UPPERCASE, tight
  Body / UI:          'Fredoka', sans-serif — weights 300-700
  Google Fonts: family=Bungee&family=Fredoka:wght@300;400;500;600;700

Shape & depth
  Card radius:    30px
  Inner radius:   22px
  Buttons:        fully rounded pills (border-radius 999px)
  Card border:    1px solid rgba(255,255,255,0.08)
  Card fill:      linear-gradient(180deg, rgba(10,90,66,.5), rgba(6,40,28,.5))
  Shadow:         0 18px 44px rgba(3,30,20,.35)
  Page glow:      radial-gradient(1100px 520px at 78% -12%, rgba(124,179,66,.16), transparent 60%)

Buttons
  Primary:   gold background (#fbbf24), dark text (#24160a), pill, weight 600
  Secondary: rgba(255,255,255,0.09) background, --text colour, pill
  Success:   --leaf background, dark text
  Small:     9px 16px padding, 12px font

Voice
  Confident, technical, no fluff. Headings are short and uppercase.
  Never use the words: Candy Crush, Flappy Bird, Chrome Dino, Mario, Subway Surfers.
  Genres are called: Endless Runner, Tap-to-Fly, Platformer, Match-3 Puzzle, Bubble Pop.

Dark theme only. Mobile-first, responsive up to 1180px max content width.
```

---

## 1. Prompt Studio (the main screen — build this first)

```
[PASTE DESIGN SYSTEM ABOVE]

Design the main creation screen for "Forge Studio", an AI tool that turns one sentence
into a complete 2D game plus a downloadable Android APK.

LAYOUT (top to bottom):

1. Header bar: wordmark "FACTORIALSTUDIO" (the word STUDIO in --leaf2), then small pill
   badges: "FORGE STUDIO", and right-aligned status pills "AI MODE" (green) and
   "ENDLESS RUNNER" (green).

2. Hero: huge two-line uppercase Bungee headline "ONE COMMAND. / A WHOLE GAME."
   Below it, one muted paragraph max 62 characters wide:
   "Describe a game. Get 20 validated levels, an endless mode, a playable build and a
   signed offline Android APK. Every level is proven beatable before it ships."

3. The prompt card (the visual centrepiece):
   - Large pill-shaped text input, dark inset background rgba(0,0,0,.32),
     placeholder "neon cyberpunk runner with a robot, make it hard"
   - Gold pill button "GENERATE" to its right
   - Below: a row of 6 clickable example chips (small, pill, muted, subtle border):
     "neon cyberpunk runner with a robot" / "underwater coral reef dash" /
     "lava volcano escape, make it hard" / "arctic glacier slide, easy" /
     "retro 8bit arcade blitz" / "ek tez jungle runner banao"

4. A GENERATION PROGRESS state inside the same card, shown after clicking Generate.
   This is the most important detail on the screen — show it as a real checklist that
   fills in, NOT a spinner. Five rows, each with a small green arrow/tick:
     Understanding your idea
     Designing game rules
     Building 20 levels
     Checking every level is beatable      <- highlight this one, it is the differentiator
     Packaging your game
   Completed rows are full-brightness --text; the active row is --leaf2; pending rows
   are --muted. Show a small grey sub-label next to rows, e.g. "827 obstacles verified".

5. An error state variant: soft --orange tinted panel, 22px radius, one line of text.
   Example message: "We can't build games using copyrighted characters. Try describing
   your own character instead."

Show BOTH the idle state and the generating state as two frames.
```

---

## 2. My Games — dashboard grid

```
[PASTE DESIGN SYSTEM ABOVE]

Design the "YOUR GAMES" dashboard for Forge Studio.

Section heading "YOUR GAMES" in Bungee, 15px, letter-spacing, --muted colour.

Below it a responsive card grid, minimum card width 268px, 16px gap.

Each game card:
  - Top: a 92px tall "palette strip" — a diagonal gradient using that game's own two
    background colours, with four small 20x20 rounded colour swatches sitting along the
    bottom-left showing the game's ground / player / obstacle / accent colours.
  - Body (14px padding):
      Game title in Bungee 15px uppercase (e.g. "MOLTEN SPRINT")
      One muted line of metadata, 11.5px, two rows:
        "molten · 20 levels · endless mode"
        "v3 · ai · APK 0.35 MB"
      A row of three small pill buttons: green "PLAY", secondary "LEVELS",
      gold "DOWNLOAD APK"
  - Card: 22px radius, subtle border, dark translucent fill.

Show 6 cards with visibly DIFFERENT palettes so the grid looks alive:
  1. MOLTEN SPRINT   — dark red/orange (#1a0703, #ff3b30, #ffd166)
  2. NEON DRIVE      — dark purple/cyan (#0b0620, #00f0ff, #ff2d95)
  3. TIDAL CURRENT   — deep blue/yellow (#021a2b, #ffe066, #4dd0e1)
  4. FROST SLIDE     — icy blue/white (#071a2b, #e0f7ff, #66e0ff)
  5. PIXEL BLITZ     — dark violet/lime (#11071f, #39ff14, #05d9e8)
  6. RUST RUNNER     — dark olive/acid green (#0d1407, #c6ff00, #8d2fbf)

Also design the EMPTY state: a dashed-border panel, 22px radius, centred muted text
"No games yet — generate one above."

One card should show a BUILD IN PROGRESS state where the APK button reads "SIGNING…"
and is disabled.
```

---

## 3. Export Center — APK build & download

```
[PASTE DESIGN SYSTEM ABOVE]

Design the "EXPORT" screen for Forge Studio, where a user turns a generated game into a
downloadable Android APK.

LAYOUT:

1. Header: game title in Bungee uppercase + small palette swatch row + a "v3" version pill.

2. Platform cards row — four cards, 22px radius:
   - "ANDROID APK" — ACTIVE. Shows: "0.35 MB · offline · no permissions",
     a gold pill button "BUILD APK".
   - "WEB EMBED"     — badge "SOON", dimmed to 45% opacity
   - "iOS"           — badge "SOON", dimmed
   - "WINDOWS"       — badge "SOON", dimmed

3. App identity editor: a small form with a label+input for "App name", and an
   app-icon preview (rounded square, 96px) rendered from the game palette — dark
   background, a bright square "player" shape mid-jump, an orange obstacle, a ground band.

4. BUILD PROGRESS panel — a vertical stage list with per-stage tick marks and timings:
     preparing        ok   13ms
     compiling        ok   792ms
     packaging        ok  1770ms
     signing          ok   552ms
     verifying        ok   349ms
   Completed stages get a --leaf2 tick and a --muted duration on the right.
   Show a total line: "APK BUILT IN 4.3S" in Bungee, --leaf2.

5. DOWNLOAD panel (after success):
   - Big gold pill button "DOWNLOAD APK · 0.35 MB"
   - A QR code square (128px) on the right with muted caption "Scan to install on phone"
   - Below, a compact 3-step install guide with numbered circles:
       1. Tap the downloaded file
       2. Allow "Install unknown apps" when Android asks
       3. Open and play — works fully offline
   - A tiny muted note: "No permissions requested. Not even internet."

6. A FAILED state variant: --orange tinted panel with the failing stage named and a
   "RETRY BUILD" secondary button.

Show the success state as the primary frame and the in-progress state as a second frame.
```

---

## 4. Level Inspector — the difficulty ladder

```
[PASTE DESIGN SYSTEM ABOVE]

Design a modal dialog for Forge Studio called "DIFFICULTY LADDER" that shows all 20
generated levels of a game and proves the difficulty curve is well-shaped.

Modal: 30px radius, max-width 1000px, dark --ink background, backdrop
rgba(2,16,11,.8). Header row with the title "MOLTEN SPRINT — DIFFICULTY LADDER" in
Bungee 16px and a secondary pill "CLOSE" button on the right.

Body: a scrollable table, 12px text, columns:
  LV | SPEED | TARGET | SECS | RAMP | NOTE

  - LV: level number 1-20
  - SPEED: px/s, rising from 250 to 860
  - TARGET: distance in metres, rising from 280 m to 1208 m
  - SECS: 28-36s per level
  - RAMP: a thin 7px horizontal bar with rounded ends, filled proportionally with a
    gradient from --leaf to --gold. Bar widths must visibly grow down the table.
  - NOTE: small pills where relevant:
      gold pill "+spike" / "+block" / "+lowbar" / "+pit" / "+drone" / "+saw"
        on levels 1, 4, 8, 11, 14, 17  (a NEW obstacle appears every ~4 levels)
      green pill "relief" on levels 8 and 15  (intentionally slightly easier)

Column headers: uppercase, 10.5px, --muted, letter-spacing.
Row separators: 1px rgba(255,255,255,.06).

Above the table add a compact summary strip of 4 stat tiles:
  "20/20 LEVELS VALID"  ·  "818 OBSTACLES"  ·  "ALL BEATABLE"  ·  "~13.7 MIN PLAYTIME"
Each tile: 22px radius, dark fill, big Bungee number, small --muted caption.
```

---

## 5. Landing page

```
[PASTE DESIGN SYSTEM ABOVE]

Design a marketing landing page for "Forge" by Factorial Studio — a platform where one
sentence becomes a complete 2D game with a downloadable offline Android APK.

SECTIONS:

1. HERO
   - Small pill above the headline: "BY FACTORIAL STUDIO"
   - Bungee headline, 3 lines: "ONE COMMAND. / A WHOLE GAME. / IN YOUR POCKET."
   - Subhead (muted, max 60ch): "Describe a game. Get 20 levels, an endless mode, and a
     signed Android APK that works with no internet. Every level proven beatable."
   - Two pill buttons: gold "CREATE A GAME" and secondary "PLAY THE ARCADE"
   - Right side / below: an embedded PLAYABLE game frame in a 16:9 rounded container
     (30px radius) with a small caption "Playable. Right now. No signup."
     Do NOT show a video play button — this must read as a live game, not a video.

2. HOW IT WORKS — three numbered steps in a row, each a card:
   01 DESCRIBE IT   "One sentence. Any theme. English or Urdu."
   02 WE VALIDATE   "20 levels generated, every one proven beatable before you see it."
   03 SHIP IT       "Playable link plus a signed offline APK in under a minute."

3. THE DIFFERENTIATOR — a wide feature band, split layout:
   Left: Bungee heading "EVERY LEVEL IS PROVEN BEATABLE."
   Body: "Most AI game tools hand you levels nobody tested. We simulate every level
   against real jump physics before it ships — reachability, spacing, reaction time.
   If a level can't be beaten, it never reaches a player."
   Right: a stylised validation checklist visual with green ticks.

4. GENRES — five cards, one live and four coming soon:
   ENDLESS RUNNER (badge "LIVE", green) · TAP-TO-FLY (SOON) · PLATFORMER (SOON) ·
   MATCH-3 PUZZLE (SOON) · BUBBLE POP (SOON)
   Dim the SOON cards to 50%.

5. STATS BAND — four big Bungee numbers with muted captions:
   "0.35 MB" APK SIZE  ·  "4.3s" BUILD TIME  ·  "20" LEVELS PER GAME  ·
   "0" PERMISSIONS REQUIRED

6. PRICING — four pill-toggle cards: Free / $9 / $29 / $79, credits-based.
   Free tier card should say "3 games · unlimited web play · no APK export".
   Highlight the $29 card with a gold border and a "MOST POPULAR" pill.

7. FOOTER — wordmark, real nav links (no dead "#" links), "© 2026 Factorial Studio
   Private Limited. All rights reserved.", and a cookie-consent banner mock at the
   bottom with "Accept essential only" as the PRIMARY button.
```

---

## 6. Arcade / Community (growth loop)

```
[PASTE DESIGN SYSTEM ABOVE]

Design the public "ARCADE" browse page for Forge — where players discover and remix
games other people generated.

1. Header: Bungee "ARCADE", muted subline "Play anything. Remix anything."
2. Filter row: pill toggles "TRENDING / NEW / MOST PLAYED", plus genre pills
   "ALL / ENDLESS RUNNER / TAP-TO-FLY / PLATFORMER / MATCH-3 / BUBBLE POP".
3. Responsive card grid, min card width 268px. Each card:
   - Palette strip header (diagonal gradient from that game's colours)
   - Title in Bungee uppercase, "by @creator" in --muted 11px
   - Small stat row with tiny icons: plays count, downloads count, remix count
   - Two pill buttons: green "PLAY" and gold "REMIX"
   - A small "⋯" menu in the top-right corner containing a "Report" option
4. Make REMIX visually prominent — it is the primary growth loop. Consider a subtle
   gold glow on hover and a small caption under the button: "Fork it and make it yours"
   on the first card.
5. Show 8 cards with clearly different palettes and made-up creator handles.
6. Include one card with a "REPORTED · UNDER REVIEW" dimmed overlay state to show
   moderation.
```

---

## Wiring the generated UI to the API

Once Stitch gives you markup, connect these calls. Full working reference:
[`apps/web/index.html`](../apps/web/index.html).

| UI action | Call |
|---|---|
| Generate (with live progress) | `EventSource('/api/generate/stream?prompt=…')` — listen for `stage`, `done`, `error` |
| Generate (simple) | `POST /api/generate` `{ prompt }` |
| Games grid | `GET /api/games` |
| Play | iframe `src = /play/:id/bundle/` |
| Difficulty ladder | `GET /api/games/:id/ladder` |
| Refine ("make it harder") | `POST /api/games/:id/refine` `{ instruction }` |
| Build APK | `POST /api/games/:id/build` → `{ buildId }` |
| Build progress | `EventSource('/api/builds/:id/stream')` — listen for `update` |
| Download APK | `GET /api/games/:id/apk` |

Two behaviours worth preserving from the reference implementation:

1. **Stage progress must come from the SSE stream**, not a fake timer. The line
   "Checking every level is beatable" is a real pipeline stage and the strongest thing
   the product has to say. Do not turn it into a generic spinner.
2. **The mode pill must reflect `/health`.** It reads `"mode": "llm"` or
   `"deterministic"` — show "AI MODE" (green) or "DETERMINISTIC MODE" (gold) so it is
   always obvious which planner produced a game.
