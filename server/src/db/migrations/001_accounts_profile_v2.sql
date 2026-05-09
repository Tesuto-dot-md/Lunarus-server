-- Accounts/Profile v2 schema for Lunarus
-- Safe to run multiple times.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username_norm TEXT,
  ADD COLUMN IF NOT EXISTS updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_username_change_at BIGINT,
  ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

UPDATE users
SET username_norm = lower(username)
WHERE username_norm IS NULL;

UPDATE users
SET updated_at = COALESCE(updated_at, created_at)
WHERE updated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_norm_unique
  ON users(username_norm)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  banner_url TEXT,
  bio TEXT,
  about TEXT,
  accent_color TEXT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_presence (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'offline',
  custom_status TEXT,
  last_seen BIGINT,
  updated_at BIGINT NOT NULL,
  CONSTRAINT chk_user_presence_status CHECK (status IN ('online','idle','dnd','offline','invisible'))
);

CREATE INDEX IF NOT EXISTS idx_user_presence_status ON user_presence(status);
CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON user_presence(last_seen DESC);
