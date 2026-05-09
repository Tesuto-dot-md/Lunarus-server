export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normalizeEmail(email);
  return e.length >= 6 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function isValidUsername(username) {
  const u = String(username || '').trim();
  return u.length >= 3 && u.length <= 24 && /^[\p{L}\p{N}_-]+$/u.test(u);
}

export function isValidPassword(password) {
  const p = String(password || '');
  return p.length >= 8 && p.length <= 128;
}

export function clampStr(value, maxLen) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function isValidAvatarUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) return true;
  if (s.length > 2048) return false;
  if (s.startsWith('data:image/')) return s.length <= 1_200_000;
  if (s.startsWith('/uploads/')) return true;
  return /^https?:\/\//i.test(s);
}
