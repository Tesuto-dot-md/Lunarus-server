import express from 'express';
import {
  ALLOW_USERNAME_LOGIN,
  ENFORCE_EMAIL_VERIFICATION,
  PUBLIC_BASE_URL,
  REFRESH_COOKIE_NAME,
} from '../common/config.js';

import { normalizeEmail, isValidEmail, isValidUsername, isValidPassword } from '../common/validation.js';
import { createEmailService } from '../email.js';

export function createAuthRouter(deps) {
  const {
    accounts,
    getPublicBaseUrl,
  } = deps;

  const emailService = createEmailService({ pool: deps.pool });

  const router = express.Router();

  // Простой rate-limiter
  const rate = new Map();

  function hitRate(key, limit, windowMs) {
    const now = Date.now();
    const cur = rate.get(key) || { count: 0, resetAt: now + windowMs };
    if (cur.resetAt < now) cur = { count: 0, resetAt: now + windowMs };

    if (cur.count >= limit) return { ok: false, retryAfterMs: cur.resetAt - now };

    cur.count++;
    rate.set(key, cur);
    return { ok: true };
  }

  // ====================== REGISTER ======================
  router.post('/auth/register', async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    if (!hitRate(`reg:${ip}`, 10, 10 * 60_000).ok) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    const { email, username, password } = req.body ?? {};

    try {
      const user = await accounts.createAccount({ email, username, password });

      // Отправляем письмо подтверждения
      const token = await emailService.createEmailToken({
        userId: user.id,
        type: 'verify',
        ttlMs: 24 * 60 * 60_000,
      });

      const base = getPublicBaseUrl(req) || PUBLIC_BASE_URL || '';
      const link = base ? `${base}/auth/verify-email?token=${encodeURIComponent(token)}` : '';

      const sent = await emailService.sendEmail({
        to: normalizeEmail(email),
        subject: 'Lunarus: подтвердите почту',
        text: `Добро пожаловать!\n\nСсылка: ${link || token}`,
      });

      res.json({
        ok: true,
        user,
        sent,
        devOnlyToken: sent ? undefined : token,
      });
    } catch (err) {
      const code = err.code || err.message;
      if (code === 'email_taken' || code === 'username_taken' || code === 'bad_email' || code === 'bad_username' || code === 'bad_password') {
        return res.status(400).json({ error: code });
      }
      console.error('[register]', err);
      res.status(500).json({ error: 'register_failed' });
    }
  });

  // ====================== VERIFY EMAIL ======================
  router.get('/auth/verify-email', async (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).send('Нет токена');

    const consumed = await emailService.consumeEmailToken({ type: 'verify', token });
    if (!consumed.ok) return res.status(400).send(`Неверный токен: ${consumed.reason}`);

    await accounts.markEmailVerified(consumed.userId);

    res.send('Почта подтверждена! Можешь возвращаться в приложение.');
  });

  // ====================== LOGIN ======================
  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};

    if (!email || !password) return res.status(400).json({ error: 'bad_credentials' });

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    if (!hitRate(`login:${ip}`, 30, 10 * 60_000).ok) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    try {
      const userRow = await accounts.verifyEmailPassword({ email, password });

      if (ENFORCE_EMAIL_VERIFICATION && !userRow.emailVerified) {
        return res.status(403).json({ error: 'email_not_verified' });
      }

      // TODO: JWT + refresh-токены
      const accessToken = `temp-jwt-${userRow.id}`;

      res.json({
        ok: true,
        token: accessToken,
        user: await accounts.getMeDto(userRow.id),
      });
    } catch (err) {
      const code = err.code || 'bad_credentials';
      res.status(code === 'bad_credentials' ? 401 : 400).json({ error: code });
    }
  });

  // ====================== ВСПОМОГАТЕЛЬНЫЕ ======================
  router.post('/auth/refresh', (req, res) => res.status(501).json({ error: 'not_implemented_yet' }));
  router.post('/auth/logout', (req, res) => res.json({ ok: true }));
  router.post('/auth/forgot', (req, res) => res.status(501).json({ error: 'not_implemented_yet' }));
  router.post('/auth/reset', (req, res) => res.status(501).json({ error: 'not_implemented_yet' }));

  return router;
}