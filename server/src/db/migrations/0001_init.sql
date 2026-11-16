-- Ray 初始 schema（GOAL.md §7.1 / §11.1）
-- 所有时间均为 UTC ISO 字符串；布尔用 INTEGER 0/1。

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  daily_quota INTEGER NOT NULL DEFAULT 500,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('openai', 'anthropic', 'gemini', 'ollama')),
  base_url    TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('paid', 'free')),
  priority    INTEGER NOT NULL DEFAULT 100,
  timeout_ms  INTEGER NOT NULL DEFAULT 120000,
  concurrency INTEGER NOT NULL DEFAULT 4,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  id             TEXT PRIMARY KEY,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key_cipher     TEXT NOT NULL,
  label          TEXT NOT NULL,
  group_label    TEXT,
  weight         INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cooling', 'disabled')),
  cooldown_until TEXT,
  daily_quota    INTEGER NOT NULL DEFAULT 1000,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  last_ok_at     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_channel ON keys(channel_id);

-- 路由的唯一依据：一把 Key 能调哪些模型（多对多）
CREATE TABLE IF NOT EXISTS key_models (
  key_id         TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  public_model   TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  weight         INTEGER NOT NULL DEFAULT 1,
  enabled        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key_id, upstream_model, public_model)
);
CREATE INDEX IF NOT EXISTS idx_key_models_public ON key_models(public_model);

CREATE TABLE IF NOT EXISTS key_usage (
  key_id   TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE TABLE IF NOT EXISTS models (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  context             INTEGER NOT NULL DEFAULT 32768,
  caps_json           TEXT NOT NULL DEFAULT '{}',
  tier                TEXT NOT NULL CHECK (tier IN ('free', 'paid')),
  fallback_chain_json TEXT NOT NULL DEFAULT '[]',
  enabled             INTEGER NOT NULL DEFAULT 1
);

-- 付费白名单：粒度 =「Key × 模型」，两列均必填
CREATE TABLE IF NOT EXISTS grants (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id   TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  key_id     TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  expires_at TEXT,
  PRIMARY KEY (user_id, model_id, key_id)
);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS files (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  name       TEXT NOT NULL,
  ref_count  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_ref ON files(ref_count, created_at);

CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sha256     TEXT NOT NULL REFERENCES files(sha256) ON DELETE CASCADE,
  PRIMARY KEY (session_id, sha256)
);

CREATE TABLE IF NOT EXISTS usage_log (
  ray            TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  user_id        TEXT,
  channel_id     TEXT,
  key_id         TEXT,
  public_model   TEXT,
  upstream_model TEXT,
  in_tok         INTEGER,
  out_tok        INTEGER,
  ms             INTEGER,
  status         TEXT,
  err            TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, ts);
