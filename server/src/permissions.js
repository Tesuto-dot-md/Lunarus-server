export function createPermissions({ pool }) {
  function managedRoleId(serverId, key) {
    // Deterministic ids for built-in roles (easy to reference + stable across restarts).
    // Example: r_s_abc123_admin
    return `r_${String(serverId)}_${String(key)}`;
  }

  const BUILTIN_ROLE_DEFS = {
    member: { name: 'Member', position: 0, permissions: {} },
    moderator: { name: 'Moderator', position: 50, permissions: { viewPrivateChannels: true, createInvites: true } },
    admin: {
      name: 'Admin',
      position: 100,
      permissions: {
        manageServer: true,
        manageChannels: true,
        manageRoles: true,
        manageInvites: true,
        createInvites: true,
        viewPrivateChannels: true,
      },
    },
  };

  async function ensureDefaultRoles(serverId) {
    if (!pool) return;
    const now = Date.now();
    for (const key of Object.keys(BUILTIN_ROLE_DEFS)) {
      const def = BUILTIN_ROLE_DEFS[key];
      await pool.query(
        `INSERT INTO server_roles(id, server_id, name, color, position, permissions, is_managed, created_at)
         VALUES ($1,$2,$3,NULL,$4,$5::jsonb,true,$6)
         ON CONFLICT (id) DO NOTHING`,
        [managedRoleId(serverId, key), String(serverId), String(def.name), Number(def.position), JSON.stringify(def.permissions || {}), now]
      );
    }
  }

  function mergePerms(a, b) {
    const out = { ...(a || {}) };
    if (b && typeof b === 'object') {
      for (const [k, v] of Object.entries(b)) {
        if (Boolean(v)) out[k] = true;
      }
    }
    return out;
  }

  async function getMemberRoleIds(serverId, userId) {
    const r = await pool.query(
      `SELECT role_id AS "roleId"
         FROM server_member_roles
        WHERE server_id=$1 AND user_id=$2`,
      [String(serverId), String(userId)]
    );
    return r.rows.map((x) => String(x.roleId));
  }

  async function getMemberRoles(serverId, userId) {
    const r = await pool.query(
      `SELECT r.id, r.name, r.color, r.position, r.permissions, r.is_managed AS "isManaged"
         FROM server_member_roles mr
         JOIN server_roles r ON r.id = mr.role_id
        WHERE mr.server_id=$1 AND mr.user_id=$2
        ORDER BY r.position DESC, r.created_at ASC`,
      [String(serverId), String(userId)]
    );
    return r.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      color: row.color ?? null,
      position: Number(row.position ?? 0),
      permissions: row.permissions ?? {},
      isManaged: Boolean(row.isManaged),
    }));
  }

  async function getServerMember(serverId, userId) {
    const r = await pool.query(
      `SELECT role, permissions FROM server_members WHERE server_id=$1 AND user_id=$2`,
      [String(serverId), String(userId)]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0];
  }

  async function ensureMember(serverId, userId) {
    const m = await pool.query(
      `SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`,
      [String(serverId), String(userId)]
    );
    return m.rowCount > 0;
  }

  async function isOwner(serverId, userId) {
    const r = await pool.query(`SELECT owner_id FROM servers WHERE id=$1`, [String(serverId)]);
    if (r.rowCount === 0) return false;
    return String(r.rows[0].owner_id) === String(userId);
  }

  function hasPerm(perms, key) {
    if (!perms) return false;
    if (typeof perms === 'string') {
      try {
        perms = JSON.parse(perms);
      } catch (_) {
        return false;
      }
    }
    return Boolean(perms?.[key]);
  }

  async function getEffectivePermissions(serverId, userId) {
    // Owner is handled by callers (fast path) but returning strong perms helps call sites that don't check owner.
    if (await isOwner(serverId, userId)) {
      return {
        manageServer: true,
        manageChannels: true,
        manageRoles: true,
        manageInvites: true,
        createInvites: true,
        viewPrivateChannels: true,
      };
    }

    const m = await getServerMember(serverId, userId);
    if (!m) return {};

    let perms = {};

    // Many-to-many roles (new system)
    try {
      const roles = await getMemberRoles(serverId, userId);
      for (const r of roles) perms = mergePerms(perms, r.permissions || {});
    } catch (_) {}

    // Backward-compatible legacy single role (server_members.role)
    const legacyRole = String(m.role || 'member');
    if (legacyRole === 'admin' || legacyRole === 'moderator' || legacyRole === 'member') {
      perms = mergePerms(perms, BUILTIN_ROLE_DEFS[legacyRole]?.permissions || {});
    }

    // Per-member overrides
    perms = mergePerms(perms, m.permissions || {});
    return perms;
  }

  async function canManageChannels(serverId, userId) {
    if (await isOwner(serverId, userId)) return true;
    const perms = await getEffectivePermissions(serverId, userId);
    return hasPerm(perms, 'manageChannels') || hasPerm(perms, 'manageServer');
  }

  async function canCreateInvites(serverId, userId) {
    if (await isOwner(serverId, userId)) return true;
    const perms = await getEffectivePermissions(serverId, userId);
    return hasPerm(perms, 'createInvites') || hasPerm(perms, 'manageInvites') || hasPerm(perms, 'manageServer');
  }

  async function canManageInvites(serverId, userId) {
    if (await isOwner(serverId, userId)) return true;
    const perms = await getEffectivePermissions(serverId, userId);
    return hasPerm(perms, 'manageInvites') || hasPerm(perms, 'manageServer');
  }

  async function canManageServer(serverId, userId) {
    if (await isOwner(serverId, userId)) return true;
    const perms = await getEffectivePermissions(serverId, userId);
    return hasPerm(perms, 'manageServer');
  }

  async function canManageRoles(serverId, userId) {
    if (await isOwner(serverId, userId)) return true;
    const perms = await getEffectivePermissions(serverId, userId);
    return hasPerm(perms, 'manageRoles') || hasPerm(perms, 'manageServer');
  }

  async function canViewPrivateChannels(serverId, userId) {
    if (await isOwner(serverId, userId)) return true;
    const perms = await getEffectivePermissions(serverId, userId);
    return (
      hasPerm(perms, 'viewPrivateChannels') ||
      hasPerm(perms, 'manageChannels') ||
      hasPerm(perms, 'manageServer')
    );
  }

  async function getChannelForAccess(channelId) {
    const r = await pool.query(
      `SELECT id, server_id AS "serverId", is_private AS "isPrivate"
         FROM channels
        WHERE id=$1`,
      [String(channelId)]
    );
    return r.rowCount ? r.rows[0] : null;
  }

  async function requireChannelAccess(channelId, userId) {
    if (!pool) return { ok: false, status: 500, error: 'db not configured' };
    const ch = await getChannelForAccess(channelId);
    if (!ch) return { ok: false, status: 404, error: 'channel not found' };

    // Membership in server is required for any channel.
    // Private channels require an explicit permission (or admin/moderator/owner).
    // Auto-join the built-in default server to keep legacy clients working.
    if (String(ch.serverId) === 'lunarus') {
      await pool.query(
        `INSERT INTO server_members(server_id, user_id, nickname, joined_at)
         VALUES ('lunarus', $1, NULL, $2)
         ON CONFLICT (server_id, user_id) DO NOTHING`,
        [String(userId), Date.now()]
      );
    }

    const m = await pool.query(
      `SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`,
      [String(ch.serverId), String(userId)]
    );
    if (m.rowCount === 0) return { ok: false, status: 403, error: 'not a member' };

    if (Boolean(ch.isPrivate)) {
      const okPrivate = await canViewPrivateChannels(String(ch.serverId), String(userId));
      // Hide existence of private channels from unauthorized members.
      if (!okPrivate) return { ok: false, status: 404, error: 'channel not found' };
    }

    return { ok: true, channel: ch };
  }

  return {
    BUILTIN_ROLE_DEFS,
    managedRoleId,
    ensureDefaultRoles,
    getMemberRoleIds,
    getMemberRoles,
    getServerMember,
    getEffectivePermissions,
    ensureMember,
    isOwner,
    hasPerm,
    canManageChannels,
    canCreateInvites,
    canManageInvites,
    canManageServer,
    canManageRoles,
    canViewPrivateChannels,
    getChannelForAccess,
    requireChannelAccess,
  };
}
