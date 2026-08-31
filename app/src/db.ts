/**
 * Database connection and initialization via Drizzle ORM + node-postgres.
 *
 * Replaces app/dependencies.py (SQLAlchemy engine + session management).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './models';
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL environment variable is not set. ' +
    'Please set it in your .env file or environment.',
  );
}

const pool = new Pool({ connectionString: databaseUrl });

export const db = drizzle(pool, { schema });

// Resolve db.sql relative to this module so it works regardless of CWD.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load the schema SQL from db.sql and execute it.
 * Used for test initialization only — production relies on Docker's
 * db.sql volume mount for schema setup.
 */
export async function initDb(): Promise<void> {
  const sqlPath = join(__dirname, '../db.sql');
  const sql = readFileSync(sqlPath, 'utf-8');
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

/**
 * Export the pool for test teardown.
 */
export { pool };
