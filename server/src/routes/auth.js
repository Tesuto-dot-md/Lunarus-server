import express from 'express';
import {
  ALLOW_USERNAME_LOGIN,
  ENFORCE_EMAIL_VERIFICATION,
  PUBLIC_BASE_URL,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
} from '../config.js';
import {
  hashPassword,
  randomToken,
  signJwt,
  verifyPassword,
} from '../auth/core.js';

export function createAuthRouter(deps) {
  const {
    pool,
    normalizeEmail,
    isValidEmail,
    isValidUsername,
    isValidPassword,
    setRefreshCookie,
    clearRefreshCookie,
    getPublicBaseUrl,
    sendEmail,
    createEmailToken,
    consumeEmailToken,
    htmlPage,
    genId,
    sha256Hex,
    accounts,
  } = deps;

  const router = express.Router();

  // Simple in-memory rate limiter (per-process).
  // For multi-instance prod it's better to move this to Redis.
  const rate = new Map(); // key -> { count, resetAt }

  function hitRate(key, limit, windowMs) {
    const now = Date.now();
    const cur = rate.get(key);

    if (!cur || cur.resetAt < now) {
      rate.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true, remaining: limit - 1 };
    }

    if (cur.count >= limit) {
      return { ok: false, retryAfterMs: cur.resetAt - now };
    }

    cur.count += 1;
    return { ok: true, remaining: limit - cur.count };
  }

  function userJwtPayload(userRow) {
    return {
      sub: String(userRow.id),
      username: String(userRow.username),
    };
  }

  async function buildAuthUser(userId, fallbackUser = null, includePrivate = true) {
    if (accounts?.getMeDto && includePrivate) {
      const user = await accounts.getMeDto(String(userId));
      if (user) return user;
    }

    if (accounts?.getUserDtoById && !includePrivate) {
      const user = await accounts.getUserDtoById(String(userId));
      if (user) return user;
    }

    if (fallbackUser) return fallbackUser;

    const r = await pool.query(
      `
      SELECT
        id,
        email,
        email_verified,
        username,
        created_at,
        updated_at,
        deleted_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [String(userId)]
    );

    if (!r.rowCount) return null;

    const u = r.rows[0];
    const base = {
      id: String(u.id),
      username: String(u.username),
      createdAt: u.created_at == null ? null : Number(u.created_at),
    };

    if (!includePrivate) return base;

    return {
      ...base,
      email: u.email == null ? null : String(u.email),
      emailVerified: Boolean(u.email_verified),
      updatedAt: u.updated_at == null ? null : Number(u.updated_at),
      deletedAt: u.deleted_at == null ? null : Number(u.deleted_at),
    };
  }

  async function issueRefreshToken({ userId, req }) {
    const token = randomToken(48);
    const tokenHash = sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + REFRESH_TOKEN_TTL_MS;
    const userAgent = String(req.headers['user-agent'] || '');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');

    const r = await pool.query(
      `
      INSERT INTO refresh_tokens(user_id, token_hash, created_at, expires_at, user_agent, ip)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
      `,
      [String(userId), tokenHash, now, expiresAt, userAgent, ip]
    );

    return {
      token,
      id: Number(r.rows[0].id),
    };
  }

  async function getValidRefreshTokenRow(token) {
    const tokenHash = sha256Hex(token);
    const now = Date.now();

    const r = await pool.query(
      `
      SELECT
        id,
        user_id AS "userId",
        expires_at AS "expiresAt",
        revoked_at AS "revokedAt"
      FROM refresh_tokens
      WHERE token_hash = $1
      LIMIT 1
      `,
      [tokenHash]
    );

    if (r.rowCount === 0) return null;

    const row = r.rows[0];
    if (row.revokedAt) return null;
    if (Number(row.expiresAt) < now) return null;

    return {
      id: Number(row.id),
      userId: String(row.userId),
      expiresAt: Number(row.expiresAt),
    };
  }

  async function revokeRefreshToken(id, replacedById = null) {
    const now = Date.now();

    await pool.query(
      `
      UPDATE refresh_tokens
      SET revoked_at = $2, replaced_by = $3
      WHERE id = $1 AND revoked_at IS NULL
      `,
      [Number(id), now, replacedById]
    );
  }

  async function autoJoinDefaultServer(userId) {
    if (!pool) return;

    try {
      await pool.query(
        `
        INSERT INTO server_members(server_id, user_id, nickname, joined_at)
        VALUES ('lunarus', $1, NULL, $2)
        ON CONFLICT (server_id, user_id) DO NOTHING
        `,
        [String(userId), Date.now()]
      );
    } catch (e) {
      console.warn('[WARN] failed to upsert server_members during auth', e);
    }

    try {
      await pool.query(
        `
        INSERT INTO user_settings(user_id, settings, updated_at)
        VALUES ($1, '{}'::jsonb, $2)
        ON CONFLICT (user_id) DO NOTHING
        `,
        [String(userId), Date.now()]
      );
    } catch (e) {
      console.warn('[WARN] failed to upsert user_settings during auth', e);
    }

    try {
      if (accounts?.ensureCompanionRows) {
        await accounts.ensureCompanionRows(String(userId));
      }
    } catch (e) {
      console.warn('[WARN] failed to ensure v2 profile/presence rows during auth', e);
    }
  }

  router.post('/auth/register', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'db_not_configured' });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip');
    const rl = hitRate(`reg:${ip}`, 10, 10 * 60_000);
    if (!rl.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const { email, username, password } = req.body ?? {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'bad_email' });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'bad_username' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'bad_password' });
    }

    let user;
    try {
      if (accounts?.createAccount) {
        user = await accounts.createAccount({
          email,
          username,
          password,
          normalizeEmail,
          hashPassword,
        });
      } else {
        const emailNorm = normalizeEmail(email);
        const uname = String(username).trim();
        const unameNorm = uname.toLowerCase();
        const userId = genId ? genId('u') : `u_${Math.random().toString(36).slice(2, 12)}`;
        const passHash = await hashPassword(password);
        const now = Date.now();

        await pool.query(
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
            last_username_change_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9)
          `,
          [userId, String(email).trim(), emailNorm, uname, unameNorm, passHash, now, now, now]
        );

        user = await buildAuthUser(userId, { id: userId, username: uname }, true);
      }
    } catch (e) {
      const code = String(e?.code || e?.message || '');
      if (code === 'email_taken') {
        return res.status(409).json({ error: 'email_taken' });
      }
      if (code === 'username_taken') {
        return res.status(409).json({ error: 'username_taken' });
      }
      if (code === 'already_exists') {
        return res.status(409).json({ error: 'already_exists' });
      }

      console.error('[ERR] register failed', e);
      return res.status(500).json({ error: 'register_failed' });
    }

    const token = await createEmailToken({
      userId: String(user.id),
      type: 'verify',
      ttlMs: 24 * 60 * 60_000,
    });

    const base = getPublicBaseUrl(req) || PUBLIC_BASE_URL || '';
    const link = base
      ? `${base}/auth/verify-email?token=${encodeURIComponent(token)}`
      : '';

    const subject = 'Lunarus: подтвердите почту';
    const text = `Добро пожаловать в Lunarus!

Чтобы подтвердить почту, откройте ссылку:
${link || '(ссылка недоступна — проверьте PUBLIC_BASE_URL)'}

Если это были не вы — просто игнорируйте письмо.
`;

    const sent = await sendEmail({
      to: normalizeEmail(email),
      subject,
      text,
    });

    if (!sent) {
      console.log(`[DEV] Verification token for ${normalizeEmail(email)}: ${token}`);
    }

    return res.json({
      ok: true,
      sent,
      user,
      devOnlyToken: sent ? undefined : token,
    });
  });

  router.get('/auth/verify-email', async (req, res) => {
    if (!pool) {
      return res.status(500).send(htmlPage('Ошибка', 'DB не настроен.'));
    }

    const token = String(req.query.token || '').trim();
    if (!token) {
      return res.status(400).send(htmlPage('Ошибка', 'Нет token.'));
    }

    const consumed = await consumeEmailToken({ type: 'verify', token });
    if (!consumed.ok) {
      return res
        .status(400)
        .send(htmlPage('Ошибка', `Токен недействителен: ${consumed.reason}.`));
    }

    if (accounts?.markEmailVerified) {
      await accounts.markEmailVerified(consumed.userId);
    } else {
      await pool.query(
        `UPDATE users SET email_verified = true WHERE id = $1`,
        [String(consumed.userId)]
      );
    }

    return res
      .status(200)
      .send(
        htmlPage(
          'Готово',
          'Почта подтверждена. Можно возвращаться в приложение и входить.'
        )
      );
  });

  router.post('/auth/verify-email', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'db_not_configured' });
    }

    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'missing_token' });
    }

    const consumed = await consumeEmailToken({ type: 'verify', token });
    if (!consumed.ok) {
      return res.status(400).json({
        error: 'bad_token',
        reason: consumed.reason,
      });
    }

    if (accounts?.markEmailVerified) {
      await accounts.markEmailVerified(consumed.userId);
    } else {
      await pool.query(
        `UPDATE users SET email_verified = true WHERE id = $1`,
        [String(consumed.userId)]
      );
    }

    return res.json({ ok: true });
  });

  router.post('/auth/resend-verification', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'db_not_configured' });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip');
    const rl = hitRate(`resend:${ip}`, 10, 10 * 60_000);
    if (!rl.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const email = normalizeEmail(req.body?.email || '');
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'bad_email' });
    }

    const r = await pool.query(
      `
      SELECT id, email_verified
      FROM users
      WHERE email_norm = $1 AND deleted_at IS NULL
      `,
      [email]
    );

    if (r.rowCount === 0) {
      return res.json({ ok: true, sent: true });
    }

    if (Boolean(r.rows[0].email_verified)) {
      return res.json({ ok: true, sent: true });
    }

    const token = await createEmailToken({
      userId: String(r.rows[0].id),
      type: 'verify',
      ttlMs: 24 * 60 * 60_000,
    });

    const base = getPublicBaseUrl(req) || PUBLIC_BASE_URL || '';
    const link = base
      ? `${base}/auth/verify-email?token=${encodeURIComponent(token)}`
      : '';

    const subject = 'Lunarus: подтверждение почты';
    const text = `Ссылка для подтверждения:
${link}
`;

    const sent = await sendEmail({ to: email, subject, text });
    if (!sent) {
      console.log(`[DEV] Verification token for ${email}: ${token}`);
    }

    return res.json({
      ok: true,
      sent,
      devOnlyToken: sent ? undefined : token,
    });
  });

  router.post('/auth/login', async (req, res) => {
    const { email, password, username } = req.body ?? {};

    // Main v2 login: email + password
    if (email !== undefined && email !== null) {
      if (!pool) {
        return res.status(500).json({ error: 'db_not_configured' });
      }

      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip');
      const rl = hitRate(`login:${ip}`, 30, 10 * 60_000);
      if (!rl.ok) {
        return res.status(429).json({
          error: 'rate_limited',
          retryAfterMs: rl.retryAfterMs,
        });
      }

      const emailNorm = normalizeEmail(email);
      if (!isValidEmail(emailNorm)) {
        return res.status(400).json({ error: 'bad_email' });
      }
      if (!isValidPassword(password)) {
        return res.status(400).json({ error: 'bad_password' });
      }

      let userRow = null;

      if (accounts?.verifyEmailPassword) {
        userRow = await accounts.verifyEmailPassword({
          email: emailNorm,
          password,
          normalizeEmail,
          verifyPassword,
        });
      } else {
        const r = await pool.query(
          `
          SELECT id, username, pass_hash, email_verified
          FROM users
          WHERE email_norm = $1 AND deleted_at IS NULL
          `,
          [emailNorm]
        );

        if (r.rowCount > 0) {
          const u = r.rows[0];
          const ok = await verifyPassword(u.pass_hash, password);
          if (ok) userRow = u;
        }
      }

      if (!userRow) {
        return res.status(401).json({ error: 'bad_credentials' });
      }

      if (ENFORCE_EMAIL_VERIFICATION && !Boolean(userRow.email_verified)) {
        return res.status(403).json({ error: 'email_not_verified' });
      }

      const accessToken = signJwt(userJwtPayload(userRow));
      await autoJoinDefaultServer(String(userRow.id));

      const rt = await issueRefreshToken({ userId: String(userRow.id), req });
      setRefreshCookie(res, rt.token);

      const isBrowser = Boolean(req.headers.origin);
      const user = await buildAuthUser(
        String(userRow.id),
        { id: String(userRow.id), username: String(userRow.username) },
        true
      );

      return res.json({
        token: accessToken,
        accessToken,
        refreshToken: isBrowser ? undefined : rt.token,
        user,
      });
    }

    // Optional legacy login by username
    if (!ALLOW_USERNAME_LOGIN) {
      return res.status(400).json({ error: 'email_required' });
    }

    const usernameValue = String(username ?? '').trim();
    if (!usernameValue) {
      return res.status(400).json({ error: 'bad_username' });
    }

    let legacyUser = null;

    if (accounts?.getUserForAuthByUsernameNorm) {
      legacyUser = await accounts.getUserForAuthByUsernameNorm(
        usernameValue.toLowerCase()
      );
    }

    if (legacyUser) {
      const accessToken = signJwt(userJwtPayload(legacyUser));
      await autoJoinDefaultServer(String(legacyUser.id));

      const rt = await issueRefreshToken({ userId: String(legacyUser.id), req });
      setRefreshCookie(res, rt.token);

      const isBrowser = Boolean(req.headers.origin);
      const user = await buildAuthUser(
        String(legacyUser.id),
        { id: String(legacyUser.id), username: String(legacyUser.username) },
        true
      );

      return res.json({
        token: accessToken,
        accessToken,
        refreshToken: isBrowser ? undefined : rt.token,
        user,
      });
    }

    // Legacy dev fallback: stateless token only
    const fallbackUser = {
      id: usernameValue,
      username: usernameValue,
    };
    const accessToken = signJwt({
      sub: fallbackUser.id,
      username: fallbackUser.username,
    });

    return res.json({
      token: accessToken,
      accessToken,
      user: fallbackUser,
    });
  });

  router.post('/auth/refresh', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'db_not_configured' });
    }

    const cookieToken = req.cookies ? req.cookies[REFRESH_COOKIE_NAME] : null;
    const bodyToken = req.body?.refreshToken;
    const token = String(cookieToken || bodyToken || '').trim();

    if (!token) {
      return res.status(401).json({ error: 'missing_refresh_token' });
    }

    const row = await getValidRefreshTokenRow(token);
    if (!row) {
      return res.status(401).json({ error: 'bad_refresh_token' });
    }

    const rt2 = await issueRefreshToken({ userId: row.userId, req });
    await revokeRefreshToken(row.id, rt2.id);
    setRefreshCookie(res, rt2.token);

    const u = await pool.query(
      `
      SELECT id, username
      FROM users
      WHERE id = $1 AND deleted_at IS NULL
      `,
      [String(row.userId)]
    );

    const userRow =
      u.rowCount > 0
        ? {
            id: String(u.rows[0].id),
            username: String(u.rows[0].username),
          }
        : {
            id: String(row.userId),
            username: 'user',
          };

    const accessToken = signJwt({
      sub: userRow.id,
      username: userRow.username,
    });

    const user = await buildAuthUser(userRow.id, userRow, true);
    const isBrowser = Boolean(req.headers.origin) && Boolean(cookieToken);

    return res.json({
      token: accessToken,
      accessToken,
      refreshToken: isBrowser ? undefined : rt2.token,
      user,
    });
  });

  router.post('/auth/logout', async (req, res) => {
    if (!pool) {
      return res.status(200).json({ ok: true });
    }

    const cookieToken = req.cookies ? req.cookies[REFRESH_COOKIE_NAME] : null;
    const bodyToken = req.body?.refreshToken;
    const token = String(cookieToken || bodyToken || '').trim();

    if (token) {
      const row = await getValidRefreshTokenRow(token);
      if (row) {
        await revokeRefreshToken(row.id, null);
      }
    }

    clearRefreshCookie(res);
    return res.json({ ok: true });
  });

  router.post('/auth/forgot', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'db_not_configured' });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip');
    const rl = hitRate(`forgot:${ip}`, 10, 10 * 60_000);
    if (!rl.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const email = normalizeEmail(req.body?.email || '');
    if (!isValidEmail(email)) {
      return res.json({ ok: true, sent: true });
    }

    const r = await pool.query(
      `
      SELECT id, email_verified
      FROM users
      WHERE email_norm = $1 AND deleted_at IS NULL
      `,
      [email]
    );

    if (r.rowCount === 0) {
      return res.json({ ok: true, sent: true });
    }

    if (ENFORCE_EMAIL_VERIFICATION && !Boolean(r.rows[0].email_verified)) {
      return res.json({ ok: true, sent: true });
    }

    const token = await createEmailToken({
      userId: String(r.rows[0].id),
      type: 'reset',
      ttlMs: 30 * 60 * 1000,
    });

    const base = getPublicBaseUrl(req) || PUBLIC_BASE_URL || '';
    const link = base
      ? `${base}/auth/reset?token=${encodeURIComponent(token)}`
      : '';

    const subject = 'Lunarus: сброс пароля';
    const text = `Ссылка для сброса пароля (30 минут):
${link}
`;

    const sent = await sendEmail({ to: email, subject, text });
    if (!sent) {
      console.log(`[DEV] Reset token for ${email}: ${token}`);
    }

    return res.json({
      ok: true,
      sent,
      devOnlyToken: sent ? undefined : token,
    });
  });

  router.post('/auth/reset', async (req, res) => {
    if (!pool) {
      return res.status(500).json({ error: 'db_not_configured' });
    }

    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!token) {
      return res.status(400).json({ error: 'missing_token' });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'bad_password' });
    }

    const consumed = await consumeEmailToken({ type: 'reset', token });
    if (!consumed.ok) {
      return res.status(400).json({
        error: 'bad_token',
        reason: consumed.reason,
      });
    }

    if (accounts?.setPassword) {
      await accounts.setPassword({
        userId: consumed.userId,
        newPassword,
        hashPassword,
        revokeAllSessions: true,
      });
    } else {
      const passHash = await hashPassword(newPassword);
      const now = Date.now();

      await pool.query(
        `UPDATE users SET pass_hash = $2, updated_at = $3 WHERE id = $1`,
        [String(consumed.userId), passHash, now]
      );

      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
        [String(consumed.userId), now]
      );
    }

    return res.json({ ok: true });
  });

  return router;
}