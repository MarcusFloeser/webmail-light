'use strict';

const db = require('../db');
const { AccountWorker } = require('./worker');

const workers = new Map();

async function startAll() {
  const rows = await db.many('SELECT * FROM mail_accounts WHERE enabled = true ORDER BY id');
  for (const row of rows) start(row);
  console.log(`[imap] ${rows.length} Konto(en) gestartet`);
}

function start(row) {
  if (workers.has(row.id)) return workers.get(row.id);
  const w = new AccountWorker(row);
  workers.set(row.id, w);
  w.start();
  return w;
}

async function stop(id) {
  const w = workers.get(id);
  if (!w) return;
  workers.delete(id);
  await w.stop();
}

async function restart(id) {
  await stop(id);
  const row = await db.one('SELECT * FROM mail_accounts WHERE id = $1', [id]);
  if (row && row.enabled) start(row);
}

function get(id) {
  const w = workers.get(Number(id));
  if (!w) {
    const err = new Error('Konto ist deaktiviert oder nicht verbunden');
    err.status = 409;
    throw err;
  }
  return w;
}

async function stopAll() {
  await Promise.all([...workers.keys()].map(stop));
}

module.exports = { startAll, start, stop, restart, get, stopAll };
