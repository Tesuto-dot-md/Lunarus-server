export function createProfilesService({ pool }) {
  if (!pool) {
    throw new Error('createProfilesService: pool is required');
  }

  function mapProfile(row) {
    if (!row) return null;
    return {
      userId: String(row.user_id),
      displayName: row.display_name == null ? null : String(row.display_name),
      avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
      bannerUrl: row.banner_url == null ? null : String(row.banner_url),
      bio: row.bio == null ? null : String(row.bio),
      about: row.about == null ? null : String(row.about),
      accentColor: row.accent_color == null ? null : String(row.accent_color),
      updatedAt: row.updated_at == null ? null : Number(row.updated_at),
    };
  }

  function normalizeNullableString(value, { trim = true, max = null } = {}) {
    if (value == null) return null;
    let s = String(value);
    if (trim) s = s.trim();
    if (!s) return null;
    if (max != null && s.length > max) s = s.slice(0, max);
    return s;
  }

  function normalizeAccentColor(value) {
    const s = normalizeNullableString(value, { trim: true, max: 16 });
    if (!s) return null;

    const hex = s.startsWith('#') ? s : `#${s}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex) && !/^#[0-9a-fA-F]{8}$/.test(hex)) {
      const err = new Error('bad_accent_color');
      err.code = 'bad_accent_color';
      throw err;
    }
    return hex.toLowerCase();
  }

  async function ensureProfileRow(userId) {
    const now = Date.now();

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
      SELECT
        u.id,
        COALESCE(u.display_name, u.username),
        u.avatar_url,
        NULL,
        u.bio,
        NULL,
        NULL,
        COALESCE(u.updated_at, u.created_at, $2)
      FROM users u
      WHERE u.id = $1
      ON CONFLICT (user_id) DO NOTHING
      `,
      [String(userId), now]
    );
  }

  async function getProfile(userId) {
    await ensureProfileRow(userId);

    const r = await pool.query(
      `
      SELECT
        user_id,
        display_name,
        avatar_url,
        banner_url,
        bio,
        about,
        accent_color,
        updated_at
      FROM user_profiles
      WHERE user_id = $1
      LIMIT 1
      `,
      [String(userId)]
    );

    return r.rowCount > 0 ? mapProfile(r.rows[0]) : null;
  }

  async function updateProfile({
    userId,
    displayName,
    bio,
    about,
    accentColor,
  }) {
    await ensureProfileRow(userId);
    const now = Date.now();

    const current = await pool.query(
      `
      SELECT
        user_id,
        display_name,
        avatar_url,
        banner_url,
        bio,
        about,
        accent_color,
        updated_at
      FROM user_profiles
      WHERE user_id = $1
      LIMIT 1
      `,
      [String(userId)]
    );

    if (current.rowCount === 0) {
      const err = new Error('profile_not_found');
      err.code = 'profile_not_found';
      throw err;
    }

    const row = current.rows[0];

    const nextDisplayName =
      displayName === undefined
          ? row.display_name
          : normalizeNullableString(displayName, { trim: true, max: 64 });

    const nextBio =
      bio === undefined
          ? row.bio
          : normalizeNullableString(bio, { trim: true, max: 190 });

    const nextAbout =
      about === undefined
          ? row.about
          : normalizeNullableString(about, { trim: true, max: 4000 });

    const nextAccentColor =
      accentColor === undefined
          ? row.accent_color
          : normalizeAccentColor(accentColor);

    await pool.query(
      `
      UPDATE user_profiles
      SET
        display_name = $2,
        bio = $3,
        about = $4,
        accent_color = $5,
        updated_at = $6
      WHERE user_id = $1
      `,
      [
        String(userId),
        nextDisplayName,
        nextBio,
        nextAbout,
        nextAccentColor,
        now,
      ]
    );

    // Legacy sync for old parts of the app
    await pool.query(
      `
      UPDATE users
      SET
        display_name = $2,
        bio = $3,
        updated_at = $4
      WHERE id = $1
      `,
      [String(userId), nextDisplayName, nextBio, now]
    );

    return getProfile(userId);
  }

  async function setAvatarUrl({ userId, avatarUrl }) {
    await ensureProfileRow(userId);
    const now = Date.now();
    const nextAvatarUrl = normalizeNullableString(avatarUrl, {
      trim: true,
      max: 2048,
    });

    await pool.query(
      `
      UPDATE user_profiles
      SET avatar_url = $2, updated_at = $3
      WHERE user_id = $1
      `,
      [String(userId), nextAvatarUrl, now]
    );

    await pool.query(
      `
      UPDATE users
      SET avatar_url = $2, updated_at = $3
      WHERE id = $1
      `,
      [String(userId), nextAvatarUrl, now]
    );

    return getProfile(userId);
  }

  async function clearAvatarUrl(userId) {
    return setAvatarUrl({ userId, avatarUrl: null });
  }

  async function setBannerUrl({ userId, bannerUrl }) {
    await ensureProfileRow(userId);
    const now = Date.now();
    const nextBannerUrl = normalizeNullableString(bannerUrl, {
      trim: true,
      max: 2048,
    });

    await pool.query(
      `
      UPDATE user_profiles
      SET banner_url = $2, updated_at = $3
      WHERE user_id = $1
      `,
      [String(userId), nextBannerUrl, now]
    );

    await pool.query(
      `
      UPDATE users
      SET updated_at = $2
      WHERE id = $1
      `,
      [String(userId), now]
    );

    return getProfile(userId);
  }

  async function clearBannerUrl(userId) {
    return setBannerUrl({ userId, bannerUrl: null });
  }

  return {
    mapProfile,
    ensureProfileRow,
    getProfile,
    updateProfile,
    setAvatarUrl,
    clearAvatarUrl,
    setBannerUrl,
    clearBannerUrl,
  };
}