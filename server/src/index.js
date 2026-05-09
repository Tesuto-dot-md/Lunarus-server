//import 'express-async-errors';
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

const app = express();
app.set('trust proxy', true);

const httpServer = createServer(app);
const corsOptions = createCorsOptions();
const permissions = createPermissions({ pool });
const emailService = createEmailService({ pool });

const accounts = createAccountsService();

let gateway;

// ====================== РОУТЕРЫ ======================
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
app.use(
  createAuthRouter({
    pool,
    normalizeEmail: require('./common/validation.js').normalizeEmail,
    isValidEmail: require('./common/validation.js').isValidEmail,
    isValidUsername: require('./common/validation.js').isValidUsername,
    isValidPassword: require('./common/validation.js').isValidPassword,
    setRefreshCookie: () => {},
    clearRefreshCookie: () => {},
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

// Me и Users
app.use(require('./routes/me.js').createMeRouter({ pool, authMiddleware: () => {}, accounts }));
app.use(require('./routes/users.js').createUsersRouter({ pool, authMiddleware: () => {}, accounts }));

app.use(require('./routes/servers.js').createServersRouter({ pool, authMiddleware: () => {}, permissions, withTransaction: async (fn) => fn(pool), genId, genInviteCode }));
app.use(require('./routes/messages.js').createMessagesRouter({ pool, authMiddleware: () => {}, permissions, mediaUpload, finalizeMediaUpload, broadcast: () => {} }));
app.use(require('./routes/voice.js').createVoiceRouter({ authMiddleware: () => {}, getPublicBaseUrl }));

app.use(createErrorHandler());

// ====================== ЗАПУСК ======================
ensureSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`🚀 Lunarus-server запущен на порту :${PORT}`);
      console.log(`🌐 Gateway: ${GATEWAY_PATH}`);
    });
  })
  .catch((e) => {
    console.error('[FATAL] Ошибка инициализации схемы', e);
    process.exit(1);
  });