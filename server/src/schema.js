import { pool } from './db.js';
import { createPermissions } from './permissions.js';

const { ensureDefaultRoles } = createPermissions({ pool });

export async function ensureSchema() {
  if (!pool) return;

  // -----------------------------
  // Servers
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      owner_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  // -----------------------------
  // Membership
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      nickname TEXT,
      joined_at BIGINT NOT NULL,
      PRIMARY KEY(server_id, user_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id);`);

  // Backward-compatible migrations for server_members
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';`);
  await pool.query(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;`);

  // -----------------------------
  // Server roles
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      position INT NOT NULL DEFAULT 0,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_managed BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_roles_server_pos ON server_roles(server_id, position DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_member_roles (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY(server_id, user_id, role_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_member_roles_user ON server_member_roles(user_id);`);

  // -----------------------------
  // Channels
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text', -- text | voice | forum
      position INT NOT NULL DEFAULT 0,
      icon TEXT,
      nsfw BOOLEAN NOT NULL DEFAULT false,
      is_private BOOLEAN NOT NULL DEFAULT false,
      linked_text_channel_id TEXT,
      room TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_channels_server_pos ON channels(server_id, position);`);

  // Channel categories
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_categories (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_channel_categories_server_pos ON channel_categories(server_id, position);`);

  // Backward-compatible channel migrations
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS category_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_channels_server_category_pos ON channels(server_id, category_id, position);`);

  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS server_id TEXT;`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS icon TEXT;`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS nsfw BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS linked_text_channel_id TEXT;`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS room TEXT;`);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_at BIGINT;`);

  const nowBackfill = Date.now();
  await pool.query(`UPDATE channels SET server_id = 'lunarus' WHERE server_id IS NULL;`);
  await pool.query(`UPDATE channels SET created_at = $1 WHERE created_at IS NULL;`, [nowBackfill]);

  // -----------------------------
  // Invites
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      channel_id TEXT,
      created_by TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT,
      max_uses INT,
      uses INT NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);`);

  // -----------------------------
  // Messages
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'text',
      media JSONB,
      ts BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, ts);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel_id_id ON messages(channel_id, id DESC);`);

  // Message dedupe
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_nonce TEXT;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_author_nonce
    ON messages(author_id, client_nonce)
    WHERE client_nonce IS NOT NULL;
  `);

  // -----------------------------
  // User settings
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL
    );
  `);

  // -----------------------------
  // Users (Accounts v2 base)
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      email_norm TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL
    );
  `);

  // Legacy profile fields still kept for compatibility
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen BIGINT;`);

  // Accounts v2 columns
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username_norm TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_username_change_at BIGINT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT;`);

  // Backfill v2 account columns
  await pool.query(`UPDATE users SET username_norm = LOWER(username) WHERE username_norm IS NULL;`);
  await pool.query(`UPDATE users SET updated_at = created_at WHERE updated_at IS NULL;`);
  await pool.query(`UPDATE users SET last_username_change_at = created_at WHERE last_username_change_at IS NULL;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_username_norm ON users(username_norm);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email_norm ON users(email_norm);`);

  // -----------------------------
  // Profiles v2
  // -----------------------------
  await pool.query(`
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
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_profiles_updated_at ON user_profiles(updated_at DESC);`);

  // -----------------------------
  // Presence v2
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_presence (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'offline',
      custom_status TEXT,
      last_seen BIGINT,
      updated_at BIGINT NOT NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_presence_status ON user_presence(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON user_presence(last_seen DESC);`);

  // Backfill profile rows from legacy users fields
  await pool.query(`
    INSERT INTO user_profiles (user_id, display_name, avatar_url, bio, updated_at)
    SELECT
      u.id,
      u.display_name,
      u.avatar_url,
      u.bio,
      COALESCE(u.updated_at, u.created_at, $1)
    FROM users u
    ON CONFLICT (user_id) DO NOTHING;
  `, [Date.now()]);

  // Backfill presence rows from legacy users fields
  await pool.query(`
    INSERT INTO user_presence (user_id, status, custom_status, last_seen, updated_at)
    SELECT
      u.id,
      CASE
        WHEN u.last_seen IS NOT NULL THEN 'offline'
        ELSE 'offline'
      END,
      NULL,
      u.last_seen,
      COALESCE(u.updated_at, u.created_at, $1)
    FROM users u
    ON CONFLICT (user_id) DO NOTHING;
  `, [Date.now()]);

  // Keep v2 in sync for old databases where legacy fields might still be edited somewhere
  await pool.query(`
    UPDATE user_profiles p
    SET
      display_name = COALESCE(p.display_name, u.display_name),
      avatar_url = COALESCE(p.avatar_url, u.avatar_url),
      bio = COALESCE(p.bio, u.bio),
      updated_at = COALESCE(p.updated_at, u.updated_at, u.created_at, $1)
    FROM users u
    WHERE p.user_id = u.id;
  `, [Date.now()]);

  await pool.query(`
    UPDATE user_presence pr
    SET
      last_seen = COALESCE(pr.last_seen, u.last_seen),
      updated_at = COALESCE(pr.updated_at, u.updated_at, u.created_at, $1)
    FROM users u
    WHERE pr.user_id = u.id;
  `, [Date.now()]);

  // -----------------------------
  // Email tokens
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- verify | reset
      token_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);`);

  // -----------------------------
  // Refresh tokens / sessions
  // -----------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      revoked_at BIGINT,
      replaced_by BIGINT,
      user_agent TEXT,
      ip TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active ON refresh_tokens(user_id, revoked_at, expires_at);`);

  // -----------------------------
  // Seed default server + channels
  // -----------------------------
  const now = Date.now();

  await pool.query(
    `INSERT INTO servers(id, name, icon, owner_id, created_at)
     VALUES ('lunarus', 'Lunarus', NULL, 'system', $1)
     ON CONFLICT (id) DO NOTHING`,
    [now]
  );

  await ensureDefaultRoles('lunarus');

  const seedChannels = [
    {
      id: 'general',
      name: 'general',
      type: 'text',
      position: 10,
      icon: '#',
      nsfw: false,
      is_private: false,
      linked: null,
      room: null,
    },
    {
      id: 'random',
      name: 'random',
      type: 'text',
      position: 20,
      icon: '#',
      nsfw: false,
      is_private: false,
      linked: null,
      room: null,
    },
    {
      id: 'voice-lobby',
      name: 'Lobby',
      type: 'voice',
      position: 30,
      icon: '🔊',
      nsfw: false,
      is_private: false,
      linked: 'lobby-chat',
      room: 'lobby',
    },
    {
      id: 'lobby-chat',
      name: 'lobby-chat',
      type: 'text',
      position: 31,
      icon: '#',
      nsfw: false,
      is_private: false,
      linked: null,
      room: null,
    },
  ];

  for (const c of seedChannels) {
    await pool.query(
      `INSERT INTO channels(id, server_id, name, type, position, icon, nsfw, is_private, linked_text_channel_id, room, created_at)
       VALUES ($1, 'lunarus', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.name, c.type, c.position, c.icon, c.nsfw, c.is_private, c.linked, c.room, now]
    );
  }
}