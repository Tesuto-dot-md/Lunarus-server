import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import express from 'express';

export function createMeRouter({
  pool,
  authMiddleware,
  accounts,
  profiles,
  presence,
  avatarUpload,
  UPLOAD_DIR,
  ensureDirSync,
  safeUnlinkIfLocal,
  normalizeEmail,
  isValidEmail,
  isValidUsername,
  hashPassword,
  verifyPassword,
  isValidPassword,
}) {
  const router = express.Router();

  if (!pool) throw new Error('createMeRouter: pool is required');
  if (!authMiddleware) throw new Error('createMeRouter: authMiddleware is required');
  if (!accounts) throw new Error('createMeRouter: accounts service is required');
  if (!profiles) throw new Error('createMeRouter: profiles service is required');
  if (!presence) throw new Error('createMeRouter: presence service is required');

  function getUserId(req) {
    return String(req.user?.sub || '');
  }

  function sendKnownError(res, err, fallback = 'bad_request') {
    const code = String(err?.code || err?.message || fallback);

    switch (code) {
      case 'user_not_found': return res.status(404).json({ error: 'user_not_found' });
      case 'bad_email': return res.status(400).json({ error: 'bad_email' });
      case 'bad_username': return res.status(400).json({ error: 'bad_username' });
      case 'bad_password': return res.status(400).json({ error: 'bad_password' });
      case 'bad_status': return res.status(400).json({ error: 'bad_status' });
      case 'bad_accent_color': return res.status(400).json({ error: 'bad_accent_color' });
      case 'email_taken': return res.status(409).json({ error: 'email_taken' });
      case 'username_taken': return res.status(409).json({ error: 'username_taken' });
      case 'username_cooldown': return res.status(429).json({ error: 'username_cooldown', retryAfterMs: Number(err?.retryAfterMs || 0) });
      case 'nothing_to_update': return res.status(400).json({ error: 'nothing_to_update' });
      case 'bad_credentials': return res.status(403).json({ error: 'bad_credentials' });
      default: return res.status(400).json({ error: fallback });
    }
  }

  async function buildMeResponse(userId) {
    const user = await accounts.getMeDto(userId);
    if (!user) return null;

    const profile = await profiles.getProfile(userId);
    const pres = await presence.getPresence(userId);

    return {
      ...user,
      displayName: profile?.displayName ?? user.displayName ?? null,
      avatarUrl: profile?.avatarUrl ?? user.avatarUrl ?? null,
      bannerUrl: profile?.bannerUrl ?? user.bannerUrl ?? null,
      bio: profile?.bio ?? user.bio ?? null,
      about: profile?.about ?? user.about ?? null,
      accentColor: profile?.accentColor ?? user.accentColor ?? null,
      status: pres?.status ?? user.status ?? 'offline',
      customStatus: pres?.customStatus ?? user.customStatus ?? null,
      lastSeen: pres?.lastSeen ?? user.lastSeen ?? null,
    };
  }

  // ====================== НОВЫЙ ГЛАВНЫЙ ЭНДПОИНТ ======================
  router.patch('/me', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const changes = {};

    // Account fields
    if (Object.prototype.hasOwnProperty.call(body, 'email')) {
      const email = String(body.email ?? '').trim();
      if (email && !isValidEmail(email)) return res.status(400).json({ error: 'bad_email' });
      changes.email = email || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'username')) {
      const username = String(body.username ?? '').trim();
      if (username && !isValidUsername(username)) return res.status(400).json({ error: 'bad_username' });
      changes.username = username || null;
    }

    // Profile fields
    if (Object.prototype.hasOwnProperty.call(body, 'displayName') || Object.prototype.hasOwnProperty.call(body, 'display_name')) {
      changes.displayName = body.displayName ?? body.display_name ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'bio')) {
      changes.bio = body.bio ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'about')) {
      changes.about = body.about ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'accentColor') || Object.prototype.hasOwnProperty.call(body, 'accent_color')) {
      changes.accentColor = body.accentColor ?? body.accent_color ?? null;
    }

    // Presence fields
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      changes.status = body.status;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'customStatus') || Object.prototype.hasOwnProperty.call(body, 'custom_status')) {
      changes.customStatus = body.customStatus ?? body.custom_status ?? null;
    }

    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    try {
      // Обновляем по частям (всё ещё используем существующие сервисы)
      if (changes.email !== undefined || changes.username !== undefined) {
        await accounts.updateAccount({
          userId,
          email: changes.email,
          username: changes.username,
          normalizeEmail,
          isValidEmail,
          isValidUsername,
        });
      }

      if (changes.displayName !== undefined || changes.bio !== undefined || changes.about !== undefined || changes.accentColor !== undefined) {
        await profiles.updateProfile({
          userId,
          displayName: changes.displayName,
          bio: changes.bio,
          about: changes.about,
          accentColor: changes.accentColor,
        });
      }

      if (changes.status !== undefined || changes.customStatus !== undefined) {
        await presence.setPresence({
          userId,
          status: changes.status,
          customStatus: changes.customStatus,
        });
      }

      const user = await buildMeResponse(userId);
      return res.json({ ok: true, user });
    } catch (err) {
      return sendKnownError(res, err, 'me_update_failed');
    }
  });

  router.patch('/me/profile', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : null;

    if (!body) {
      return res.status(400).json({ error: 'body_must_be_object' });
    }

    const hasDisplayName =
      Object.prototype.hasOwnProperty.call(body, 'displayName') ||
      Object.prototype.hasOwnProperty.call(body, 'display_name');
    const hasBio = Object.prototype.hasOwnProperty.call(body, 'bio');
    const hasAbout = Object.prototype.hasOwnProperty.call(body, 'about');
    const hasAccentColor =
      Object.prototype.hasOwnProperty.call(body, 'accentColor') ||
      Object.prototype.hasOwnProperty.call(body, 'accent_color');

    if (!hasDisplayName && !hasBio && !hasAbout && !hasAccentColor) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    const displayName = hasDisplayName
      ? (body.displayName ?? body.display_name)
      : undefined;

    const bio = hasBio ? body.bio : undefined;
    const about = hasAbout ? body.about : undefined;
    const accentColor = hasAccentColor
      ? (body.accentColor ?? body.accent_color)
      : undefined;

    try {
      const profile = await profiles.updateProfile({
        userId,
        displayName,
        bio,
        about,
        accentColor,
      });

      const user = await buildMeResponse(userId);
      return res.json({ ok: true, profile, user });
    } catch (err) {
      return sendKnownError(res, err, 'profile_update_failed');
    }
  });

  router.patch('/me/presence', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : null;

    if (!body) {
      return res.status(400).json({ error: 'body_must_be_object' });
    }

    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
    const hasCustomStatus =
      Object.prototype.hasOwnProperty.call(body, 'customStatus') ||
      Object.prototype.hasOwnProperty.call(body, 'custom_status');

    if (!hasStatus && !hasCustomStatus) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    const status = hasStatus ? body.status : 'online';
    const customStatus = hasCustomStatus
      ? (body.customStatus ?? body.custom_status)
      : undefined;

    try {
      const pres = await presence.setPresence({
        userId,
        status,
        customStatus,
      });

      const user = await buildMeResponse(userId);
      return res.json({ ok: true, presence: pres, user });
    } catch (err) {
      return sendKnownError(res, err, 'presence_update_failed');
    }
  });

  router.get('/me/sessions', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const sessions = await accounts.listSessions(userId);
    return res.json({ sessions });
  });

  router.delete('/me/sessions/:sessionId', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const sessionId = Number(req.params.sessionId);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'bad_session_id' });
    }

    const ok = await accounts.revokeSession({ userId, sessionId });
    if (!ok) return res.status(404).json({ error: 'session_not_found' });

    return res.json({ ok: true });
  });

  router.post('/me/logout-all', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const revoked = await accounts.revokeAllSessions({ userId });
    return res.json({ ok: true, revoked });
  });

  router.patch('/me/password', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : null;

    if (!body) {
      return res.status(400).json({ error: 'body_must_be_object' });
    }

    const oldPassword = String(body.oldPassword ?? '');
    const newPassword = String(body.newPassword ?? '');

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'bad_password' });
    }

    const authRow = await accounts.getUserForAuthByEmail(
      normalizeEmail((await accounts.getMeDto(userId))?.email || '')
    );

    if (!authRow) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const ok = await verifyPassword(authRow.pass_hash, oldPassword);
    if (!ok) {
      return res.status(403).json({ error: 'bad_credentials' });
    }

    await accounts.setPassword({
      userId,
      newPassword,
      hashPassword,
      revokeAllSessions: true,
    });

    return res.json({ ok: true });
  });

  router.post(
    '/me/avatar',
    authMiddleware,
    avatarUpload.single('avatar'),
    async (req, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: 'no_file' });
      }

      const userDir = path.join(UPLOAD_DIR, 'avatars', userId);
      ensureDirSync(userDir);

      const prevProfile = await profiles.getProfile(userId);
      const prevUrl = prevProfile?.avatarUrl;
      if (prevUrl && String(prevUrl).startsWith('/uploads/')) {
        safeUnlinkIfLocal(String(prevUrl));
      }

      const filename = `${Date.now()}_${crypto.randomBytes(12).toString('hex')}.webp`;
      const relUrl = `/uploads/avatars/${userId}/${filename}`;
      const fullPath = path.join(userDir, filename);

      const outBuf = await sharp(file.buffer, { animated: true })
        .resize(256, 256, { fit: 'cover' })
        .webp({ quality: Number(process.env.AVATAR_WEBP_QUALITY || 82), effort: 4 })
        .toBuffer();

      await fs.promises.writeFile(fullPath, outBuf);
      const profile = await profiles.setAvatarUrl({ userId, avatarUrl: relUrl });
      const user = await buildMeResponse(userId);

      return res.json({ ok: true, avatarUrl: relUrl, profile, user });
    }
  );

  router.delete('/me/avatar', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const prevProfile = await profiles.getProfile(userId);
    const prevUrl = prevProfile?.avatarUrl;
    if (prevUrl && String(prevUrl).startsWith('/uploads/')) {
      safeUnlinkIfLocal(String(prevUrl));
    }

    const profile = await profiles.clearAvatarUrl(userId);
    const user = await buildMeResponse(userId);

    return res.json({ ok: true, profile, user });
  });

  router.post(
    '/me/banner',
    authMiddleware,
    avatarUpload.single('banner'),
    async (req, res) => {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: 'unauthorized' });

      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: 'no_file' });
      }

      const bannerDir = path.join(UPLOAD_DIR, 'banners', userId);
      ensureDirSync(bannerDir);

      const prevProfile = await profiles.getProfile(userId);
      const prevUrl = prevProfile?.bannerUrl;
      if (prevUrl && String(prevUrl).startsWith('/uploads/')) {
        safeUnlinkIfLocal(String(prevUrl));
      }

      const filename = `${Date.now()}_${crypto.randomBytes(12).toString('hex')}.webp`;
      const relUrl = `/uploads/banners/${userId}/${filename}`;
      const fullPath = path.join(bannerDir, filename);

      const outBuf = await sharp(file.buffer, { animated: true })
        .resize(1200, 480, { fit: 'cover' })
        .webp({ quality: Number(process.env.BANNER_WEBP_QUALITY || 84), effort: 4 })
        .toBuffer();

      await fs.promises.writeFile(fullPath, outBuf);
      const profile = await profiles.setBannerUrl({ userId, bannerUrl: relUrl });
      const user = await buildMeResponse(userId);

      return res.json({ ok: true, bannerUrl: relUrl, profile, user });
    }
  );

  router.delete('/me/banner', authMiddleware, async (req, res) => {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const prevProfile = await profiles.getProfile(userId);
    const prevUrl = prevProfile?.bannerUrl;
    if (prevUrl && String(prevUrl).startsWith('/uploads/')) {
      safeUnlinkIfLocal(String(prevUrl));
    }

    const profile = await profiles.clearBannerUrl(userId);
    const user = await buildMeResponse(userId);

    return res.json({ ok: true, profile, user });
  });

  return router;
}