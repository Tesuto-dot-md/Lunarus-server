import argon2 from 'argon2';
import {
  ARGON2_MEMORY_KIB,
  ARGON2_TIME_COST,
  ARGON2_PARALLELISM,
  PASSWORD_PEPPER,
} from '../../common/config.js';

/**
 * Хэширует пароль с pepper + argon2
 */
export async function hashPassword(plainPassword) {
  const peppered = PASSWORD_PEPPER
    ? plainPassword + PASSWORD_PEPPER
    : plainPassword;

  return await argon2.hash(peppered, {
    type: argon2.argon2id,
    memoryCost: ARGON2_MEMORY_KIB,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
  });
}

/**
 * Проверяет пароль
 */
export async function verifyPassword(hashedPassword, plainPassword) {
  const peppered = PASSWORD_PEPPER
    ? plainPassword + PASSWORD_PEPPER
    : plainPassword;

  try {
    return await argon2.verify(hashedPassword, peppered);
  } catch {
    return false;
  }
}

export default {
  hashPassword,
  verifyPassword,
};