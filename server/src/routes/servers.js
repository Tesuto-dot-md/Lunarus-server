import express from 'express';

export function createServersRouter({
  pool,
  authMiddleware,
  permissions,
  withTransaction,
  genId,
  genInviteCode,
}) {
  const router = express.Router();
  const {
    ensureMember,
    isOwner,
    canManageServer,
    ensureDefaultRoles,
    getMemberRoleIds,
    getEffectivePermissions,
    canManageRoles,
    canViewPrivateChannels,
    canManageChannels,
    canCreateInvites,
    requireChannelAccess,
    canManageInvites,
  } = permissions;

  router.get('/servers', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);

    await pool.query(
      `INSERT INTO server_members(server_id, user_id, nickname, joined_at)
       VALUES ('lunarus', $1, NULL, $2)
       ON CONFLICT (server_id, user_id) DO NOTHING`,
      [userId, Date.now()]
    );

    const r = await pool.query(
      `SELECT s.id, s.name, s.icon, s.owner_id AS "ownerId", s.created_at AS "createdAt", m.role AS "myRole", m.permissions AS "myPermissions"
         FROM servers s
         JOIN server_members m ON m.server_id = s.id
        WHERE m.user_id = $1
        ORDER BY s.created_at ASC`,
      [userId]
    );
    res.json({ items: r.rows });
  });

  router.post('/servers', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const { name, icon } = req.body ?? {};
    const serverName = String(name ?? '').trim();
    if (!serverName) return res.status(400).json({ error: 'name required' });

    const now = Date.now();
    const serverId = genId('s');
    const iconStr = (icon === undefined || icon === null) ? '' : String(icon).trim();
    const serverIcon = iconStr.length === 0 ? null : iconStr;

    await pool.query(
      `INSERT INTO servers(id, name, icon, owner_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [serverId, serverName, serverIcon, userId, now]
    );
    await ensureDefaultRoles(serverId);

    await pool.query(
      `INSERT INTO server_members(server_id, user_id, nickname, joined_at) VALUES ($1, $2, NULL, $3)`,
      [serverId, userId, now]
    );

    const generalId = `${serverId}-general`;
    const randomId = `${serverId}-random`;
    const voiceId = `${serverId}-voice-lobby`;
    const voiceChatId = `${serverId}-lobby-chat`;
    const voiceRoom = `${serverId}-lobby`;

    const channels = [
      { id: generalId, name: 'general', type: 'text', position: 10, icon: '#', nsfw: false, is_private: false, linked: null, room: null },
      { id: randomId, name: 'random', type: 'text', position: 20, icon: '#', nsfw: false, is_private: false, linked: null, room: null },
      { id: voiceId, name: 'Lobby', type: 'voice', position: 30, icon: '🔊', nsfw: false, is_private: false, linked: voiceChatId, room: voiceRoom },
      { id: voiceChatId, name: 'lobby-chat', type: 'text', position: 31, icon: '#', nsfw: false, is_private: false, linked: null, room: null },
    ];

    for (const c of channels) {
      await pool.query(
        `INSERT INTO channels(id, server_id, name, type, position, icon, nsfw, is_private, linked_text_channel_id, room, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [c.id, serverId, c.name, c.type, c.position, c.icon, c.nsfw, c.is_private, c.linked, c.room, now]
      );
    }

    res.json({ ok: true, item: { id: serverId, name: serverName, icon: serverIcon, ownerId: userId, createdAt: now } });
  });

  router.get('/servers/:serverId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });

    const r = await pool.query(
      `SELECT id, name, icon, owner_id AS "ownerId", created_at AS "createdAt" FROM servers WHERE id=$1`,
      [serverId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'server not found' });
    res.json({ item: r.rows[0] });
  });

  router.get('/servers/:serverId/me', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);

    const r = await pool.query(
      `SELECT server_id AS "serverId", user_id AS "userId", role, permissions, nickname, joined_at AS "joinedAt"
         FROM server_members
        WHERE server_id=$1 AND user_id=$2`,
      [serverId, userId]
    );
    if (r.rowCount === 0) return res.status(403).json({ error: 'not a member' });

    await ensureDefaultRoles(serverId);
    const roleIds = await getMemberRoleIds(serverId, userId);
    const effectivePermissions = await getEffectivePermissions(serverId, userId);

    res.json({ item: { ...r.rows[0], roleIds, effectivePermissions } });
  });

  router.patch('/servers/:serverId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await canManageServer(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    const { name, icon } = req.body ?? {};
    const r0 = await pool.query(`SELECT * FROM servers WHERE id=$1`, [serverId]);
    if (r0.rowCount === 0) return res.status(404).json({ error: 'server not found' });
    const nextName = (name !== undefined) ? String(name).trim() : String(r0.rows[0].name);
    const nextIcon = (icon !== undefined) ? (icon === null ? null : String(icon).trim()) : r0.rows[0].icon;
    if (!nextName) return res.status(400).json({ error: 'name required' });

    const r = await pool.query(
      `UPDATE servers SET name=$2, icon=$3 WHERE id=$1 RETURNING id, name, icon, owner_id AS "ownerId", created_at AS "createdAt"`,
      [serverId, nextName, nextIcon]
    );
    res.json({ ok: true, item: r.rows[0] });
  });

  router.delete('/servers/:serverId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await isOwner(serverId, userId))) return res.status(403).json({ error: 'not owner' });
    await pool.query(`DELETE FROM servers WHERE id=$1`, [serverId]);
    res.json({ ok: true });
  });

  router.get('/servers/:serverId/roles', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const serverId = String(req.params.serverId);

    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });

    await ensureDefaultRoles(serverId);

    const r = await pool.query(
      `SELECT id, name, color, position, permissions, is_managed AS "isManaged", created_at AS "createdAt"
         FROM server_roles
        WHERE server_id=$1
        ORDER BY position DESC, created_at ASC`,
      [serverId]
    );

    res.json({
      items: r.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        color: row.color ?? null,
        position: Number(row.position ?? 0),
        permissions: row.permissions ?? {},
        isManaged: Boolean(row.isManaged),
        createdAt: Number(row.createdAt ?? 0),
      })),
    });
  });

  router.post('/servers/:serverId/roles', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const serverId = String(req.params.serverId);

    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });
    if (!(await canManageRoles(serverId, userId))) return res.status(403).json({ error: 'forbidden' });

    await ensureDefaultRoles(serverId);

    const { name, color, position, permissions } = req.body ?? {};
    const roleName = String(name ?? '').trim();
    if (!roleName || roleName.length > 64) return res.status(400).json({ error: 'invalid name' });

    const roleColor = (color === undefined || color === null) ? null : String(color).trim() || null;
    const rolePosition = Number.isFinite(Number(position)) ? Number(position) : 1;
    const permsObj = (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) ? permissions : {};

    const roleId = genId('r');
    const now = Date.now();

    await pool.query(
      `INSERT INTO server_roles(id, server_id, name, color, position, permissions, is_managed, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,false,$7)`,
      [roleId, serverId, roleName, roleColor, rolePosition, JSON.stringify(permsObj), now]
    );

    res.status(201).json({
      role: { id: roleId, name: roleName, color: roleColor, position: rolePosition, permissions: permsObj, isManaged: false, createdAt: now },
    });
  });

  router.patch('/servers/:serverId/roles/:roleId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const serverId = String(req.params.serverId);
    const roleId = String(req.params.roleId);

    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });
    if (!(await canManageRoles(serverId, userId))) return res.status(403).json({ error: 'forbidden' });

    await ensureDefaultRoles(serverId);

    const r0 = await pool.query(
      `SELECT id, is_managed AS "isManaged" FROM server_roles WHERE id=$1 AND server_id=$2`,
      [roleId, serverId]
    );
    if (r0.rowCount === 0) return res.status(404).json({ error: 'role not found' });
    if (Boolean(r0.rows[0].isManaged)) return res.status(403).json({ error: 'managed role' });

    const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const fields = [];
    const values = [];
    let i = 1;

    if (patch.name !== undefined) {
      const v = String(patch.name ?? '').trim();
      if (!v || v.length > 64) return res.status(400).json({ error: 'invalid name' });
      fields.push(`name=$${i++}`);
      values.push(v);
    }
    if (patch.color !== undefined) {
      const v = (patch.color === null) ? null : String(patch.color ?? '').trim() || null;
      fields.push(`color=$${i++}`);
      values.push(v);
    }
    if (patch.position !== undefined) {
      const v = Number(patch.position);
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'invalid position' });
      fields.push(`position=$${i++}`);
      values.push(v);
    }
    if (patch.permissions !== undefined) {
      const v = (patch.permissions && typeof patch.permissions === 'object' && !Array.isArray(patch.permissions)) ? patch.permissions : {};
      fields.push(`permissions=$${i++}::jsonb`);
      values.push(JSON.stringify(v));
    }

    if (fields.length === 0) return res.json({ ok: true });

    values.push(roleId, serverId);
    await pool.query(
      `UPDATE server_roles SET ${fields.join(', ')} WHERE id=$${i++} AND server_id=$${i++}`,
      values
    );

    res.json({ ok: true });
  });

  router.delete('/servers/:serverId/roles/:roleId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const serverId = String(req.params.serverId);
    const roleId = String(req.params.roleId);

    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });
    if (!(await canManageRoles(serverId, userId))) return res.status(403).json({ error: 'forbidden' });

    const r0 = await pool.query(
      `SELECT is_managed AS "isManaged" FROM server_roles WHERE id=$1 AND server_id=$2`,
      [roleId, serverId]
    );
    if (r0.rowCount === 0) return res.status(404).json({ error: 'role not found' });
    if (Boolean(r0.rows[0].isManaged)) return res.status(403).json({ error: 'managed role' });

    await pool.query(`DELETE FROM server_roles WHERE id=$1 AND server_id=$2`, [roleId, serverId]);
    res.json({ ok: true });
  });

  router.get('/servers/:serverId/members', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const userId = String(req.user?.sub);
    const serverId = String(req.params.serverId);

    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });

    const q = String(req.query.q ?? '').trim();
    const limitRaw = Number(req.query.limit ?? 200);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 200));

    let where = `m.server_id=$1`;
    const args = [serverId];
    if (q) {
      args.push(`%${q.toLowerCase()}%`);
      where += ` AND (LOWER(u.username) LIKE $${args.length} OR LOWER(COALESCE(m.nickname,'')) LIKE $${args.length})`;
    }

    const r = await pool.query(
      `SELECT
          m.user_id AS "userId",
          u.username AS "username",
          u.display_name AS "displayName",
          u.avatar_url AS "avatarUrl",
          m.nickname AS "nickname",
          m.role AS "legacyRole",
          m.permissions AS "memberPermissions",
          m.joined_at AS "joinedAt",
          COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}') AS "roleIds"
        FROM server_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN server_member_roles mr ON mr.server_id = m.server_id AND mr.user_id = m.user_id
        WHERE ${where}
        GROUP BY m.user_id, u.username, u.display_name, u.avatar_url, m.nickname, m.role, m.permissions, m.joined_at
        ORDER BY m.joined_at ASC
        LIMIT ${limit}`,
      args
    );

    res.json({
      items: r.rows.map((row) => ({
        userId: String(row.userId),
        username: String(row.username),
        displayName: (row.displayName == null) ? null : String(row.displayName),
        avatarUrl: (row.avatarUrl == null) ? null : String(row.avatarUrl),
        nickname: row.nickname ?? null,
        legacyRole: String(row.legacyRole ?? 'member'),
        permissions: row.memberPermissions ?? {},
        roleIds: (row.roleIds || []).map(String),
        joinedAt: Number(row.joinedAt ?? 0),
      })),
    });
  });

  router.put('/servers/:serverId/members/:memberId/roles', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const actorId = String(req.user?.sub);
    const serverId = String(req.params.serverId);
    const memberId = String(req.params.memberId);

    if (!(await ensureMember(serverId, actorId))) return res.status(403).json({ error: 'not a member' });
    if (!(await canManageRoles(serverId, actorId))) return res.status(403).json({ error: 'forbidden' });

    await ensureDefaultRoles(serverId);

    const body = req.body;
    const roleIds = Array.isArray(body) ? body : Array.isArray(body?.roleIds) ? body.roleIds : Array.isArray(body?.roles) ? body.roles : null;
    if (!roleIds) return res.status(400).json({ error: 'roleIds required' });

    const cleaned = [...new Set(roleIds.map(String).map((s) => s.trim()).filter(Boolean))];
    if (cleaned.length > 64) return res.status(400).json({ error: 'too many roles' });

    if (!(await ensureMember(serverId, memberId))) return res.status(404).json({ error: 'member not found' });

    if (cleaned.length > 0) {
      const r = await pool.query(
        `SELECT id FROM server_roles WHERE server_id=$1 AND id = ANY($2::text[])`,
        [serverId, cleaned]
      );
      if (r.rowCount !== cleaned.length) return res.status(400).json({ error: 'unknown role id' });
    }

    const now = Date.now();
    await withTransaction(async (db) => {
      await db.query(`DELETE FROM server_member_roles WHERE server_id=$1 AND user_id=$2`, [serverId, memberId]);
      for (const rid of cleaned) {
        await db.query(
          `INSERT INTO server_member_roles(server_id, user_id, role_id, created_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (server_id, user_id, role_id) DO NOTHING`,
          [serverId, memberId, rid, now]
        );
      }
    });

    res.json({ ok: true, roleIds: cleaned });
  });

  router.get('/servers/:serverId/channels', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);

    const m = await pool.query(
      `SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId]
    );
    if (m.rowCount === 0) return res.status(403).json({ error: 'not a member' });

    const r = await pool.query(
      `SELECT id, server_id AS "serverId", category_id AS "categoryId", name, type, position, icon, nsfw, is_private AS "isPrivate", linked_text_channel_id AS "linkedTextChannelId", room, created_at AS "createdAt"
         FROM channels
        WHERE server_id = $1
        ORDER BY position ASC, created_at ASC`,
      [serverId]
    );
    const canViewPrivate = await canViewPrivateChannels(serverId, userId);
    const items = canViewPrivate ? r.rows : r.rows.filter((c) => !c.isPrivate);
    res.json({ items });
  });

  router.get('/servers/:serverId/categories', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });

    const r = await pool.query(
      `SELECT id, server_id AS "serverId", name, position, created_at AS "createdAt"
         FROM channel_categories
        WHERE server_id=$1
        ORDER BY position ASC, created_at ASC`,
      [serverId]
    );
    res.json({ items: r.rows });
  });

  router.post('/servers/:serverId/categories', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await canManageChannels(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    const { name } = req.body ?? {};
    const n = String(name ?? '').trim();
    if (!n) return res.status(400).json({ error: 'name required' });

    const now = Date.now();
    const id = genId('cat');
    const posR = await pool.query(`SELECT COALESCE(MAX(position), 0) AS m FROM channel_categories WHERE server_id=$1`, [serverId]);
    const nextPos = Number(posR.rows?.[0]?.m ?? 0) + 10;

    await pool.query(
      `INSERT INTO channel_categories(id, server_id, name, position, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, serverId, n, nextPos, now]
    );

    const r = await pool.query(
      `SELECT id, server_id AS "serverId", name, position, created_at AS "createdAt"
         FROM channel_categories WHERE id=$1`,
      [id]
    );
    res.json({ ok: true, item: r.rows[0] });
  });

  router.patch('/categories/:categoryId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const categoryId = String(req.params.categoryId);
    const userId = String(req.user?.sub);

    const c0 = await pool.query(`SELECT * FROM channel_categories WHERE id=$1`, [categoryId]);
    if (c0.rowCount === 0) return res.status(404).json({ error: 'category not found' });
    const serverId = String(c0.rows[0].server_id);
    if (!(await canManageChannels(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    const { name, position } = req.body ?? {};
    const nextName = (name !== undefined) ? String(name).trim() : String(c0.rows[0].name);
    const nextPos = (position !== undefined && Number.isFinite(Number(position))) ? Number(position) : Number(c0.rows[0].position ?? 0);
    if (!nextName) return res.status(400).json({ error: 'name required' });

    const r = await pool.query(
      `UPDATE channel_categories
          SET name=$2, position=$3
        WHERE id=$1
      RETURNING id, server_id AS "serverId", name, position, created_at AS "createdAt"`,
      [categoryId, nextName, nextPos]
    );
    res.json({ ok: true, item: r.rows[0] });
  });

  router.delete('/categories/:categoryId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const categoryId = String(req.params.categoryId);
    const userId = String(req.user?.sub);

    const c0 = await pool.query(`SELECT * FROM channel_categories WHERE id=$1`, [categoryId]);
    if (c0.rowCount === 0) return res.status(404).json({ error: 'category not found' });
    const serverId = String(c0.rows[0].server_id);
    if (!(await canManageChannels(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    await pool.query(`UPDATE channels SET category_id = NULL WHERE server_id=$1 AND category_id=$2`, [serverId, categoryId]);
    await pool.query(`DELETE FROM channel_categories WHERE id=$1`, [categoryId]);
    res.json({ ok: true });
  });

  router.post('/servers/:serverId/channels', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await canManageChannels(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    const { name, type = 'text', icon = null, nsfw = false, isPrivate = false, categoryId = null } = req.body ?? {};
    const n = String(name ?? '').trim();
    if (!n) return res.status(400).json({ error: 'name required' });
    const t = String(type ?? 'text');
    const allowedTypes = new Set(['text', 'voice', 'forum']);
    if (!allowedTypes.has(t)) return res.status(400).json({ error: 'bad type' });

    const now = Date.now();
    const id = genId('c');
    const posR = await pool.query(`SELECT COALESCE(MAX(position), 0) AS m FROM channels WHERE server_id=$1`, [serverId]);
    const nextPos = Number(posR.rows?.[0]?.m ?? 0) + 10;
    const iconStr = (icon === undefined || icon === null) ? null : String(icon).trim();

    let category_id = null;
    if (categoryId !== undefined && categoryId !== null && String(categoryId).trim() !== '') {
      category_id = String(categoryId).trim();
      const cr = await pool.query(`SELECT 1 FROM channel_categories WHERE id=$1 AND server_id=$2`, [category_id, serverId]);
      if (cr.rowCount === 0) return res.status(400).json({ error: 'bad categoryId' });
    }

    let linkedTextChannelId = null;
    let room = null;
    if (t === 'voice') {
      linkedTextChannelId = `${id}-chat`;
      room = `${serverId}-${id}`;
    }

    await pool.query(
      `INSERT INTO channels(id, server_id, category_id, name, type, position, icon, nsfw, is_private, linked_text_channel_id, room, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, serverId, category_id, n, t, nextPos, iconStr, Boolean(nsfw), Boolean(isPrivate), linkedTextChannelId, room, now]
    );

    if (t === 'voice' && linkedTextChannelId) {
      await pool.query(
        `INSERT INTO channels(id, server_id, category_id, name, type, position, icon, nsfw, is_private, linked_text_channel_id, room, created_at)
         VALUES ($1,$2,$3,$4,'text',$5,'#',false,false,NULL,NULL,$6)`,
        [linkedTextChannelId, serverId, category_id, `${n}-chat`, nextPos + 1, now]
      );
    }

    const r = await pool.query(
      `SELECT id, server_id AS "serverId", category_id AS "categoryId", name, type, position, icon, nsfw, is_private AS "isPrivate", linked_text_channel_id AS "linkedTextChannelId", room, created_at AS "createdAt"
         FROM channels WHERE id=$1`,
      [id]
    );
    res.json({ ok: true, item: r.rows[0] });
  });

  router.post('/servers/:serverId/invites', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });
    if (!(await canCreateInvites(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    const { channelId = null, expiresAt = null, maxUses = null } = req.body ?? {};

    if (channelId !== null && channelId !== undefined && String(channelId).trim() !== '') {
      const cid = String(channelId).trim();
      const ch = await pool.query(`SELECT server_id FROM channels WHERE id=$1`, [cid]);
      if (ch.rowCount === 0) return res.status(400).json({ error: 'bad channelId' });
      if (String(ch.rows[0].server_id) !== serverId) return res.status(400).json({ error: 'bad channelId' });
      const acc = await requireChannelAccess(cid, userId);
      if (!acc.ok) return res.status(acc.status || 403).json({ error: acc.error || 'missing permission' });
    }

    const now = Date.now();
    let code = genInviteCode();
    for (let i = 0; i < 5; i++) {
      const ex = await pool.query(`SELECT 1 FROM invites WHERE code=$1`, [code]);
      if (ex.rowCount === 0) break;
      code = genInviteCode();
    }

    await pool.query(
      `INSERT INTO invites(code, server_id, channel_id, created_by, created_at, expires_at, max_uses, uses)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
      [code, serverId, channelId ? String(channelId) : null, userId, now, expiresAt ? Number(expiresAt) : null, maxUses ? Number(maxUses) : null]
    );
    res.json({ ok: true, item: { code, serverId, channelId, createdBy: userId, createdAt: now, expiresAt, maxUses, uses: 0 } });
  });

  router.get('/servers/:serverId/invites', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const serverId = String(req.params.serverId);
    const userId = String(req.user?.sub);
    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });

    const canAll = await canManageInvites(serverId, userId);
    const canOwn = canAll || (await canCreateInvites(serverId, userId));
    if (!canOwn) return res.status(403).json({ error: 'missing permission' });

    const r = await pool.query(
      canAll
        ? `SELECT code, server_id AS "serverId", channel_id AS "channelId", created_by AS "createdBy", created_at AS "createdAt", expires_at AS "expiresAt", max_uses AS "maxUses", uses
             FROM invites
            WHERE server_id=$1
            ORDER BY created_at DESC`
        : `SELECT code, server_id AS "serverId", channel_id AS "channelId", created_by AS "createdBy", created_at AS "createdAt", expires_at AS "expiresAt", max_uses AS "maxUses", uses
             FROM invites
            WHERE server_id=$1 AND created_by=$2
            ORDER BY created_at DESC`,
      canAll ? [serverId] : [serverId, userId]
    );
    res.json({ items: r.rows });
  });

  router.delete('/invites/:code', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const code = String(req.params.code).trim().toUpperCase();
    const userId = String(req.user?.sub);

    const r0 = await pool.query(`SELECT code, server_id, created_by FROM invites WHERE code=$1`, [code]);
    if (r0.rowCount === 0) return res.status(404).json({ error: 'invite not found' });
    const inv = r0.rows[0];
    const serverId = String(inv.server_id);

    if (!(await ensureMember(serverId, userId))) return res.status(403).json({ error: 'not a member' });
    const canAll = await canManageInvites(serverId, userId);
    const isCreator = String(inv.created_by) === userId;
    if (!canAll && !isCreator) return res.status(403).json({ error: 'missing permission' });

    await pool.query(`DELETE FROM invites WHERE code=$1`, [code]);
    res.json({ ok: true });
  });

  router.get('/invites/:code', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const code = String(req.params.code).trim().toUpperCase();
    const r = await pool.query(
      `SELECT i.code, i.server_id AS "serverId", i.channel_id AS "channelId", i.expires_at AS "expiresAt", i.max_uses AS "maxUses", i.uses,
              s.name AS "serverName", s.icon AS "serverIcon"
         FROM invites i JOIN servers s ON s.id = i.server_id
        WHERE i.code=$1`,
      [code]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'invite not found' });
    const inv = r.rows[0];
    if (inv.expiresAt && Number(inv.expiresAt) < Date.now()) return res.status(410).json({ error: 'invite expired' });
    if (inv.maxUses && Number(inv.uses) >= Number(inv.maxUses)) return res.status(410).json({ error: 'invite max uses reached' });
    res.json({ item: inv });
  });

  router.post('/invites/:code/join', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const code = String(req.params.code).trim().toUpperCase();
    const userId = String(req.user?.sub);

    const r = await pool.query(`SELECT * FROM invites WHERE code=$1`, [code]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'invite not found' });
    const inv = r.rows[0];
    if (inv.expires_at && Number(inv.expires_at) < Date.now()) return res.status(410).json({ error: 'invite expired' });
    if (inv.max_uses && Number(inv.uses) >= Number(inv.max_uses)) return res.status(410).json({ error: 'invite max uses reached' });

    const serverId = String(inv.server_id);
    await pool.query(
      `INSERT INTO server_members(server_id, user_id, nickname, joined_at)
       VALUES ($1,$2,NULL,$3)
       ON CONFLICT (server_id, user_id) DO NOTHING`,
      [serverId, userId, Date.now()]
    );
    await pool.query(`UPDATE invites SET uses = uses + 1 WHERE code=$1`, [code]);

    const srv = await pool.query(`SELECT id, name, icon, owner_id AS "ownerId", created_at AS "createdAt" FROM servers WHERE id=$1`, [serverId]);
    res.json({ ok: true, item: srv.rows[0] });
  });

  router.patch('/channels/:channelId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const channelId = String(req.params.channelId);
    const userId = String(req.user?.sub);

    const ch = await pool.query(`SELECT * FROM channels WHERE id = $1`, [channelId]);
    if (ch.rowCount === 0) return res.status(404).json({ error: 'channel not found' });

    const serverId = String(ch.rows[0].server_id);
    const isMember = await pool.query(`SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (isMember.rowCount === 0) return res.status(403).json({ error: 'not a member' });

    if (!(await canManageChannels(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    const { name, icon, nsfw, isPrivate, type, position, categoryId, linkedTextChannelId, room } = req.body ?? {};

    const nextName = (name !== undefined && name !== null) ? String(name) : String(ch.rows[0].name);
    const nextIcon = (icon !== undefined) ? (icon === null ? null : String(icon)) : ch.rows[0].icon;
    const nextNsfw = (nsfw !== undefined) ? Boolean(nsfw) : Boolean(ch.rows[0].nsfw);
    const nextPrivate = (isPrivate !== undefined) ? Boolean(isPrivate) : Boolean(ch.rows[0].is_private);
    const nextType = (type !== undefined) ? String(type) : String(ch.rows[0].type);
    const nextPos = (position !== undefined && Number.isFinite(Number(position))) ? Number(position) : Number(ch.rows[0].position ?? 0);
    const nextCategoryId = (categoryId !== undefined) ? (categoryId === null || String(categoryId).trim() === '' ? null : String(categoryId)) : (ch.rows[0].category_id ?? null);
    const nextLinked = (linkedTextChannelId !== undefined) ? (linkedTextChannelId === null ? null : String(linkedTextChannelId)) : ch.rows[0].linked_text_channel_id;
    const nextRoom = (room !== undefined) ? (room === null ? null : String(room)) : ch.rows[0].room;

    const allowedTypes = new Set(['text', 'voice', 'forum']);
    if (!allowedTypes.has(nextType)) return res.status(400).json({ error: 'bad type' });

    const r = await pool.query(
      `UPDATE channels
          SET name=$2, icon=$3, nsfw=$4, is_private=$5, type=$6, position=$7, category_id=$8, linked_text_channel_id=$9, room=$10
        WHERE id=$1
      RETURNING id, server_id AS "serverId", category_id AS "categoryId", name, type, position, icon, nsfw, is_private AS "isPrivate", linked_text_channel_id AS "linkedTextChannelId", room, created_at AS "createdAt"`,
      [channelId, nextName, nextIcon, nextNsfw, nextPrivate, nextType, nextPos, nextCategoryId, nextLinked, nextRoom]
    );

    res.json({ ok: true, item: r.rows[0] });
  });

  router.delete('/channels/:channelId', authMiddleware, async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'db not configured' });
    const channelId = String(req.params.channelId);
    const userId = String(req.user?.sub);

    const ch = await pool.query(`SELECT * FROM channels WHERE id=$1`, [channelId]);
    if (ch.rowCount === 0) return res.status(404).json({ error: 'channel not found' });
    const serverId = String(ch.rows[0].server_id);
    if (!(await canManageChannels(serverId, userId))) return res.status(403).json({ error: 'missing permission' });

    const linked = ch.rows[0].linked_text_channel_id ? String(ch.rows[0].linked_text_channel_id) : null;
    await pool.query(`DELETE FROM channels WHERE id=$1`, [channelId]);
    if (linked) {
      await pool.query(`DELETE FROM channels WHERE id=$1 AND server_id=$2`, [linked, serverId]);
    }
    res.json({ ok: true });
  });

  return router;
}
