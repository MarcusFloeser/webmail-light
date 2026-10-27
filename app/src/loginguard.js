'use strict';

/**
 * Schutz gegen Passwort-Raten (Brute Force / Password Spraying).
 *
 * Fehlversuche werden in der Datenbank gezählt (übersteht Neustarts):
 *  - gleiche IP + gleiches Konto:  LOGIN_MAX_PER_ACCOUNT (5) in 15 Min. → 15 Min. gesperrt
 *  - gleiche IP, beliebige Konten: LOGIN_MAX_PER_IP (20) in 60 Min.     → 60 Min. gesperrt
 *  - gleiches Konto, viele IPs:    ab 30 in 60 Min. nur Verzögerung (keine Sperre – sonst
 *    könnte ein Angreifer den echten Benutzer aussperren)
 * Jeder Fehlversuch wird zusätzlich verzögert beantwortet und protokolliert
 * („[login] Fehlversuch …“ – für fail2ban geeignet).
 * Netze in LOGIN_WHITELIST (z. B. 192.168.1.0/24) sind ausgenommen.
 */
const net = require('net');
const db = require('./db');
const config = require('./config');

const ACCOUNT_WINDOW_MIN = 15;
const IP_WINDOW_MIN = 60;
const lc = (s) => String(s || '').trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function limits() {
  return {
    perAccount: config.loginMaxPerAccount || 5,
    perIp: config.loginMaxPerIp || 20,
    accountSlow: 30,
  };
}

/** IPv4-mapped IPv6 (::ffff:1.2.3.4) → 1.2.3.4 */
function normIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

let blockList = null;
function whitelist() {
  if (blockList) return blockList;
  blockList = new net.BlockList();
  for (const part of String(config.loginWhitelist || '').split(/[\s,]+/).filter(Boolean)) {
    try {
      const [addr, bits] = part.split('/');
      const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
      if (bits) blockList.addSubnet(addr, parseInt(bits, 10), type);
      else blockList.addAddress(addr, type);
    } catch (_) { console.warn(`[login] Ungültiger Eintrag in LOGIN_WHITELIST: ${part}`); }
  }
  return blockList;
}

function whitelisted(ip) {
  const a = normIp(ip);
  if (!a) return false;
  try { return whitelist().check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4'); } catch (_) { return false; }
}

/**
 * Ist diese Anmeldung gesperrt? → null oder { until: Date, reason: 'account'|'ip' }
 */
async function check(ipRaw, usernameRaw) {
  const ip = normIp(ipRaw);
  const username = lc(usernameRaw);
  if (whitelisted(ip)) return null;
  const L = limits();
  const acc = await db.one(
    `SELECT count(*)::int AS n, max(at) AS last FROM login_failures
      WHERE ip = $1 AND username = $2 AND at > now() - ($3 || ' minutes')::interval`,
    [ip, username, String(ACCOUNT_WINDOW_MIN)]);
  if (acc && acc.n >= L.perAccount) {
    return { reason: 'account', until: new Date(new Date(acc.last).getTime() + ACCOUNT_WINDOW_MIN * 60000) };
  }
  const byIp = await db.one(
    `SELECT count(*)::int AS n, max(at) AS last FROM login_failures
      WHERE ip = $1 AND at > now() - ($2 || ' minutes')::interval`, [ip, String(IP_WINDOW_MIN)]);
  if (byIp && byIp.n >= L.perIp) {
    return { reason: 'ip', until: new Date(new Date(byIp.last).getTime() + IP_WINDOW_MIN * 60000) };
  }
  return null;
}

/** Fehlversuch festhalten, protokollieren und Antwort verzögern. */
async function fail(ipRaw, usernameRaw, kind = 'login') {
  const ip = normIp(ipRaw);
  const username = lc(usernameRaw).slice(0, 200);
  console.warn(`[login] Fehlversuch (${kind}) für "${username}" von ${ip}`);
  if (whitelisted(ip)) { await sleep(config.loginFailDelayMs ?? 1000); return; }
  await db.query('INSERT INTO login_failures (ip, username, kind) VALUES ($1, $2, $3)', [ip, username, kind]);
  // Konto wird von vielen Seiten angegriffen → stärker bremsen
  const spread = await db.one(
    `SELECT count(*)::int AS n FROM login_failures WHERE username = $1 AND at > now() - interval '60 minutes'`, [username]);
  const base = config.loginFailDelayMs ?? 1000;
  await sleep(spread && spread.n >= limits().accountSlow ? base * 3 : base);
  if (Math.random() < 0.05) cleanup().catch(() => {});
}

/** Erfolgreiche Anmeldung: Fehlversuche dieses Kontos von dieser IP vergessen. */
async function success(ipRaw, usernameRaw) {
  await db.query('DELETE FROM login_failures WHERE ip = $1 AND username = $2', [normIp(ipRaw), lc(usernameRaw)]);
}

async function cleanup() {
  await db.query("DELETE FROM login_failures WHERE at < now() - interval '2 days'");
}

function message(block) {
  const min = Math.max(1, Math.ceil((block.until - Date.now()) / 60000));
  return block.reason === 'ip'
    ? `Zu viele fehlgeschlagene Anmeldungen von dieser Adresse – bitte in ${min} Minute${min === 1 ? '' : 'n'} erneut versuchen`
    : `Zu viele Fehlversuche für dieses Konto – bitte in ${min} Minute${min === 1 ? '' : 'n'} erneut versuchen`;
}

/** Übersicht für Admins: aktuelle Sperren und letzte Fehlversuche */
async function overview() {
  const L = limits();
  const locks = await db.many(
    `SELECT ip, username, count(*)::int AS n, max(at) AS last FROM login_failures
      WHERE at > now() - ($1 || ' minutes')::interval GROUP BY ip, username HAVING count(*) >= $2
      ORDER BY max(at) DESC`, [String(ACCOUNT_WINDOW_MIN), L.perAccount]);
  const ipLocks = await db.many(
    `SELECT ip, count(*)::int AS n, count(DISTINCT username)::int AS accounts, max(at) AS last FROM login_failures
      WHERE at > now() - ($1 || ' minutes')::interval GROUP BY ip HAVING count(*) >= $2 ORDER BY max(at) DESC`,
    [String(IP_WINDOW_MIN), L.perIp]);
  const recent = await db.many(
    'SELECT ip, username, kind, at FROM login_failures ORDER BY at DESC LIMIT 50');
  const day = await db.one(
    `SELECT count(*)::int AS n, count(DISTINCT ip)::int AS ips FROM login_failures WHERE at > now() - interval '24 hours'`);
  return {
    limits: { ...L, accountWindowMin: ACCOUNT_WINDOW_MIN, ipWindowMin: IP_WINDOW_MIN },
    locks: [
      ...ipLocks.map((r) => ({ kind: 'ip', ip: r.ip, username: '', count: r.n, accounts: r.accounts, until: new Date(new Date(r.last).getTime() + IP_WINDOW_MIN * 60000) })),
      ...locks.map((r) => ({ kind: 'account', ip: r.ip, username: r.username, count: r.n, until: new Date(new Date(r.last).getTime() + ACCOUNT_WINDOW_MIN * 60000) })),
    ],
    recent,
    last24h: day,
    whitelist: String(config.loginWhitelist || ''),
  };
}

/** Sperre aufheben (Admin): eine IP, ein Konto an einer IP oder ein Konto überall. */
async function unblock({ ip, username }) {
  if (ip && username) await db.query('DELETE FROM login_failures WHERE ip = $1 AND username = $2', [normIp(ip), lc(username)]);
  else if (ip) await db.query('DELETE FROM login_failures WHERE ip = $1', [normIp(ip)]);
  else if (username) await db.query('DELETE FROM login_failures WHERE username = $1', [lc(username)]);
}

module.exports = { check, fail, success, message, overview, unblock, normIp, whitelisted, _reset: () => { blockList = null; } };
