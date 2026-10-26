'use strict';

/**
 * Zentrale Mailserver-Konfiguration pro Domain (nur für Admins sichtbar).
 *
 *  - Jede Domain (z. B. "example.ch") hat feste IMAP-/SMTP-Verbindungsdaten,
 *    optional einen CalDAV/CardDAV-Server.
 *  - "*" ist die Standard-Domain für alle übrigen Adressen.
 *  - Konten mit domain_id werden "verwaltet": Ihre Serverdaten kommen aus der Domain
 *    und werden Endbenutzern nicht angezeigt. Ändert der Admin die Domain, werden
 *    alle zugehörigen Konten automatisch umgestellt.
 *  - Beim ersten Start wird aus AUTH_IMAP_* / AUTH_SMTP_* (.env) die Standard-Domain erzeugt
 *    und bestehende Konten auf diesem Server werden ihr zugeordnet.
 */
const db = require('./db');
const config = require('./config');
const { effectiveSecurity } = require('./tls');

const DEFAULT = '*';
const SECURITY = ['ssl', 'starttls', 'none'];
const DOMAIN_RE = /^(\*|(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function domainOf(email) {
  const s = String(email || '').trim().toLowerCase();
  const i = s.lastIndexOf('@');
  return i >= 0 ? s.slice(i + 1) : '';
}

/** Öffentliche Darstellung (nur für Admins). */
function publicDomain(d, accountCount) {
  return {
    id: d.id, domain: d.domain, isDefault: d.domain === DEFAULT,
    imapHost: d.imap_host, imapPort: d.imap_port, imapSecurity: d.imap_security,
    smtpHost: d.smtp_host, smtpPort: d.smtp_port, smtpSecurity: d.smtp_security,
    loginFormat: d.login_format, allowInsecureTls: d.allow_insecure_tls,
    davUrl: d.dav_url || '', note: d.note || '',
    accounts: accountCount === undefined ? undefined : Number(accountCount),
    updatedAt: d.updated_at,
  };
}

/** Eingaben aus dem Admin-Formular prüfen. */
function domainInput(b, existing) {
  const v = {
    domain: String(b.domain ?? existing?.domain ?? '').trim().toLowerCase().replace(/^@/, ''),
    imap_host: String(b.imapHost ?? existing?.imap_host ?? '').trim(),
    imap_port: parseInt(b.imapPort ?? existing?.imap_port ?? 993, 10),
    imap_security: String(b.imapSecurity ?? existing?.imap_security ?? ''),
    smtp_host: String(b.smtpHost ?? existing?.smtp_host ?? '').trim(),
    smtp_port: parseInt(b.smtpPort ?? existing?.smtp_port ?? 587, 10),
    smtp_security: String(b.smtpSecurity ?? existing?.smtp_security ?? ''),
    login_format: String(b.loginFormat ?? existing?.login_format ?? 'email'),
    allow_insecure_tls: !!(b.allowInsecureTls ?? existing?.allow_insecure_tls ?? false),
    dav_url: String(b.davUrl ?? existing?.dav_url ?? '').trim(),
    note: String(b.note ?? existing?.note ?? '').trim().slice(0, 300),
  };
  if (!DOMAIN_RE.test(v.domain)) throw httpError(400, 'Bitte eine gültige Domain angeben (z. B. example.ch) oder * für alle übrigen');
  if (!v.imap_host || !v.smtp_host) throw httpError(400, 'IMAP- und SMTP-Server sind Pflichtfelder');
  for (const [p, n] of [[v.imap_port, 'IMAP'], [v.smtp_port, 'SMTP']]) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw httpError(400, `Ungültiger ${n}-Port`);
  }
  // leer = automatisch nach Port (993/465 = SSL, sonst STARTTLS)
  v.imap_security = effectiveSecurity('imap', v.imap_port, SECURITY.includes(v.imap_security) ? v.imap_security : '');
  v.smtp_security = effectiveSecurity('smtp', v.smtp_port, SECURITY.includes(v.smtp_security) ? v.smtp_security : '');
  if (!['email', 'local'].includes(v.login_format)) v.login_format = 'email';
  if (v.dav_url && !/^https?:\/\//i.test(v.dav_url)) throw httpError(400, 'Die Kalender/Kontakte-Adresse muss mit http:// oder https:// beginnen');
  return v;
}

async function list() {
  return db.many(
    `SELECT d.*, (SELECT count(*) FROM mail_accounts a WHERE a.domain_id = d.id) AS account_count
       FROM mail_domains d ORDER BY (d.domain = '*'), d.domain`);
}

/** Domain-Konfiguration für eine E-Mail-Adresse: exakte Domain, sonst Standard "*". */
async function findForEmail(email) {
  const dom = domainOf(email);
  if (dom) {
    const exact = await db.one('SELECT * FROM mail_domains WHERE domain = $1', [dom]);
    if (exact) return exact;
  }
  return db.one('SELECT * FROM mail_domains WHERE domain = $1', [DEFAULT]);
}

/** IMAP-Benutzername gemäss Domain: vollständige Adresse oder nur der Teil vor dem @. */
function loginFor(d, email) {
  const e = String(email || '').trim().toLowerCase();
  return d && d.login_format === 'local' ? e.split('@')[0] : e;
}

/** Serverfelder eines Kontos aus der Domain. */
function accountFields(d) {
  return {
    imap_host: d.imap_host,
    imap_port: d.imap_port,
    imap_security: d.imap_security,
    smtp_host: d.smtp_host,
    smtp_port: d.smtp_port,
    smtp_security: d.smtp_security,
    allow_insecure_tls: d.allow_insecure_tls,
  };
}

/** Geänderte Domain-Einstellungen auf alle zugehörigen Konten übertragen und neu verbinden. */
async function applyToAccounts(domainId) {
  const d = await db.one('SELECT * FROM mail_domains WHERE id = $1', [domainId]);
  if (!d) return 0;
  const f = accountFields(d);
  const rows = await db.many(
    `UPDATE mail_accounts SET imap_host=$2, imap_port=$3, imap_security=$4, smtp_host=$5, smtp_port=$6, smtp_security=$7,
            allow_insecure_tls=$8, status='pending', last_error=NULL
      WHERE domain_id = $1 AND (imap_host IS DISTINCT FROM $2 OR imap_port IS DISTINCT FROM $3 OR imap_security IS DISTINCT FROM $4
            OR smtp_host IS DISTINCT FROM $5 OR smtp_port IS DISTINCT FROM $6 OR smtp_security IS DISTINCT FROM $7
            OR allow_insecure_tls IS DISTINCT FROM $8)
      RETURNING id, enabled`,
    [d.id, f.imap_host, f.imap_port, f.imap_security, f.smtp_host, f.smtp_port, f.smtp_security, f.allow_insecure_tls]);
  if (rows.length) {
    const manager = require('./imap/manager');
    for (const r of rows) if (r.enabled) await manager.restart(r.id).catch(() => {});
  }
  return rows.length;
}

/**
 * Bestehende, noch nicht zugeordnete Konten den Domains zuordnen:
 *  - Konten, deren E-Mail-Domain ausdrücklich eingerichtet ist,
 *  - über die Standard-Domain "*" nur Konten, die schon auf deren Server liegen
 *    (fremde Konten wie Gmail bleiben unverändert).
 * Liefert die Anzahl zugeordneter Konten.
 */
async function assignExisting({ restart = true } = {}) {
  const domains = await db.many('SELECT * FROM mail_domains');
  if (!domains.length) return 0;
  const byName = new Map(domains.map((d) => [d.domain, d]));
  const def = byName.get(DEFAULT);
  const hosts = new Set(domains.map((d) => d.imap_host.toLowerCase()));
  if (config.authImap.host) hosts.add(config.authImap.host.toLowerCase());
  const accounts = await db.many('SELECT * FROM mail_accounts WHERE domain_id IS NULL');
  const changed = [];
  for (const a of accounts) {
    let d = byName.get(domainOf(a.email));
    if (!d && def && hosts.has(String(a.imap_host || '').toLowerCase())) d = def;
    if (!d) continue;
    const f = accountFields(d);
    await db.query(
      `UPDATE mail_accounts SET domain_id=$2, imap_host=$3, imap_port=$4, imap_security=$5, smtp_host=$6, smtp_port=$7,
              smtp_security=$8, allow_insecure_tls=$9 WHERE id = $1`,
      [a.id, d.id, f.imap_host, f.imap_port, f.imap_security, f.smtp_host, f.smtp_port, f.smtp_security, f.allow_insecure_tls]);
    const serverChanged = a.imap_host !== f.imap_host || a.imap_port !== f.imap_port || a.imap_security !== f.imap_security
      || a.smtp_host !== f.smtp_host || a.smtp_port !== f.smtp_port || a.smtp_security !== f.smtp_security;
    if (serverChanged) changed.push(a.id);
  }
  if (restart && changed.length) {
    const manager = require('./imap/manager');
    for (const id of changed) await manager.restart(id).catch(() => {});
  }
  const n = accounts.filter((a) => byName.get(domainOf(a.email)) || (def && hosts.has(String(a.imap_host || '').toLowerCase()))).length;
  if (n) console.log(`[domains] ${n} bestehende(s) Konto/Konten der Domain-Konfiguration zugeordnet`);
  return n;
}

/** Beim ersten Start: Standard-Domain aus AUTH_IMAP_* / AUTH_SMTP_* (.env) anlegen. */
async function migrateFromEnv() {
  const n = await db.one('SELECT count(*)::int AS n FROM mail_domains');
  if (n && n.n > 0) return null;
  if (!config.authImap.host) return null;
  const imapPort = config.authImap.port || 993;
  const smtpHost = config.authSmtp.host || config.authImap.host;
  const smtpPort = config.authSmtp.port || 587;
  const d = await db.one(
    `INSERT INTO mail_domains (domain, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security,
                               login_format, allow_insecure_tls, dav_url, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'email',$8,$9,$10) RETURNING *`,
    [DEFAULT, config.authImap.host, imapPort, effectiveSecurity('imap', imapPort, config.authImap.security),
      smtpHost, smtpPort, effectiveSecurity('smtp', smtpPort, config.authSmtp.security),
      !!config.authAllowInsecureTls, config.authDavUrl || '', 'Automatisch aus der .env übernommen']);
  console.log(`[domains] Standard-Domain aus .env angelegt (${d.imap_host}:${d.imap_port})`);
  return d;
}

// ------------------------------------------------------------------ App-Einstellungen

async function getSetting(key, fallback) {
  const r = await db.one('SELECT value FROM app_settings WHERE key = $1', [key]);
  return r ? r.value : fallback;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
}

/** Dürfen Benutzer zusätzlich Konten bei anderen (nicht eingerichteten) Mailservern anlegen? */
async function customServersAllowed() {
  const v = await getSetting('allowCustomServers', null);
  return v === true;
}

module.exports = {
  DEFAULT, domainOf, publicDomain, domainInput, list, findForEmail, loginFor, accountFields,
  applyToAccounts, assignExisting, migrateFromEnv, getSetting, setSetting, customServersAllowed,
};
