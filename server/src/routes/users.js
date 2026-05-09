import express from 'express';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';

export function createUsersRouter({
  pool,
  authMiddleware,
  getPublicUserProfile,
  isUserOnline,
  avatarUpload,
  mimeToExt,
  UPLOAD_DIR,
  AVATAR_SUBDIR,
  ensureDirSync,
  safeUnlinkIfLocal,
  hashPassword,
  verifyPassword,
  isValidPassword,
  clampStr,
  isValidAvatarUrl,
}) {
  const router = express.Router();

  router.get('/me', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const u = await getPublicUserProfile(userId);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user: { ...u, online: isUserOnline(userId) } });
  });

  router.get('/me/settings', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const r = await pool.query(`SELECT settings FROM user_settings WHERE user_id=$1`, [userId]);
    if (r.rowCount === 0) {
      const now = Date.now();
      await pool.query(`INSERT INTO user_settings(user_id, settings, updated_at) VALUES ($1, '{}'::jsonb, $2)`, [userId, now]);
      return res.json({ settings: {} });
    }
    res.json({ settings: r.rows[0].settings ?? {} });
  });

  router.patch('/me/settings', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const patch = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
    if (!patch) return res.status(400).json({ error: 'body must be an object' });

    const now = Date.now();
    const r0 = await pool.query(`SELECT settings FROM user_settings WHERE user_id=$1`, [userId]);
    const cur = (r0.rowCount > 0 && r0.rows[0].settings && typeof r0.rows[0].settings === 'object') ? r0.rows[0].settings : {};
    const merged = { ...cur, ...patch };

    await pool.query(
      `INSERT INTO user_settings(user_id, settings, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
      [userId, JSON.stringify(merged), now]
    );

    res.json({ ok: true, settings: merged });
  });

  router.get('/users/:userId', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'bad_user_id' });
    const u = await getPublicUserProfile(userId);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user: { ...u, online: isUserOnline(userId) } });
  });

  router.get('/users/by-username/:username', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const uname = String(req.params.username || '').trim();
    if (!uname) return res.status(400).json({ error: 'bad_username' });
    const r = await pool.query(
      `SELECT id FROM users WHERE lower(username)=lower($1) LIMIT 1`,
      [uname]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    const userId = String(r.rows[0].id);
    const u = await getPublicUserProfile(userId);
    res.json({ user: { ...u, online: isUserOnline(userId) } });
  });

  router.get('/me/profile', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const u = await getPublicUserProfile(userId);
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    res.json({ profile: u });
  });

  router.post('/me/avatar', authMiddleware, avatarUpload.single('avatar'), async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length === 0) return res.status(400).json({ error: 'no_file' });

    const ext = mimeToExt(file.mimetype);
    if (!ext) return res.status(400).json({ error: 'bad_avatar_mime' });

    const userDir = path.join(UPLOAD_DIR, AVATAR_SUBDIR, userId);
    ensureDirSync(userDir);

    const prev = await pool.query(`SELECT avatar_url FROM users WHERE id=$1`, [userId]);
    const prevUrl = (prev.rowCount > 0) ? prev.rows[0].avatar_url : null;
    if (prevUrl && String(prevUrl).startsWith('/uploads/')) safeUnlinkIfLocal(String(prevUrl));

    const rand = crypto.randomBytes(12).toString('hex');
    const filename = `${Date.now()}_${rand}.webp`;
    const relUrl = `/uploads/${AVATAR_SUBDIR}/${userId}/${filename}`;
    const fullPath = path.join(userDir, filename);

    const outBuf = await sharp(file.buffer, { animated: true })
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: Number(process.env.AVATAR_WEBP_QUALITY || 82), effort: 4 })
      .toBuffer();

    await fs.promises.writeFile(fullPath, outBuf);

    const now = Date.now();
    await pool.query(`UPDATE users SET avatar_url=$2, updated_at=$3 WHERE id=$1`, [userId, relUrl, now]);

    const u = await getPublicUserProfile(userId);
    res.json({ ok: true, avatarUrl: relUrl, profile: u });
  });

  router.delete('/me/avatar', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const r = await pool.query(`SELECT avatar_url FROM users WHERE id=$1`, [userId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });

    const prevUrl = r.rows[0].avatar_url;
    if (prevUrl && String(prevUrl).startsWith('/uploads/')) safeUnlinkIfLocal(String(prevUrl));

    const now = Date.now();
    await pool.query(`UPDATE users SET avatar_url=NULL, updated_at=$2 WHERE id=$1`, [userId, now]);
    const u = await getPublicUserProfile(userId);
    res.json({ ok: true, profile: u });
  });

  router.patch('/me/profile', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : null;
    if (!body) return res.status(400).json({ error: 'body must be an object' });

    const displayNameRaw = (body.displayName !== undefined) ? body.displayName : body.display_name;
    const avatarUrlRaw = (body.avatarUrl !== undefined) ? body.avatarUrl : body.avatar_url;
    const bioRaw = body.bio;

    let displayName = null;
    if (displayNameRaw !== undefined) {
      const s = clampStr(displayNameRaw, 64);
      if (s && s.length < 2) return res.status(400).json({ error: 'bad_display_name' });
      displayName = s || null;
    }

    let avatarUrl = null;
    if (avatarUrlRaw !== undefined) {
      const s = String(avatarUrlRaw ?? '').trim();
      if (!isValidAvatarUrl(s)) return res.status(400).json({ error: 'bad_avatar_url' });
      avatarUrl = s || null;
    }

    let bio = null;
    if (bioRaw !== undefined) {
      const s = clampStr(bioRaw, 190);
      bio = s || null;
    }

    const now = Date.now();
    const sets = [];
    const params = [userId];
    let i = 2;

    if (displayNameRaw !== undefined) { sets.push(`display_name=$${i++}`); params.push(displayName); }
    if (avatarUrlRaw !== undefined) { sets.push(`avatar_url=$${i++}`); params.push(avatarUrl); }
    if (bioRaw !== undefined) { sets.push(`bio=$${i++}`); params.push(bio); }

    if (sets.length === 0) return res.status(400).json({ error: 'nothing_to_update' });

    sets.push(`updated_at=$${i++}`); params.push(now);

    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$1`, params);

    const u = await getPublicUserProfile(userId);
    res.json({ ok: true, profile: u });
  });

  router.patch('/me/password', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);

    const { oldPassword, newPassword } = req.body ?? {};
    if (!isValidPassword(newPassword)) return res.status(400).json({ error: 'bad_password' });

    const r = await pool.query(`SELECT pass_hash FROM users WHERE id=$1`, [userId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });

    const ok = await verifyPassword(String(r.rows[0].pass_hash), String(oldPassword ?? ''));
    if (!ok) return res.status(403).json({ error: 'bad_credentials' });

    const passHash = await hashPassword(String(newPassword));
    const now = Date.now();
    await pool.query(`UPDATE users SET pass_hash=$2, updated_at=$3 WHERE id=$1`, [userId, passHash, now]);

    await pool.query(`UPDATE refresh_tokens SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL`, [userId, now]);

    res.json({ ok: true });
  });

  return router;
}
