import cors from 'cors';
import {
  PUBLIC_BASE_URL,
} from './config.js';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://app.lunarus.ru,https://lunarus.ru,http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (CORS_ORIGINS.includes(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.lunarus\.ru$/.test(origin)) return true;
  return false;
}

export function createCorsOptions() {
  return {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
  };
}

export function applyApiErrorEnvelope() {
  return (req, res, next) => {
    const oldJson = res.json.bind(res);
    res.json = (body) => {
      try {
        if (res.statusCode >= 400 && body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'error')) {
          if (!Object.prototype.hasOwnProperty.call(body, 'code')) {
            const code = errorCodeFromError(body.error);
            return oldJson({ ...body, code });
          }
        }
      } catch (_) {}
      return oldJson(body);
    };
    next();
  };
}

export function errorCodeFromError(err) {
  return String(err || 'error')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'ERROR';
}

export function createErrorHandler() {
  return (err, req, res, next) => {
    try {
      console.error('[API ERROR]', err);
    } catch (_) {}

    if (res.headersSent) return next(err);

    const status = Number(err?.status || err?.statusCode || 500);
    let error = 'internal_error';
    if (status >= 400 && status < 500) {
      error = String(err?.message || err?.error || 'bad_request');
    }

    return res.status(status).json({
      error,
      code: errorCodeFromError(error),
      details: err?.details,
    });
  };
}

export function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

export { cors };
