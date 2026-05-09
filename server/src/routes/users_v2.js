import express from 'express';

export function createUsersV2Router({
  authMiddleware,
  accounts,
  profiles,
  presence,
}) {
  const router = express.Router();

  if (!authMiddleware) {
    throw new Error('createUsersV2Router: authMiddleware is required');
  }
  if (!accounts) {
    throw new Error('createUsersV2Router: accounts service is required');
  }
  if (!profiles) {
    throw new Error('createUsersV2Router: profiles service is required');
  }
  if (!presence) {
    throw new Error('createUsersV2Router: presence service is required');
  }

  async function buildPublicUser(userId) {
    const base = await accounts.getUserDtoById(userId);
    if (!base) return null;

    const profile = await profiles.getProfile(userId);
    const pres = await presence.getPresence(userId);

    return {
      id: base.id,
      username: base.username,
      displayName: profile?.displayName ?? base.displayName ?? null,
      avatarUrl: profile?.avatarUrl ?? base.avatarUrl ?? null,
      bannerUrl: profile?.bannerUrl ?? base.bannerUrl ?? null,
      bio: profile?.bio ?? base.bio ?? null,
      about: profile?.about ?? base.about ?? null,
      accentColor: profile?.accentColor ?? base.accentColor ?? null,
      status: pres?.status ?? base.status ?? 'offline',
      customStatus: pres?.customStatus ?? base.customStatus ?? null,
      lastSeen: pres?.lastSeen ?? base.lastSeen ?? null,
      createdAt: base.createdAt ?? null,
    };
  }

  router.get('/users/:userId', authMiddleware, async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'bad_user_id' });
    }

    const user = await buildPublicUser(userId);
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    return res.json({ user });
  });

  router.get('/users/by-username/:username', authMiddleware, async (req, res) => {
    const username = String(req.params.username || '').trim();
    if (!username) {
      return res.status(400).json({ error: 'bad_username' });
    }

    const authRow = await accounts.getUserForAuthByUsernameNorm(
      username.toLowerCase()
    );

    if (!authRow) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const user = await buildPublicUser(authRow.id);
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    return res.json({ user });
  });

  return router;
}