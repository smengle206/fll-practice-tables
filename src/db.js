const { Pool } = require('pg');

// Railway's Postgres plugin provides DATABASE_URL automatically.
const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: connectionString.includes('railway.internal') ? false : { rejectUnauthorized: false },
    })
  : null;

async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not set');
  return pool.query(text, params);
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

module.exports = { pool, query, checkConnection };
