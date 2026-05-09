export function createPresenceService({ pool }) {
  if (!pool) {
    throw new Error('createPresenceService: pool is required');
  }

  const ALLOWED_STATUSES = new Set([
    'online',
    'idle',
    'dnd',
    'offline',
    'invisible',
  ]);

  function normalizeStatus(value) {
    const s = String(value || '')
      .trim()
      .toLowerCase();

    if (!ALLOWED_STATUSES.has(s)) {
      const err = new Error('bad_status');
      err.code = 'bad_status';
      throw err;
    }

    return s;
  }

  function normalizeCustomStatus(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return s.length > 160 ? s.slice(0, 160) : s;
  }

  function mapPresence(row) {
    if (!row) return null;
    return {
      userId: String(row.user_id),
      status: row.status == null ? 'offline' : String(row.status),
      customStatus:
          row.custom_status == null ? null : String(row.custom_status),
      lastSeen: row.last_seen == null ? null : Number(row.last_seen),
      updatedAt: row.updated_at == null ? null : Number(row.updated_at),
    };
  }

  async function ensurePresenceRow(userId) {
    const now = Date.now();

    await pool.query(
      `
      INSERT INTO user_presence(user_id, status, custom_status, last_seen, updated_at)
      VALUES ($1, 'offline', NULL, NULL, $2)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [String(userId), now]
    );
  }

  async function getPresence(userId) {
    await ensurePresenceRow(userId);

    const r = await pool.query(
      `
      SELECT user_id, status, custom_status, last_seen, updated_at
      FROM user_presence
      WHERE user_id = $1
      LIMIT 1
      `,
      [String(userId)]
    );

    return r.rowCount > 0 ? mapPresence(r.rows[0]) : null;
  }

  async function setPresence({ userId, status, customStatus }) {
    await ensurePresenceRow(userId);
    const now = Date.now();

    const nextStatus = normalizeStatus(status);
    const nextCustomStatus =
        customStatus === undefined
            ? undefined
            : normalizeCustomStatus(customStatus);

    const current = await pool.query(
      `
      SELECT user_id, status, custom_status, last_seen, updated_at
      FROM user_presence
      WHERE user_id = $1
      LIMIT 1
      `,
      [String(userId)]
    );

    if (current.rowCount === 0) {
      const err = new Error('presence_not_found');
      err.code = 'presence_not_found';
      throw err;
    }

    const row = current.rows[0];
    const resolvedCustomStatus =
        nextCustomStatus === undefined ? row.custom_status : nextCustomStatus;

    const nextLastSeen =
        nextStatus === 'offline' || nextStatus === 'invisible'
            ? now
            : row.last_seen;

    await pool.query(
      `
      UPDATE user_presence
      SET
        status = $2,
        custom_status = $3,
        last_seen = $4,
        updated_at = $5
      WHERE user_id = $1
      `,
      [
        String(userId),
        nextStatus,
        resolvedCustomStatus,
        nextLastSeen,
        now,
      ]
    );

    await pool.query(
      `
      UPDATE users
      SET
        last_seen = $2,
        updated_at = $3
      WHERE id = $1
      `,
      [String(userId), nextLastSeen ?? now, now]
    );

    return getPresence(userId);
  }

  async function markOnline(userId) {
    await ensurePresenceRow(userId);
    const now = Date.now();

    await pool.query(
      `
      UPDATE user_presence
      SET
        status = 'online',
        updated_at = $2
      WHERE user_id = $1
      `,
      [String(userId), now]
    );

    await pool.query(
      `
      UPDATE users
      SET updated_at = $2
      WHERE id = $1
      `,
      [String(userId), now]
    );

    return getPresence(userId);
  }

  async function markOffline(userId) {
    await ensurePresenceRow(userId);
    const now = Date.now();

    await pool.query(
      `
      UPDATE user_presence
      SET
        status = 'offline',
        last_seen = $2,
        updated_at = $2
      WHERE user_id = $1
      `,
      [String(userId), now]
    );

    await pool.query(
      `
      UPDATE users
      SET
        last_seen = $2,
        updated_at = $2
      WHERE id = $1
      `,
      [String(userId), now]
    );

    return getPresence(userId);
  }

  async function touchLastSeen(userId) {
    await ensurePresenceRow(userId);
    const now = Date.now();

    await pool.query(
      `
      UPDATE user_presence
      SET
        last_seen = $2,
        updated_at = $2
      WHERE user_id = $1
      `,
      [String(userId), now]
    );

    await pool.query(
      `
      UPDATE users
      SET
        last_seen = $2,
        updated_at = $2
      WHERE id = $1
      `,
      [String(userId), now]
    );

    return getPresence(userId);
  }

  return {
    ALLOWED_STATUSES,
    mapPresence,
    ensurePresenceRow,
    getPresence,
    setPresence,
    markOnline,
    markOffline,
    touchLastSeen,
  };
}