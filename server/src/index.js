import 'express-async-errors';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';

import { PORT } from './common/config.js';
import { pool } from './common/db.js';
import { createEmailService } from './email.js';
import { createGateway, GATEWAY_PATH } from './gateway/gateway.js';
import {
  createCorsOptions,
  createErrorHandler,
  applyApiErrorEnvelope,
  cors,
  getPublicBaseUrl,
} from './http/http.js';

import { createProfilesService } from './accounts/profile/service.js';
const profiles = createProfilesService({ pool });

import { genId, genInviteCode, sha256Hex } from './common/ids.js';
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
import { createAccountsService } from './accounts/core/service.js';
import { createAuthRouter } from './routes/auth.js';
import { createMeRouter } from './routes/me.js';
import { createMessagesRouter } from './routes/messages.js';
import { createServersRouter } from './routes/servers.js';
import { createUsersRouter } from './routes/users.js';
import { createVoiceRouter } from './routes/voice.js';
import { ensureSchema } from './common/schema.js';

const app = express();
app.set('trust proxy', true);

const httpServer = createServer(app);
const corsOptions = createCorsOptions();
const permissions = createPermissions({ pool });
const emailService = createEmailService({ pool });
const accounts = createAccountsService();

let gateway = createGateway({
  server: httpServer,
  pool,
  permissions,
  getPublicUserProfile: async (userId) => {
    const base = await accounts.getUserDtoById(String(userId));
    if (!base) return null;
    return base;
  },
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(cookieParser());
app.use(express.json());

app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  immutable: true,
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

app.use(applyApiErrorEnvelope());

app.get('/health', (_req, res) => res.json({ ok: true }));

// Auth
app.use(createAuthRouter({
  pool,
  accounts,
  normalizeEmail: (email) => String(email || '').trim().toLowerCase(),
  isValidEmail: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')),
  isValidUsername: (username) => String(username || '').trim().length >= 3,
  isValidPassword: (password) => String(password || '').length >= 8,
  setRefreshCookie: () => {},
  clearRefreshCookie: () => {},
  getPublicBaseUrl,
  sendEmail: emailService.sendEmail,
  createEmailToken: emailService.createEmailToken,
  consumeEmailToken: emailService.consumeEmailToken,
  htmlPage: emailService.htmlPage,
  genId,
  sha256Hex,
}));

// Me
app.use(createMeRouter({
  pool,
  authMiddleware: (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev');
      req.user = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'unauthorized' });
    }
  },
  accounts,
  profiles,
  avatarUpload,
  UPLOAD_DIR,
  ensureDirSync,
  safeUnlinkIfLocal,
  normalizeEmail: (email) => String(email || '').trim().toLowerCase(),
  isValidEmail: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')),
  isValidUsername: (username) => String(username || '').trim().length >= 3,
  hashPassword: async (p) => p,
  verifyPassword: async (h, p) => h === p,
  isValidPassword: (p) => String(p || '').length >= 8,
}));

// Users (legacy)
app.use(createUsersRouter({
  pool,
  authMiddleware: (req, res, next) => next(),
  getPublicUserProfile: async (id) => accounts.getUserDtoById(String(id)),
  isUserOnline: () => false,
  avatarUpload,
  mimeToExt: () => 'webp',
  UPLOAD_DIR,
  AVATAR_SUBDIR: 'avatars',
  ensureDirSync,
  safeUnlinkIfLocal,
  hashPassword: async (p) => p,
  verifyPassword: async (h, p) => h === p,
  isValidPassword: (p) => String(p || '').length >= 8,
  clampStr: (s, l) => String(s || '').slice(0, l),
  isValidAvatarUrl: () => true,
}));

// Servers
app.use(createServersRouter({
  pool,
  authMiddleware: (req, res, next) => next(),
  permissions,
  withTransaction: async (fn) => fn(pool),
  genId,
  genInviteCode,
}));

// Messages
app.use(createMessagesRouter({
  pool,
  authMiddleware: (req, res, next) => next(),
  permissions,
  mediaUpload,
  finalizeMediaUpload,
  broadcast: () => {},
}));

// Voice
app.use(createVoiceRouter({
  authMiddleware: (req, res, next) => next(),
  getPublicBaseUrl,
}));

app.use(createErrorHandler());

ensureSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`🚀 Lunarus-server запущен на порту :${PORT}`);
      console.log(`🌐 Gateway: ${GATEWAY_PATH}`);
    });
  })
  .catch((e) => {
    console.error('[FATAL] failed to init schema', e);
    process.exit(1);
  });