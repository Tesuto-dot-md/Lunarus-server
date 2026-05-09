-- Backfill old inline profile columns from users into user_profiles / user_presence.
-- Safe to run multiple times.

INSERT INTO user_profiles (user_id, display_name, avatar_url, bio, updated_at)
SELECT
  u.id,
  u.display_name,
  u.avatar_url,
  u.bio,
  COALESCE(u.updated_at, u.created_at, EXTRACT(EPOCH FROM now())::bigint * 1000)
FROM users u
ON CONFLICT (user_id) DO UPDATE SET
  display_name = COALESCE(user_profiles.display_name, EXCLUDED.display_name),
  avatar_url   = COALESCE(user_profiles.avatar_url,   EXCLUDED.avatar_url),
  bio          = COALESCE(user_profiles.bio,          EXCLUDED.bio),
  updated_at   = GREATEST(user_profiles.updated_at, EXCLUDED.updated_at);

INSERT INTO user_presence (user_id, status, last_seen, updated_at)
SELECT
  u.id,
  CASE WHEN u.last_seen IS NULL THEN 'offline' ELSE 'offline' END,
  u.last_seen,
  COALESCE(u.updated_at, u.created_at, EXTRACT(EPOCH FROM now())::bigint * 1000)
FROM users u
ON CONFLICT (user_id) DO UPDATE SET
  last_seen = COALESCE(user_presence.last_seen, EXCLUDED.last_seen),
  updated_at = GREATEST(user_presence.updated_at, EXCLUDED.updated_at);
