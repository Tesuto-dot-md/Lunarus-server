import 'express-async-errors';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';

import { PORT } from './config.js';
import {
  authMiddleware,
  hashPassword,
  verifyPassword,
} from './auth/core.js';
import { clearRefreshCookie, setRefreshCookie } from './auth/cookies.js';
import { pool, withTransaction } from './db.js';
import { createEmailService } from './email.js';
import { createGateway, GATEWAY_PATH } from './gateway.js';
import {
  createCorsOptions,
  createErrorHandler,
  applyApiErrorEnvelope,
  cors,
  getPublicBaseUrl,
} from './http.js';
import { genId, genInviteCode, sha256Hex } from './ids.js';
import {
  AVATAR_SUBDIR,
  UPLOAD_DIR,
  avatarUpload,
  ensureDirSync,
  finalizeMediaUpload,
  mediaUpload,
  mimeToExt,
  safeUnlinkIfLocal,
} from './media.js';
import { createPermissions } from './permissions.js';
import { createAccountsService } from './accounts/service.js';
import { createProfilesService } from './profiles/service.js';
import { createPresenceService } from './presence/service.js';
import { createAuthRouter } from './routes/auth.js';
import { createMeRouter } from './routes/me.js';
import { createMessagesRouter } from './routes/messages.js';
import { createServersRouter } from './routes/servers.js';
import { createUsersRouter } from './routes/users.js';
import { createUsersV2Router } from './routes/users_v2.js';
import { createVoiceRouter } from './routes/voice.js';
import { ensureSchema } from './schema.js';
import {
  clampStr,
  isValidAvatarUrl,
  isValidEmail,
  isValidPassword,
  isValidUsername,
  normalizeEmail,
} from './validation.js';

const app = express();
app.set('trust proxy', true);

const httpServer = createServer(app);
const corsOptions = createCorsOptions();
const permissions = createPermissions({ pool });
const emailService = createEmailService({ pool });

let gateway;

// v2 services
const accounts = createAccountsService({ pool });
const profiles = createProfilesService({ pool });
const presence = createPresenceService({ pool });

async function getPublicUserProfileCompat(userId) {
  const base = await accounts.getUserDtoById(String(userId));
  if (!base) return null;

  const profile = await profiles.getProfile(String(userId));
  const pres = await presence.getPresence(String(userId));

  return {
    id: base.id,
    username: base.username,
    displayName: profile?.displayName ?? base.displayName ?? null,
    avatarUrl: profile?.avatarUrl ?? base.avatarUrl ?? null,
    bannerUrl: profile?.bannerUrl ?? base.bannerUrl ?? null,
    bio: profile?.bio ?? base.bio ?? null,
    lastSeen: pres?.lastSeen ?? base.lastSeen ?? null,
  };
}

gateway = createGateway({
  server: httpServer,
  pool,
  permissions,
  getPublicUserProfile: getPublicUserProfileCompat,
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(cookieParser());
app.use(express.json());

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);

app.use(applyApiErrorEnvelope());

app.get('/health', (_req, res) => res.json({ ok: true }));

// Auth
app.use(
  createAuthRouter({
    pool,
    normalizeEmail,
    isValidEmail,
    isValidUsername,
    isValidPassword,
    setRefreshCookie,
    clearRefreshCookie,
    getPublicBaseUrl,
    sendEmail: emailService.sendEmail,
    createEmailToken: emailService.createEmailToken,
    consumeEmailToken: emailService.consumeEmailToken,
    htmlPage: emailService.htmlPage,
    genId,
    sha256Hex,
    accounts,
  })
);

// v2 routes go first so they win over legacy duplicates
app.use(
  createMeRouter({
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
  })
);

app.use(
  createUsersV2Router({
    authMiddleware,
    accounts,
    profiles,
    presence,
  })
);

// Legacy router stays for compatibility, especially settings and older clients
app.use(
  createUsersRouter({
    pool,
    authMiddleware,
    getPublicUserProfile: getPublicUserProfileCompat,
    isUserOnline: (userId) => gateway?.isUserOnline?.(userId) ?? false,
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
  })
);

app.use(
  createServersRouter({
    pool,
    authMiddleware,
    permissions,
    withTransaction,
    genId,
    genInviteCode,
  })
);

app.use(
  createMessagesRouter({
    pool,
    authMiddleware,
    permissions,
    mediaUpload,
    finalizeMediaUpload,
    broadcast: gateway.broadcast,
  })
);

app.use(
  createVoiceRouter({
    authMiddleware,
    getPublicBaseUrl,
  })
);

app.use(createErrorHandler());

ensureSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`server listening on :${PORT}`);
      console.log(`gateway ws path: ${GATEWAY_PATH}`);
    });
  })
  .catch((e) => {
    console.error('[FATAL] failed to init schema', e);
    process.exit(1);
  });