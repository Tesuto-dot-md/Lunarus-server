import { pool } from '../../common/db.js';

/** Создание пользователя */
export async function createUser(data) {
  const now = Date.now();
  const r = await pool.query(
    `
    INSERT INTO users (
      id, email, email_norm, username, username_norm, pass_hash,
      email_verified, created_at, updated_at, last_username_change_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
    `,
    [
      data.id,
      data.email,
      data.emailNorm,
      data.username,
      data.usernameNorm,
      data.passHash,
      false,
      now,
      now,
      now,
    ]
  );
  return { id: String(r.rows[0].id) };
}

/** Полные данные пользователя по ID (для внутреннего использования) */
export async function getUserById(userId) {
  const r = await pool.query(
    `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [userId]
  );
  if (!r.rowCount) return null;
  const u = r.rows[0];
  return {
    id: String(u.id),
    email: u.email,
    emailVerified: Boolean(u.email_verified),
    username: String(u.username),
    usernameNorm: String(u.username_norm),
    globalName: u.display_name || null,
    avatarUrl: u.avatar_url || null,
    createdAt: Number(u.created_at),
    updatedAt: Number(u.updated_at || u.created_at),
    lastSeen: u.last_seen ? Number(u.last_seen) : null,
  };
}

/** Только данные для авторизации (email + pass_hash) */
export async function getUserByIdForAuth(emailNorm) {
  const r = await pool.query(
    `SELECT id, pass_hash, email_verified FROM users 
     WHERE email_norm = $1 AND deleted_at IS NULL LIMIT 1`,
    [emailNorm]
  );
  if (!r.rowCount) return null;
  const u = r.rows[0];
  return {
    id: String(u.id),
    passHash: u.pass_hash,
    emailVerified: Boolean(u.email_verified),
  };
}

/** Публичный профиль */
export async function getPublicUser(userId) {
  const r = await pool.query(
    `SELECT id, username, display_name AS "globalName", avatar_url AS "avatarUrl"
     FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [userId]
  );
  if (!r.rowCount) return null;
  const u = r.rows[0];
  return {
    id: String(u.id),
    username: String(u.username),
    globalName: u.globalName || null,
    avatarUrl: u.avatarUrl || null,
  };
}

/** Проверка занятости email / username */
export async function checkAvailability({ emailNorm, usernameNorm }) {
  const r = await pool.query(
    `
    SELECT 
      EXISTS(SELECT 1 FROM users WHERE email_norm = $1) AS email_taken,
      EXISTS(SELECT 1 FROM users WHERE username_norm = $2) AS username_taken
    `,
    [emailNorm, usernameNorm]
  );
  return {
    emailTaken: r.rows[0].email_taken,
    usernameTaken: r.rows[0].username_taken,
  };
}

/** Обновление аккаунта */
export async function updateUser(userId, updates) {
  const now = Date.now();
  const sets = [];
  const params = [userId];
  let i = 2;

  if (updates.email !== undefined) {
    sets.push(`email = $${i++}, email_norm = $${i++}`);
    params.push(updates.email, updates.email?.toLowerCase().trim());
  }
  if (updates.username !== undefined) {
    sets.push(`username = $${i++}, username_norm = $${i++}, last_username_change_at = $${i++}`);
    params.push(updates.username, updates.username?.toLowerCase().trim(), now);
  }
  if (updates.globalName !== undefined) {
    sets.push(`display_name = $${i++}`);
    params.push(updates.globalName);
  }

  sets.push(`updated_at = $${i++}`);
  params.push(now);

  if (sets.length === 0) return false;

  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
  return true;
}

/** Обновление пароля */
export async function updatePassword(userId, passHash) {
  const now = Date.now();
  await pool.query(
    `UPDATE users SET pass_hash = $2, updated_at = $3 WHERE id = $1`,
    [userId, passHash, now]
  );
}

/** Подтверждение email */
export async function markEmailVerified(userId) {
  const now = Date.now();
  await pool.query(
    `UPDATE users SET email_verified = true, updated_at = $2 WHERE id = $1`,
    [userId, now]
  );
}

export default {
  createUser,
  getUserById,
  getUserByIdForAuth,
  getPublicUser,
  checkAvailability,
  updateUser,
  updatePassword,
  markEmailVerified,
};