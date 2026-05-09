import nodemailer from 'nodemailer';
import { randomToken } from './auth/core.js';
import { SMTP_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_SECURE, SMTP_USER } from './config.js';
import { sha256Hex } from './ids.js';

export function createEmailService({ pool }) {
  const mailer = SMTP_HOST
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      })
    : null;

  async function sendEmail({ to, subject, text }) {
    if (!mailer) return false;
    await mailer.sendMail({ from: SMTP_FROM, to, subject, text });
    return true;
  }

  async function createEmailToken({ userId, type, ttlMs }) {
    const token = randomToken(32);
    const tokenHash = sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + ttlMs;

    await pool.query(
      `INSERT INTO email_tokens(user_id, type, token_hash, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, type, tokenHash, expiresAt, now]
    );

    return token;
  }

  async function consumeEmailToken({ type, token }) {
    const tokenHash = sha256Hex(token);
    const now = Date.now();
    const r = await pool.query(
      `SELECT id, user_id AS "userId", expires_at AS "expiresAt", used_at AS "usedAt"
         FROM email_tokens
        WHERE type=$1 AND token_hash=$2
        ORDER BY created_at DESC
        LIMIT 1`,
      [type, tokenHash]
    );
    if (r.rowCount === 0) return { ok: false, reason: 'not_found' };
    const row = r.rows[0];
    if (row.usedAt) return { ok: false, reason: 'used' };
    if (Number(row.expiresAt) < now) return { ok: false, reason: 'expired' };

    await pool.query(`UPDATE email_tokens SET used_at=$2 WHERE id=$1`, [row.id, now]);
    return { ok: true, userId: String(row.userId) };
  }

  function htmlPage(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;padding:24px;max-width:720px;margin:0 auto"><h2>${title}</h2><p>${body}</p></body></html>`;
  }

  return {
    sendEmail,
    createEmailToken,
    consumeEmailToken,
    htmlPage,
  };
}
