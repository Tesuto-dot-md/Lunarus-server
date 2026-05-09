import 'dotenv/config';

export const PORT = Number(process.env.PORT ?? 8080);
export const DATABASE_URL = process.env.DATABASE_URL ?? null;
export const JWT_SECRET = process.env.JWT_SECRET || 'devjwtsecret';

export const ACCESS_TOKEN_TTL_SEC = Number(process.env.ACCESS_TOKEN_TTL_SEC || 900);
export const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
export const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60_000;

export const REFRESH_COOKIE_NAME = process.env.REFRESH_COOKIE_NAME || 'lunarus_rt';
export const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN || '').trim();
export const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'true') !== 'false';
export const COOKIE_SAMESITE = process.env.COOKIE_SAMESITE || 'lax';
export const REFRESH_COOKIE_PATH = process.env.REFRESH_COOKIE_PATH || '/auth';

export const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || '';
export const ALLOW_USERNAME_LOGIN = (process.env.ALLOW_USERNAME_LOGIN ?? 'true') !== 'false';
export const ENFORCE_EMAIL_VERIFICATION = (process.env.ENFORCE_EMAIL_VERIFICATION ?? 'true') !== 'false';

export const ARGON2_MEMORY_KIB = Number(process.env.ARGON2_MEMORY_KIB || 19456);
export const ARGON2_TIME_COST = Number(process.env.ARGON2_TIME_COST || 2);
export const ARGON2_PARALLELISM = Number(process.env.ARGON2_PARALLELISM || 1);

export const SMTP_HOST = process.env.SMTP_HOST || '';
export const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
export const SMTP_SECURE = (process.env.SMTP_SECURE ?? 'false') === 'true';
export const SMTP_USER = process.env.SMTP_USER || '';
export const SMTP_PASS = process.env.SMTP_PASS || '';
export const SMTP_FROM = process.env.SMTP_FROM || 'Lunarus <no-reply@lunarus.local>';

export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

export const LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'http://localhost:7880';
export const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
export const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret';
export const LIVEKIT_HTTP_URL = String(LIVEKIT_URL || '')
  .replace(/^wss:/, 'https:')
  .replace(/^ws:/, 'http:')
  .replace(/\/$/, '');
