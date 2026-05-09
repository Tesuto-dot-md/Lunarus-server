export function createUserProfileService({ pool }) {
  async function getPublicUserProfile(userId) {
    if (!pool) return null;
    const r = await pool.query(
      `SELECT id, username, display_name, avatar_url, bio, last_seen FROM users WHERE id=$1`,
      [String(userId)]
    );
    if (r.rowCount === 0) return null;
    const u = r.rows[0];
    return {
      id: String(u.id),
      username: String(u.username),
      displayName: (u.display_name == null) ? null : String(u.display_name),
      avatarUrl: (u.avatar_url == null) ? null : String(u.avatar_url),
      bio: (u.bio == null) ? null : String(u.bio),
      lastSeen: (u.last_seen == null) ? null : Number(u.last_seen),
    };
  }

  return { getPublicUserProfile };
}
