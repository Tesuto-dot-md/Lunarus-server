import { z } from 'zod';

export const UserModel = z.object({
  id: z.string().min(1),
  email: z.string().email().nullable(),
  emailVerified: z.boolean().default(false),
  username: z.string().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u),
  usernameNorm: z.string().min(3).max(32),
  globalName: z.string().max(32).nullable().default(null), // displayName в Discord
  avatarUrl: z.string().nullable().default(null),
  bannerUrl: z.string().nullable().default(null),
  accentColor: z.string().nullable().default(null), // #hex
  bio: z.string().max(190).nullable().default(null),
  about: z.string().max(1024).nullable().default(null),
  status: z.enum(['online', 'idle', 'dnd', 'invisible', 'offline']).default('offline'),
  customStatus: z.string().max(160).nullable().default(null),
  flags: z.number().int().default(0), // user flags (verified, staff и т.д.)
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable().default(null),
  lastSeen: z.number().int().nullable().default(null),
});

export const UserCreateInput = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
});

export const UserUpdateInput = z.object({
  email: z.string().email().optional(),
  username: z.string().min(3).max(32).optional(),
  globalName: z.string().max(32).nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  bannerUrl: z.string().nullable().optional(),
  accentColor: z.string().nullable().optional(),
  bio: z.string().max(190).nullable().optional(),
  status: z.enum(['online', 'idle', 'dnd', 'invisible', 'offline']).optional(),
  customStatus: z.string().max(160).nullable().optional(),
}).partial();

export function validateUser(data) {
  return UserModel.safeParse(data);
}

export default {
  UserModel,
  UserCreateInput,
  UserUpdateInput,
  validateUser,
};