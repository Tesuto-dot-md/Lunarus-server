import { Pool } from 'pg';
import { DATABASE_URL } from './config.js';

if (!DATABASE_URL) {
  console.warn('[WARN] DATABASE_URL is not set. Messages will not be persisted.');
}

export const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

export async function withTransaction(fn) {
  if (!pool) throw new Error('db not configured');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}
