const { Pool } = require('pg');

// Railway's Postgres plugin provides DATABASE_URL automatically.
const connectionString = process.env.DATABASE_URL;

// Railway's private network and local databases don't use SSL; public proxies do.
function needsSsl(url) {
  return !/railway\.internal|localhost|127\.0\.0\.1/.test(url);
}

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : false,
    })
  : null;

async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not set');
  return pool.query(text, params);
}

async function withTransaction(fn) {
  if (!pool) throw new Error('DATABASE_URL is not set');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function checkConnection() {
  if (!pool) return { ok: false, reason: 'DATABASE_URL not set' };
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Creates tables on startup if they don't exist yet. Safe to run repeatedly.
async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slots (
      id           SERIAL PRIMARY KEY,
      start_at     TIMESTAMPTZ NOT NULL UNIQUE,
      duration_min INTEGER NOT NULL CHECK (duration_min > 0)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id         SERIAL PRIMARY KEY,
      number     INTEGER NOT NULL UNIQUE,
      name       TEXT NOT NULL DEFAULT '',
      pin        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id         SERIAL PRIMARY KEY,
      slot_id    INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
      team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      table_no   INTEGER NOT NULL CHECK (table_no > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (slot_id, table_no),
      UNIQUE (slot_id, team_id)
    );

    INSERT INTO settings (key, value) VALUES
      ('slot_minutes', '10'),
      ('tables_per_slot', '2'),
      ('event_date', to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'))
    ON CONFLICT (key) DO NOTHING;
  `);
}

module.exports = { pool, query, withTransaction, checkConnection, migrate };
