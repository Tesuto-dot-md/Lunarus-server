import { pool } from './db.js';
import { createPermissions } from '../permissions.js';

const { ensureDefaultRoles } = createPermissions({ pool });

export async function ensureSchema() {
  if (!pool) {
    console.warn('[WARN] БД не настроена — пропускаем миграцию');
    return;
  }

  console.log('🔧 Применяем чистую схему БД...');

  // ====================== USERS ======================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      email_norm TEXT UNIQUE,
      username TEXT NOT NULL UNIQUE,
      username_norm TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      display_name TEXT,
      avatar_url TEXT,
      accent_color TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_username_change_at BIGINT,
      deleted_at BIGINT,
      last_seen BIGINT
    );
  `);

  // ====================== SERVER ROLES ======================
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

  // ====================== ПРОФИЛИ И ПРИСУТСТВИЕ ======================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      banner_url TEXT,
      bio TEXT,
      about TEXT,
      updated_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_presence (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'offline',
      custom_status TEXT,
      last_seen BIGINT,
      updated_at BIGINT NOT NULL
    );
  `);

  // ====================== ОСТАЛЬНЫЕ ТАБЛИЦЫ ======================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      owner_id TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      nickname TEXT,
      joined_at BIGINT NOT NULL,
      PRIMARY KEY(server_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      position INT NOT NULL DEFAULT 0,
      icon TEXT,
      nsfw BOOLEAN NOT NULL DEFAULT false,
      is_private BOOLEAN NOT NULL DEFAULT false,
      linked_text_channel_id TEXT,
      room TEXT,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'text',
      media JSONB,
      ts BIGINT NOT NULL,
      client_nonce TEXT
    );
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email_norm ON users(email_norm);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_username_norm ON users(username_norm);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, ts);`);

  // Seed default server
  const now = Date.now();
  await pool.query(`
    INSERT INTO servers(id, name, icon, owner_id, created_at)
    VALUES ('lunarus', 'Lunarus', NULL, 'system', $1)
    ON CONFLICT (id) DO NOTHING
  `, [now]);

  await ensureDefaultRoles('lunarus');

  console.log('✅ Схема БД успешно применена');
}