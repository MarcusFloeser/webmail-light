'use strict';

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT (int8) als Number zurückgeben – UIDs/IDs passen locker in 2^53.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
pool.on('error', (err) => console.error('[db] Pool-Fehler:', err.message));

async function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Mehrere Instanzen gleichzeitig? -> Advisory Lock.
  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(424242)');
    await c.query(sql);
  });
}

async function waitForDb(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[db] warte auf Datenbank (${err.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Datenbank nicht erreichbar');
}

module.exports = { pool, query, one, many, tx, migrate, waitForDb };
