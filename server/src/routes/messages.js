import express from 'express';

function toClientMessage(row) {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    authorId: String(row.author_id),
    clientNonce: (row.client_nonce == null) ? null : String(row.client_nonce),
    content: String(row.content ?? ''),
    kind: String(row.kind ?? 'text'),
    media: row.media ?? null,
    ts: Number(row.ts),
  };
}

function clampLimit(v, def = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(100, n));
}

function parseCursorId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseCursorTs(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function createMessagesRouter({
  pool,
  authMiddleware,
  permissions,
  mediaUpload,
  finalizeMediaUpload,
  broadcast,
}) {
  const router = express.Router();
  const { requireChannelAccess } = permissions;

  async function listMessagesForChannel({ channelId, userId, limit, beforeId, afterId, beforeTs, afterTs }) {
    if (!pool) return { ok: false, status: 500, error: 'db not configured' };

    const acc = await requireChannelAccess(String(channelId), String(userId));
    if (!acc.ok) return acc;

    const bId = parseCursorId(beforeId);
    const aId = parseCursorId(afterId);
    const bTs = parseCursorTs(beforeTs);
    const aTs = parseCursorTs(afterTs);

    const useAsc = aId !== null && bId === null && bTs === null;
    const order = useAsc ? 'ASC' : 'DESC';

    const params = [String(channelId)];
    let i = 2;
    const where = ['channel_id = $1'];

    if (bId !== null) {
      where.push(`id < $${i}`);
      params.push(bId);
      i++;
    }
    if (aId !== null) {
      where.push(`id > $${i}`);
      params.push(aId);
      i++;
    }
    if (bTs !== null) {
      where.push(`ts < $${i}`);
      params.push(bTs);
      i++;
    }
    if (aTs !== null) {
      where.push(`ts > $${i}`);
      params.push(aTs);
      i++;
    }

    const r = await pool.query(
      `SELECT id, channel_id, author_id, content, kind, media, ts
         FROM messages
        WHERE ${where.join(' AND ')}
        ORDER BY id ${order}
        LIMIT $${i}`,
      [...params, limit]
    );

    const raw = r.rows.map(toClientMessage);
    const items = useAsc ? raw : raw.reverse();

    const oldest = items.length ? items[0] : null;
    const newest = items.length ? items[items.length - 1] : null;
    const cursors = {
      beforeId: oldest ? oldest.id : null,
      afterId: newest ? newest.id : null,
    };

    return { ok: true, items, cursors };
  }

  async function createMessageInChannel({ channelId, userId, content, kind, media, clientNonce }) {
    const k = String(kind || 'text');
    const allowed = new Set(['text', 'image', 'gif', 'video', 'file']);
    if (!allowed.has(k)) return { ok: false, status: 400, error: 'bad kind' };

    if (!pool) return { ok: false, status: 500, error: 'db not configured' };

    const acc = await requireChannelAccess(String(channelId), String(userId));
    if (!acc.ok) return acc;

    const msg = {
      channelId: String(channelId),
      authorId: String(userId),
      content: String(content ?? ''),
      kind: k,
      media: media ?? null,
      ts: Date.now(),
    };

    const nonce = (clientNonce !== undefined && clientNonce !== null && String(clientNonce).trim() !== '')
      ? String(clientNonce).trim()
      : null;

    if (nonce) {
      const ex = await pool.query(
        `SELECT id, channel_id, author_id, client_nonce, content, kind, media, ts
           FROM messages
          WHERE author_id=$1 AND client_nonce=$2
          LIMIT 1`,
        [msg.authorId, nonce]
      );
      if (ex.rowCount > 0) {
        const item = toClientMessage(ex.rows[0]);
        if (typeof broadcast === 'function') {
          broadcast({ t: 'MESSAGE_CREATE', d: item }, (c) => c.channelId === item.channelId);
        }
        return { ok: true, item };
      }
    }

    const r = await pool.query(
      `INSERT INTO messages(channel_id, author_id, client_nonce, content, kind, media, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, channel_id, author_id, client_nonce, content, kind, media, ts`,
      [msg.channelId, msg.authorId, nonce, msg.content, msg.kind, msg.media, msg.ts]
    );

    const item = toClientMessage(r.rows[0]);
    if (typeof broadcast === 'function') {
      broadcast({ t: 'MESSAGE_CREATE', d: item }, (c) => c.channelId === item.channelId);
    }
    return { ok: true, item };
  }

  router.get('/channels/:channelId/messages', authMiddleware, async (req, res) => {
    const channelId = String(req.params.channelId ?? 'general');
    const limit = clampLimit(req.query.limit, 50);

    const beforeId = req.query.beforeId ?? req.query.before ?? null;
    const afterId = req.query.afterId ?? req.query.after ?? null;
    const beforeTs = req.query.beforeTs ?? null;
    const afterTs = req.query.afterTs ?? null;

    const r = await listMessagesForChannel({
      channelId,
      userId: String(req.user?.sub),
      limit,
      beforeId,
      afterId,
      beforeTs,
      afterTs,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ items: r.items, cursors: r.cursors });
  });

  router.post('/channels/:channelId/messages', authMiddleware, async (req, res) => {
    const channelId = String(req.params.channelId ?? 'general');
    const { content = '', kind = 'text', media = null, clientNonce = null } = req.body ?? {};

    const r = await createMessageInChannel({
      channelId,
      userId: String(req.user?.sub),
      content,
      kind,
      media,
      clientNonce,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, item: r.item });
  });

  router.get('/messages', authMiddleware, async (req, res) => {
    const channelId = String(req.query.channelId ?? 'general');
    const limit = clampLimit(req.query.limit, 50);

    const beforeId = req.query.beforeId ?? req.query.before ?? null;
    const afterId = req.query.afterId ?? req.query.after ?? null;
    const beforeTs = req.query.beforeTs ?? null;
    const afterTs = req.query.afterTs ?? null;

    const r = await listMessagesForChannel({
      channelId,
      userId: String(req.user?.sub),
      limit,
      beforeId,
      afterId,
      beforeTs,
      afterTs,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ items: r.items, cursors: r.cursors });
  });

  router.post('/messages', authMiddleware, async (req, res) => {
    const { channelId = 'general', content = '', kind = 'text', media = null, clientNonce = null } = req.body ?? {};

    const r = await createMessageInChannel({
      channelId: String(channelId),
      userId: String(req.user?.sub),
      content,
      kind,
      media,
      clientNonce,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true, item: r.item });
  });

  router.post('/upload', authMiddleware, mediaUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'missing file' });

    const info = await finalizeMediaUpload({
      tmpPath: req.file.path,
      originalName: req.file.originalname || 'file',
      mime: req.file.mimetype || 'application/octet-stream',
      size: req.file.size || 0,
      userId: String(req.user?.sub),
      channelId: null,
    });

    if (!info.ok) return res.status(info.status).json({ error: info.error, details: info.details });

    res.json({ ok: true, media: info.media });
  });

  router.post('/channels/:channelId/upload', authMiddleware, mediaUpload.single('file'), async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    if (!req.file) return res.status(400).json({ error: 'missing file' });

    const channelId = String(req.params.channelId || '').trim();
    if (!channelId) return res.status(400).json({ error: 'missing channelId' });

    const access = await requireChannelAccess(channelId, String(req.user?.sub));
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const info = await finalizeMediaUpload({
      tmpPath: req.file.path,
      originalName: req.file.originalname || 'file',
      mime: req.file.mimetype || 'application/octet-stream',
      size: req.file.size || 0,
      userId: String(req.user?.sub),
      channelId,
    });

    if (!info.ok) return res.status(info.status).json({ error: info.error, details: info.details });

    res.json({ ok: true, media: info.media });
  });

  router.get('/tenor/search', authMiddleware, async (req, res) => {
    const key = process.env.TENOR_API_KEY;
    const clientKey = process.env.TENOR_CLIENT_KEY || 'lunarus';
    if (!key) return res.status(501).json({ error: 'TENOR_API_KEY not configured' });

    const q = String(req.query.q ?? '').trim();
    if (!q) return res.status(400).json({ error: 'missing q' });

    const limitRaw = Number(req.query.limit ?? 16);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 16;

    if (typeof fetch !== 'function') {
      return res.status(501).json({ error: 'fetch unavailable' });
    }

    const url = new URL('https://tenor.googleapis.com/v2/search');
    url.searchParams.set('q', q);
    url.searchParams.set('key', key);
    url.searchParams.set('client_key', clientKey);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('media_filter', 'gif,tinygif');

    const r = await fetch(url.toString());
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'tenor upstream error', status: r.status, body: t.slice(0, 300) });
    }
    const j = await r.json();

    const results = (j.results || []).map((it) => {
      const mf = it.media_formats || {};
      const tiny = mf.tinygif || mf.gif || null;
      const full = mf.gif || mf.tinygif || null;
      return {
        id: it.id,
        url: full?.url || tiny?.url || null,
        previewUrl: tiny?.url || full?.url || null,
        dims: full?.dims || tiny?.dims || null,
      };
    }).filter(x => x.url);

    res.json({ items: results });
  });

  return router;
}
