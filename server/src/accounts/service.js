export function createAccountsService({ pool }) {
  if (!pool) {
    throw new Error('createAccountsService: pool is required');
  }

  function mapUserDto(row, { includePrivate = false } = {}) {
    if (!row) return null;

    const dto = {
      id: String(row.id),
      username: String(row.username),
      displayName: row.display_name == null ? null : String(row.display_name),
      avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
      bannerUrl: row.banner_url == null ? null : String(row.banner_url),
      bio: row.bio == null ? null : String(row.bio),
      about: row.about == null ? null : String(row.about),
      accentColor: row.accent_color == null ? null : String(row.accent_color),
      status: row.status == null ? 'offline' : String(row.status),
      customStatus: row.custom_status == null ? null : String(row.custom_status),
      lastSeen: row.last_seen == null ? null : Number(row.last_seen),
      createdAt: row.created_at == null ? null : Number(row.created_at),
    };

    if (includePrivate) {
      dto.email = row.email == null ? null : String(row.email);
      dto.emailVerified = Boolean(row.email_verified);
      dto.updatedAt = row.updated_at == null ? null : Number(row.updated_at);
      dto.deletedAt = row.deleted_at == null ? null : Number(row.deleted_at);
      dto.lastUsernameChangeAt =
          row.last_username_change_at == null
              ? null
              : Number(row.last_username_change_at);
    }

    return dto;
  }

  async function ensureCompanionRows(userId) {
    const now = Date.now();

    await pool.query(
      `
      INSERT INTO user_profiles(user_id, display_name, avatar_url, banner_url, bio, about, accent_color, updated_at)
      VALUES ($1, NULL, NULL, NULL, NULL, NULL, NULL, $2)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [String(userId), now]
    );

    await pool.query(
      `
      INSERT INTO user_presence(user_id, status, custom_status, last_seen, updated_at)
      VALUES ($1, 'offline', NULL, NULL, $2)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [String(userId), now]
    );
  }

  async function getJoinedUserRowById(userId) {
    const r = await pool.query(
      `
      SELECT
        u.id,
        u.email,
        u.email_verified,
        u.username,
        u.username_norm,
        u.created_at,
        u.updated_at,
        u.last_username_change_at,
        u.deleted_at,
        p.display_name,
        p.avatar_url,
        p.banner_url,
        p.bio,
        p.about,
        p.accent_color,
        pr.status,
        pr.custom_status,
        pr.last_seen
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN user_presence pr ON pr.user_id = u.id
      WHERE u.id = $1
      LIMIT 1
      `,
      [String(userId)]
    );

    return r.rowCount > 0 ? r.rows[0] : null;
  }

  async function getUserDtoById(userId) {
    const row = await getJoinedUserRowById(userId);
    if (!row) return null;
    return mapUserDto(row, { includePrivate: false });
  }

  async function getMeDto(userId) {
    const row = await getJoinedUserRowById(userId);
    if (!row) return null;
    return mapUserDto(row, { includePrivate: true });
  }

  async function getUserForAuthByEmail(emailNorm) {
    const r = await pool.query(
      `
      SELECT
        id,
        email,
        email_norm,
        email_verified,
        username,
        username_norm,
        pass_hash,
        created_at,
        updated_at,
        last_username_change_at,
        deleted_at
      FROM users
      WHERE email_norm = $1
      LIMIT 1
      `,
      [String(emailNorm)]
    );
    return r.rowCount > 0 ? r.rows[0] : null;
  }

  async function getUserForAuthByUsernameNorm(usernameNorm) {
    const r = await pool.query(
      `
      SELECT
        id,
        email,
        email_norm,
        email_verified,
        username,
        username_norm,
        pass_hash,
        created_at,
        updated_at,
        last_username_change_at,
        deleted_at
      FROM users
      WHERE username_norm = $1
      LIMIT 1
      `,
      [String(usernameNorm)]
    );
    return r.rowCount > 0 ? r.rows[0] : null;
  }

  async function createAccount({
    email,
    username,
    password,
    normalizeEmail,
    hashPassword,
  }) {
    const now = Date.now();
    const emailTrimmed = String(email || '').trim();
    const usernameTrimmed = String(username || '').trim();
    const emailNorm = normalizeEmail(emailTrimmed);
    const usernameNorm = usernameTrimmed.toLowerCase();
    const passHash = await hashPassword(String(password || ''));

    const id = `u_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;

    let row;
    try {
      const r = await pool.query(
        `
        INSERT INTO users(
          id,
          email,
          email_norm,
          username,
          username_norm,
          pass_hash,
          email_verified,
          created_at,
          updated_at,
          last_username_change_at,
          deleted_at,
          display_name,
          avatar_url,
          bio,
          last_seen
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          false,
          $7,$8,$9,
          NULL,
          $10,
          NULL,
          NULL,
          NULL
        )
        RETURNING id
        `,
        [
          id,
          emailTrimmed,
          emailNorm,
          usernameTrimmed,
          usernameNorm,
          passHash,
          now,
          now,
          now,
          usernameTrimmed,
        ]
      );
      row = r.rows[0];
    } catch (e) {
      if (String(e?.code) === '23505') {
        const detail = String(e?.detail || '').toLowerCase();
        if (detail.includes('email_norm')) {
          const err = new Error('email_taken');
          err.code = 'email_taken';
          throw err;
        }
        if (detail.includes('username') || detail.includes('username_norm')) {
          const err = new Error('username_taken');
          err.code = 'username_taken';
          throw err;
        }
        const err = new Error('already_exists');
        err.code = 'already_exists';
        throw err;
      }
      throw e;
    }

    await pool.query(
      `
      INSERT INTO user_profiles(
        user_id,
        display_name,
        avatar_url,
        banner_url,
        bio,
        about,
        accent_color,
        updated_at
      )
      VALUES ($1, $2, NULL, NULL, NULL, NULL, NULL, $3)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [row.id, usernameTrimmed, now]
    );

    await pool.query(
      `
      INSERT INTO user_presence(user_id, status, custom_status, last_seen, updated_at)
      VALUES ($1, 'offline', NULL, NULL, $2)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [row.id, now]
    );

    return getMeDto(row.id);
  }

  async function verifyEmailPassword({
    email,
    password,
    normalizeEmail,
    verifyPassword,
  }) {
    const emailNorm = normalizeEmail(String(email || '').trim());
    const row = await getUserForAuthByEmail(emailNorm);
    if (!row) return null;

    const ok = await verifyPassword(String(row.pass_hash), String(password || ''));
    if (!ok) return null;

    return row;
  }

  async function markEmailVerified(userId) {
    const now = Date.now();
    await pool.query(
      `UPDATE users SET email_verified = true, updated_at = $2 WHERE id = $1`,
      [String(userId), now]
    );
    return getMeDto(userId);
  }

  async function updateAccount({
    userId,
    email,
    username,
    normalizeEmail,
    isValidEmail,
    isValidUsername,
    usernameCooldownMs = 14 * 24 * 60 * 60 * 1000,
  }) {
    const current = await pool.query(
      `
      SELECT
        id,
        email,
        email_norm,
        username,
        username_norm,
        email_verified,
        created_at,
        updated_at,
        last_username_change_at,
        deleted_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [String(userId)]
    );

    if (current.rowCount === 0) {
      const err = new Error('user_not_found');
      err.code = 'user_not_found';
      throw err;
    }

    const u = current.rows[0];
    const now = Date.now();

    const nextEmail =
      email === undefined ? String(u.email) : String(email || '').trim();
    const nextEmailNorm =
      email === undefined ? String(u.email_norm) : normalizeEmail(nextEmail);

    const nextUsername =
      username === undefined ? String(u.username) : String(username || '').trim();
    const nextUsernameNorm =
      username === undefined
          ? String(u.username_norm || String(u.username).toLowerCase())
          : nextUsername.toLowerCase();

    if (email !== undefined && !isValidEmail(nextEmail)) {
      const err = new Error('bad_email');
      err.code = 'bad_email';
      throw err;
    }

    if (username !== undefined && !isValidUsername(nextUsername)) {
      const err = new Error('bad_username');
      err.code = 'bad_username';
      throw err;
    }

    let nextEmailVerified = Boolean(u.email_verified);
    if (email !== undefined && nextEmailNorm !== String(u.email_norm)) {
      nextEmailVerified = false;
    }

    let nextLastUsernameChangeAt = u.last_username_change_at == null
      ? Number(u.created_at || now)
      : Number(u.last_username_change_at);

    if (username !== undefined && nextUsernameNorm !== String(u.username_norm || '').toLowerCase()) {
      const elapsed = now - nextLastUsernameChangeAt;
      if (elapsed < usernameCooldownMs) {
        const err = new Error('username_cooldown');
        err.code = 'username_cooldown';
        err.retryAfterMs = usernameCooldownMs - elapsed;
        throw err;
      }
      nextLastUsernameChangeAt = now;
    }

    try {
      await pool.query(
        `
        UPDATE users
        SET
          email = $2,
          email_norm = $3,
          username = $4,
          username_norm = $5,
          email_verified = $6,
          updated_at = $7,
          last_username_change_at = $8
        WHERE id = $1
        `,
        [
          String(userId),
          nextEmail,
          nextEmailNorm,
          nextUsername,
          nextUsernameNorm,
          nextEmailVerified,
          now,
          nextLastUsernameChangeAt,
        ]
      );
    } catch (e) {
      if (String(e?.code) === '23505') {
        const detail = String(e?.detail || '').toLowerCase();
        if (detail.includes('email_norm')) {
          const err = new Error('email_taken');
          err.code = 'email_taken';
          throw err;
        }
        if (detail.includes('username') || detail.includes('username_norm')) {
          const err = new Error('username_taken');
          err.code = 'username_taken';
          throw err;
        }
      }
      throw e;
    }

    if (username !== undefined && nextUsername !== String(u.username)) {
      await pool.query(
        `
        UPDATE user_profiles
        SET
          display_name = COALESCE(display_name, $2),
          updated_at = $3
        WHERE user_id = $1
        `,
        [String(userId), nextUsername, now]
      );

      await pool.query(
        `
        UPDATE users
        SET display_name = COALESCE(display_name, $2)
        WHERE id = $1
        `,
        [String(userId), nextUsername]
      );
    }

    return getMeDto(userId);
  }

  async function setPassword({
    userId,
    newPassword,
    hashPassword,
    revokeAllSessions = true,
  }) {
    const now = Date.now();
    const passHash = await hashPassword(String(newPassword || ''));

    await pool.query(
      `UPDATE users SET pass_hash = $2, updated_at = $3 WHERE id = $1`,
      [String(userId), passHash, now]
    );

    if (revokeAllSessions) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
        [String(userId), now]
      );
    }
  }

  async function listSessions(userId) {
    const now = Date.now();
    const r = await pool.query(
      `
      SELECT
        id,
        created_at,
        expires_at,
        revoked_at,
        replaced_by,
        user_agent,
        ip
      FROM refresh_tokens
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [String(userId)]
    );

    return r.rows.map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at == null ? null : Number(row.created_at),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
      replacedBy: row.replaced_by == null ? null : Number(row.replaced_by),
      userAgent: row.user_agent == null ? null : String(row.user_agent),
      ip: row.ip == null ? null : String(row.ip),
      isActive:
          row.revoked_at == null &&
          row.expires_at != null &&
          Number(row.expires_at) > now,
    }));
  }

  async function revokeSession({ userId, sessionId }) {
    const now = Date.now();
    const r = await pool.query(
      `
      UPDATE refresh_tokens
      SET revoked_at = $3
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id
      `,
      [Number(sessionId), String(userId), now]
    );

    return r.rowCount > 0;
  }

  async function revokeAllSessions({ userId, exceptSessionId = null }) {
    const now = Date.now();

    if (exceptSessionId == null) {
      const r = await pool.query(
        `
        UPDATE refresh_tokens
        SET revoked_at = $2
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id
        `,
        [String(userId), now]
      );
      return r.rowCount;
    }

    const r = await pool.query(
      `
      UPDATE refresh_tokens
      SET revoked_at = $3
      WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2
      RETURNING id
      `,
      [String(userId), Number(exceptSessionId), now]
    );
    return r.rowCount;
  }

  async function touchLastSeen(userId, status = 'online') {
    const now = Date.now();

    await ensureCompanionRows(userId);

    await pool.query(
      `
      UPDATE user_presence
      SET
        status = $2,
        last_seen = $3,
        updated_at = $3
      WHERE user_id = $1
      `,
      [String(userId), String(status || 'online'), now]
    );

    await pool.query(
      `
      UPDATE users
      SET last_seen = $2, updated_at = $2
      WHERE id = $1
      `,
      [String(userId), now]
    );
  }

  return {
    mapUserDto,
    ensureCompanionRows,
    getUserDtoById,
    getMeDto,
    getUserForAuthByEmail,
    getUserForAuthByUsernameNorm,
    createAccount,
    verifyEmailPassword,
    markEmailVerified,
    updateAccount,
    setPassword,
    listSessions,
    revokeSession,
    revokeAllSessions,
    touchLastSeen,
  };
}