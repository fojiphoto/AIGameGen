/**
 * Schema + migrations.
 *
 * Built on `node:sqlite`, which ships with Node >= 22. That means a real relational
 * database with transactions and foreign keys, zero dependencies, and no server to
 * run — the cheapest thing that is still correct. §F1 of the design doc calls for
 * Postgres in production; the SQL here is deliberately plain enough to port.
 *
 * Migrations are idempotent and versioned so the file survives restarts and repeated
 * boots without losing data.
 */

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
        status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended'
        created_at    TEXT NOT NULL,
        last_seen_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      -- APPEND-ONLY. Never UPDATE or DELETE a row here.
      -- balance_after is denormalised so reading a balance is O(1); a reconciliation
      -- query asserts SUM(delta) == latest balance_after.
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta         INTEGER NOT NULL,
        reason        TEXT NOT NULL,
        ref_type      TEXT,
        ref_id        TEXT,
        balance_after INTEGER NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, id DESC);

      CREATE TABLE IF NOT EXISTS games (
        id              TEXT PRIMARY KEY,
        user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
        anon_key        TEXT,               -- set for pre-signup games, claimed on signup
        title           TEXT NOT NULL,
        tagline         TEXT,
        genre           TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        source          TEXT NOT NULL,      -- 'llm' | 'deterministic'
        seed            INTEGER NOT NULL,
        package_id      TEXT NOT NULL,
        palette_json    TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 1,
        visibility      TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'public'
        parent_game_id  TEXT REFERENCES games(id) ON DELETE SET NULL,
        play_count      INTEGER NOT NULL DEFAULT 0,
        download_count  INTEGER NOT NULL DEFAULT 0,
        remix_count     INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'ready',    -- 'ready' | 'unpublished'
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_games_user ON games(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_games_public ON games(visibility, play_count DESC);
      CREATE INDEX IF NOT EXISTS idx_games_anon ON games(anon_key);

      CREATE TABLE IF NOT EXISTS game_versions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        report_json TEXT,
        patch_json  TEXT,
        summary     TEXT,
        created_at  TEXT NOT NULL,
        UNIQUE(game_id, version)
      );

      CREATE TABLE IF NOT EXISTS builds (
        id            TEXT PRIMARY KEY,
        game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        version       INTEGER NOT NULL,
        platform      TEXT NOT NULL DEFAULT 'android',
        status        TEXT NOT NULL,       -- queued|running|ready|failed
        stage         TEXT,
        artifact_path TEXT,
        artifact_name TEXT,
        size_bytes    INTEGER,
        package_id    TEXT,
        error         TEXT,
        duration_ms   INTEGER,
        created_at    TEXT NOT NULL,
        finished_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_builds_game ON builds(game_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS plays (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        max_level  INTEGER,
        best_score INTEGER,
        duration_s INTEGER,
        device     TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plays_game ON plays(game_id);

      -- Difficulty tuning feedback loop (§F4). If level 12 clears at 4% across every
      -- generated game, the curve formula is wrong and this table is the proof.
      CREATE TABLE IF NOT EXISTS level_stats (
        game_id  TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        level    INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        clears   INTEGER NOT NULL DEFAULT 0,
        deaths   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (game_id, level)
      );

      CREATE TABLE IF NOT EXISTS reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        reason      TEXT NOT NULL,
        notes       TEXT,
        status      TEXT NOT NULL DEFAULT 'open',  -- open|dismissed|actioned
        created_at  TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

      -- AI audit trail. Needed to price credits honestly (§B8).
      CREATE TABLE IF NOT EXISTS generations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        game_id    TEXT,
        stage      TEXT NOT NULL,
        model      TEXT,
        prompt     TEXT,
        in_tokens  INTEGER NOT NULL DEFAULT 0,
        out_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd   REAL NOT NULL DEFAULT 0,
        status     TEXT NOT NULL,
        latency_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_generations_created ON generations(created_at DESC);

      CREATE TABLE IF NOT EXISTS rate_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket     TEXT NOT NULL,     -- e.g. 'gen:ip:1.2.3.4' or 'build:user:abc'
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_bucket ON rate_events(bucket, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'report_dedup',
    sql: `
      -- Identifies the reporter even when anonymous (user id, or the anon cookie key),
      -- so the same visitor cannot file the same game multiple times to force the
      -- 3-report auto-unpublish threshold on their own.
      ALTER TABLE reports ADD COLUMN reporter_key TEXT;
      CREATE INDEX IF NOT EXISTS idx_reports_dedup ON reports(game_id, reporter_key);
    `,
  },
];

export const CREDIT_COSTS = {
  generate: 10,
  refine: 2,
  reroll_level: 1,
  build_apk: 15,
  remix: 5,
};

export const SIGNUP_GRANT = 30;

/** Mock credit packs. A real Stripe webhook writes the same ledger row shape. */
export const CREDIT_PACKS = [
  { id: 'small', label: 'Small', priceUsd: 9, credits: 100 },
  { id: 'medium', label: 'Medium', priceUsd: 29, credits: 400, popular: true },
  { id: 'large', label: 'Large', priceUsd: 79, credits: 1200 },
];
