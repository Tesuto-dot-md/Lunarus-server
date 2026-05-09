import {
  COOKIE_DOMAIN,
  COOKIE_SAMESITE,
  COOKIE_SECURE,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_MS,
} from '../config.js';

export function getRefreshCookieOptions({ withMaxAge = true } = {}) {
  const opts = {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    path: REFRESH_COOKIE_PATH,
  };
  if (withMaxAge) opts.maxAge = REFRESH_TOKEN_TTL_MS;
  if (COOKIE_DOMAIN) opts.domain = COOKIE_DOMAIN;
  return opts;
}

export function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, getRefreshCookieOptions({ withMaxAge: true }));
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieOptions({ withMaxAge: false }));
}
