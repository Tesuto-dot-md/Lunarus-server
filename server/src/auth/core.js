// src/auth/core.js
import argon2 from 'argon2';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, ARGON2_MEMORY_KIB, ARGON2_TIME_COST, ARGON2_PARALLELISM, PASSWORD_PEPPER } from '../common/config.js';

export function randomToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

export async function hashPassword(plainPassword) {
  const peppered = PASSWORD_PEPPER ? plainPassword + PASSWORD_PEPPER : plainPassword;
  return await argon2.hash(peppered, {
    type: argon2.argon2id,
    memoryCost: ARGON2_MEMORY_KIB,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
  });
}

export async function verifyPassword(hashedPassword, plainPassword) {
  const peppered = PASSWORD_PEPPER ? plainPassword + PASSWORD_PEPPER : plainPassword;
  try {
    return await argon2.verify(hashedPassword, peppered);
  } catch {
    return false;
  }
}

export function signJwt(payload, expiresIn = '15m') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyJwt(token) {
  return jwt.verify(token, JWT_SECRET);
}