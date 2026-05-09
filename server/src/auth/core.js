import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import crypto from 'crypto';
import {
  ACCESS_TOKEN_TTL_SEC,
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  JWT_SECRET,
  PASSWORD_PEPPER,
} from '../config.js';

export function signJwt(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SEC });
}

export function verifyJwt(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'missing authorization' });

  try {
    req.user = verifyJwt(match[1]);
    return next();
  } catch (error) {
    if (error && error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'token_expired' });
    }
    return res.status(401).json({ error: 'invalid authorization' });
  }
}

export async function hashPassword(password) {
  const peppered = String(password) + PASSWORD_PEPPER;
  return argon2.hash(peppered, {
    type: argon2.argon2id,
    memoryCost: ARGON2_MEMORY_KIB,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
  });
}

export async function verifyPassword(passHash, password) {
  const peppered = String(password) + PASSWORD_PEPPER;
  return argon2.verify(String(passHash), peppered);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
