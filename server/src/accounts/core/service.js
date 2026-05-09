import { genId } from '../../common/ids.js';
import { normalizeEmail, isValidEmail, isValidUsername, isValidPassword } from '../../common/validation.js';
import { UserCreateInput, UserUpdateInput, validateUser } from './model.js';
import * as repo from './repository.js';
import { hashPassword, verifyPassword } from '../auth/password.js'; // будет создан следующим

export function createAccountsService() {

  /**
   * Регистрация нового пользователя
   */
  async function createAccount({ email, username, password }) {
    const emailNorm = normalizeEmail(email);
    const usernameNorm = String(username).trim().toLowerCase();

    // Валидация
    if (!isValidEmail(email)) throw Object.assign(new Error('bad_email'), { code: 'bad_email' });
    if (!isValidUsername(username)) throw Object.assign(new Error('bad_username'), { code: 'bad_username' });
    if (!isValidPassword(password)) throw Object.assign(new Error('bad_password'), { code: 'bad_password' });

    // Проверка доступности
    const availability = await repo.checkAvailability({ emailNorm, usernameNorm });
    if (availability.emailTaken) throw Object.assign(new Error('email_taken'), { code: 'email_taken' });
    if (availability.usernameTaken) throw Object.assign(new Error('username_taken'), { code: 'username_taken' });

    const userId = genId('u');
    const passHash = await hashPassword(password);
    const now = Date.now();

    await repo.createUser({
      id: userId,
      email: email.trim(),
      emailNorm,
      username: username.trim(),
      usernameNorm,
      passHash,
    });

    return await getMeDto(userId);
  }

  /**
   * Получить полные данные пользователя для себя (me)
   */
  async function getMeDto(userId) {
    const user = await repo.getUserById(userId);
    if (!user) return null;

    // Позже сюда добавим profile + presence
    return {
      id: user.id,
      username: user.username,
      globalName: user.globalName,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      accentColor: user.accentColor,
      bio: user.bio,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      status: user.status,
      customStatus: user.customStatus,
      lastSeen: user.lastSeen,
    };
  }

  /**
   * Публичный профиль (для других пользователей)
   */
  async function getUserDtoById(userId) {
    return await repo.getPublicUser(userId);
  }

  /**
   * Логин по email + password
   */
  async function verifyEmailPassword({ email, password }) {
    const emailNorm = normalizeEmail(email);
    const user = await repo.getUserByIdForAuth(emailNorm); // добавим метод в repository позже

    if (!user || !(await verifyPassword(user.passHash, password))) {
      throw Object.assign(new Error('bad_credentials'), { code: 'bad_credentials' });
    }

    if (!user.emailVerified) {
      throw Object.assign(new Error('email_not_verified'), { code: 'email_not_verified' });
    }

    return user;
  }

  /**
   * Обновление аккаунта (email, username, globalName и т.д.)
   */
  async function updateAccount({ userId, email, username, globalName, ...rest }) {
    const updates = UserUpdateInput.parse({
      email,
      username,
      globalName,
      ...rest,
    });

    await repo.updateUser(userId, updates);
    return await getMeDto(userId);
  }

  /**
   * Сброс пароля + отзыв всех сессий
   */
  async function setPassword({ userId, newPassword, revokeAllSessions = true }) {
    if (!isValidPassword(newPassword)) throw Object.assign(new Error('bad_password'), { code: 'bad_password' });

    const passHash = await hashPassword(newPassword);
    // Обновление пароля будет в repository (добавим позже)
    await repo.updatePassword(userId, passHash);

    if (revokeAllSessions) {
      await revokeAllSessions({ userId });
    }

    return true;
  }

  /**
   * Отметить email как подтверждённый
   */
  async function markEmailVerified(userId) {
    await repo.markEmailVerified(userId);
    return true;
  }

  // TODO: sessions, 2fa, oauth — вынесем в accounts/auth/ позже

  return {
    createAccount,
    getMeDto,
    getUserDtoById,
    verifyEmailPassword,
    updateAccount,
    setPassword,
    markEmailVerified,
  };
}