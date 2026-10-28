'use strict';

const express = require('express');
const db = require('../db');
const hub = require('../hub');
const manager = require('../imap/manager');
const { testImap } = require('../imap/worker');
const store = require('../imap/store');
const { encrypt } = require('../crypto');
const message = require('./message');
const compose = require('./compose');
const davService = require('../dav/service');
const ics = require('../dav/ics');
const scheduling = require('../dav/scheduling');
const domains = require('../domains');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const SECURITY = ['ssl', 'starttls', 'none'];

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/**
 * Konto für die Oberfläche. Verwaltete Konten (Server aus der Domain-Konfiguration) zeigen
 * Endbenutzern keine Serverdaten (Adresse, Port, Verschlüsselung) – nur Admins sehen sie.
 */
function publicAccount(a, isAdmin = false) {
  const managed = !!a.domain_id;
  const base = {
    id: a.id, name: a.name, email: a.email, color: a.color, enabled: a.enabled, sortOrder: a.sort_order,
    saveSent: a.save_sent, managed,
    status: a.status, lastError: a.last_error, lastSync: a.last_sync,
    quota: quotaOf(a),
  };
  if (managed && !isAdmin) return { ...base, lastError: a.last_error ? hideServer(a.last_error, a) : a.last_error };
  return {
    ...base,
    imapHost: a.imap_host, imapPort: a.imap_port, imapSecurity: a.imap_security, imapUser: a.imap_user,
    smtpHost: a.smtp_host, smtpPort: a.smtp_port, smtpSecurity: a.smtp_security, smtpUser: a.smtp_user,
    smtpSameCredentials: !a.smtp_user && !a.smtp_pass,
    allowInsecureTls: a.allow_insecure_tls,
  };
}

/** Speicherplatz des Postfachs (vom Mailserver per IMAP QUOTA, sonst geschätzt) */
function quotaOf(a) {
  if (a.quota_used === null || a.quota_used === undefined) return null;
  return {
    used: Number(a.quota_used), limit: a.quota_limit ? Number(a.quota_limit) : null,
    source: a.quota_source, checkedAt: a.quota_checked_at,
  };
}

/** Serveradresse/Port aus Fehlermeldungen für Endbenutzer entfernen. */
function hideServer(msg, a) {
  let m = String(msg);
  for (const h of [a.imap_host, a.smtp_host].filter(Boolean)) m = m.split(h).join('Mailserver');
  return m.replace(/(Mailserver):\d{2,5}/g, '$1').replace(/\b(Port|port) \d{2,5}\b/g, '$1');
}

function publicIdentity(i) {
  return {
    id: i.id, accountId: i.account_id, name: i.name, email: i.email, replyTo: i.reply_to, bcc: i.bcc,
    signature: i.signature, isDefault: i.is_default, sortOrder: i.sort_order,
  };
}

function publicFolder(f) {
  return {
    id: f.id, accountId: f.account_id, path: f.path, name: f.name, delimiter: f.delimiter, parentPath: f.parent_path,
    specialUse: f.special_use, selectable: f.selectable, subscribed: f.subscribed, total: f.total, unseen: f.unseen,
    localCount: f.local_count, lastSync: f.last_sync,
  };
}

async function ownAccount(id, userId) {
  const a = await db.one('SELECT * FROM mail_accounts WHERE id = $1 AND user_id = $2', [parseInt(id, 10) || 0, userId]);
  if (!a) throw httpError(404, 'Konto nicht gefunden');
  return a;
}

async function ownFolder(id, userId) {
  const f = await db.one(
    `SELECT f.* FROM folders f JOIN mail_accounts a ON a.id = f.account_id WHERE f.id = $1 AND a.user_id = $2`,
    [parseInt(id, 10) || 0, userId]);
  if (!f) throw httpError(404, 'Ordner nicht gefunden');
  return f;
}

/**
 * Normalisiert + validiert Kontodaten aus dem Formular.
 * Mit `domain`: verwaltetes Konto – Serverdaten kommen aus der Domain, Eingaben dazu werden ignoriert.
 */
function accountInput(b, existing, domain) {
  if (domain) {
    const email = String(b.email ?? existing?.email ?? '').trim();
    b = { ...b, ...camelServer(domains.accountFields(domain)),
      imapUser: existing?.imap_user || domains.loginFor(domain, email), smtpSameCredentials: true };
  }
  const v = {
    name: String(b.name ?? existing?.name ?? '').trim(),
    email: String(b.email ?? existing?.email ?? '').trim(),
    imap_host: String(b.imapHost ?? existing?.imap_host ?? '').trim(),
    imap_port: parseInt(b.imapPort ?? existing?.imap_port ?? 993, 10),
    imap_security: String(b.imapSecurity ?? existing?.imap_security ?? 'ssl'),
    imap_user: String(b.imapUser ?? existing?.imap_user ?? '').trim(),
    smtp_host: String(b.smtpHost ?? existing?.smtp_host ?? '').trim(),
    smtp_port: parseInt(b.smtpPort ?? existing?.smtp_port ?? 465, 10),
    smtp_security: String(b.smtpSecurity ?? existing?.smtp_security ?? 'ssl'),
    allow_insecure_tls: !!(b.allowInsecureTls ?? existing?.allow_insecure_tls ?? false),
    save_sent: !!(b.saveSent ?? existing?.save_sent ?? true),
    enabled: !!(b.enabled ?? existing?.enabled ?? true),
    color: String(b.color ?? existing?.color ?? '#3b6fd8'),
  };
  if (!v.email || !v.email.includes('@')) throw httpError(400, 'Bitte eine gültige E-Mail-Adresse angeben');
  if (!v.imap_host || !v.smtp_host) throw httpError(400, 'IMAP- und SMTP-Server sind Pflichtfelder');
  if (!SECURITY.includes(v.imap_security) || !SECURITY.includes(v.smtp_security)) throw httpError(400, 'Ungültige Verschlüsselung');
  if (!v.name) v.name = v.email;
  if (!v.imap_user) v.imap_user = v.email;
  // Passwörter: leer = unverändert
  v.imap_pass = b.imapPass ? encrypt(b.imapPass) : existing?.imap_pass;
  if (!v.imap_pass) throw httpError(400, 'Bitte das IMAP-Passwort angeben');
  if (b.smtpSameCredentials) {
    v.smtp_user = '';
    v.smtp_pass = '';
  } else {
    v.smtp_user = String(b.smtpUser ?? existing?.smtp_user ?? '').trim();
    v.smtp_pass = b.smtpPass ? encrypt(b.smtpPass) : (existing?.smtp_pass || '');
  }
  return v;
}

function camelServer(f) {
  return {
    imapHost: f.imap_host, imapPort: f.imap_port, imapSecurity: f.imap_security,
    smtpHost: f.smtp_host, smtpPort: f.smtp_port, smtpSecurity: f.smtp_security, allowInsecureTls: f.allow_insecure_tls,
  };
}

/**
 * Welche Domain-Konfiguration gilt für ein neues Konto?
 *  - ausdrücklich eingerichtete Domain → immer verwaltet
 *  - Standard "*" → verwaltet, ausser eigene Server sind erlaubt und es wurden Serverdaten angegeben
 *  - keine Domain → eigener Server nur, wenn erlaubt (oder Admin)
 */
async function domainForNewAccount(b, user) {
  const email = String(b.email || '').trim();
  const d = await domains.findForEmail(email);
  const custom = user.is_admin || (await domains.customServersAllowed());
  if (d && d.domain !== domains.DEFAULT) return d;
  if (d && !(custom && b.imapHost)) return d;
  if (!d && !custom) {
    throw httpError(400, `Für die Domain ${domains.domainOf(email) || '?'} ist kein Mailserver eingerichtet – bitte an den Administrator wenden.`);
  }
  return null;
}

async function domainOfAccount(a) {
  return a && a.domain_id ? db.one('SELECT * FROM mail_domains WHERE id = $1', [a.domain_id]) : null;
}

async function folderCounts(ids) {
  if (!ids.length) return [];
  const rows = await db.many('SELECT id, account_id, total, unseen FROM folders WHERE id = ANY($1::int[])', [ids]);
  return rows.map((r) => ({ id: r.id, accountId: r.account_id, total: r.total, unseen: r.unseen }));
}

function router() {
  const r = express.Router();

  // ================================================================== Konten

  /** Alles, was die Seitenleiste braucht: Konten + Ordner + Identitäten. */
  r.get('/accounts', wrap(async (req, res) => {
    const accounts = await db.many('SELECT * FROM mail_accounts WHERE user_id = $1 ORDER BY sort_order, id', [req.user.id]);
    const ids = accounts.map((a) => a.id);
    const folders = ids.length ? await db.many(
      `SELECT f.*, (SELECT count(*)::int FROM messages m WHERE m.folder_id = f.id) AS local_count
         FROM folders f WHERE f.account_id = ANY($1::int[]) ORDER BY f.path`, [ids]) : [];
    const identities = ids.length ? await db.many(
      'SELECT * FROM identities WHERE account_id = ANY($1::int[]) ORDER BY sort_order, id', [ids]) : [];
    res.json({
      customServers: req.user.is_admin || (await domains.customServersAllowed()),
      accounts: accounts.map((a) => ({
        ...publicAccount(a, req.user.is_admin),
        folders: folders.filter((f) => f.account_id === a.id).map(publicFolder),
        identities: identities.filter((i) => i.account_id === a.id).map(publicIdentity),
      })),
    });
  }));

  r.get('/folder-counts', wrap(async (req, res) => {
    const rows = await db.many(
      `SELECT f.id, f.account_id, f.total, f.unseen FROM folders f JOIN mail_accounts a ON a.id = f.account_id
        WHERE a.user_id = $1`, [req.user.id]);
    res.json({ folders: rows.map((r) => ({ id: r.id, accountId: r.account_id, total: r.total, unseen: r.unseen })) });
  }));

  r.post('/accounts/test', wrap(async (req, res) => {
    let existing = null;
    if (req.body.id) existing = await ownAccount(req.body.id, req.user.id);
    const d = existing ? await domainOfAccount(existing) : await domainForNewAccount(req.body, req.user);
    const acc = accountInput(req.body, existing, d);
    const [imap, smtp] = await Promise.all([testImap(acc), compose.testSmtp(acc)]);
    if (d && !req.user.is_admin) {
      for (const r2 of [imap, smtp]) if (r2.error) r2.error = hideServer(r2.error, acc);
    }
    res.json({ imap, smtp });
  }));

  r.post('/accounts', wrap(async (req, res) => {
    const d = await domainForNewAccount(req.body, req.user);
    const v = accountInput(req.body, null, d);
    if (!req.body.skipTest) {
      const imap = await testImap(v);
      if (!imap.ok) throw httpError(400, d && !req.user.is_admin ? `Anmeldung fehlgeschlagen: ${hideServer(imap.error, v)}` : `IMAP: ${imap.error}`);
    }
    const a = await db.tx(async (t) => {
      const ord = await t.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM mail_accounts WHERE user_id = $1', [req.user.id]);
      const ins = await t.query(
        `INSERT INTO mail_accounts (user_id, name, email, imap_host, imap_port, imap_security, imap_user, imap_pass,
                                    smtp_host, smtp_port, smtp_security, smtp_user, smtp_pass, allow_insecure_tls,
                                    save_sent, enabled, color, sort_order, domain_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [req.user.id, v.name, v.email, v.imap_host, v.imap_port, v.imap_security, v.imap_user, v.imap_pass,
          v.smtp_host, v.smtp_port, v.smtp_security, v.smtp_user, v.smtp_pass, v.allow_insecure_tls,
          v.save_sent, v.enabled, v.color, ord.rows[0].n, d ? d.id : null]);
      const acc = ins.rows[0];
      await t.query('INSERT INTO identities (account_id, name, email, is_default) VALUES ($1, $2, $3, true)',
        [acc.id, String(req.body.senderName || req.user.display_name || ''), v.email]);
      return acc;
    });
    if (a.enabled) manager.start(a);
    res.json({ account: publicAccount(a, req.user.is_admin) });
  }));

  r.patch('/accounts/:id', wrap(async (req, res) => {
    const existing = await ownAccount(req.params.id, req.user.id);
    // Nur Reihenfolge/Farbe? Dann kein Neustart nötig
    const keys = Object.keys(req.body);
    if (keys.every((k) => ['sortOrder', 'color', 'name'].includes(k))) {
      await db.query('UPDATE mail_accounts SET sort_order = coalesce($2, sort_order), color = coalesce($3, color), name = coalesce($4, name) WHERE id = $1',
        [existing.id, req.body.sortOrder ?? null, req.body.color ?? null, req.body.name ?? null]);
      return res.json({ ok: true });
    }
    // Verwaltete Konten: Server bleibt der aus der Domain-Konfiguration; die E-Mail-Adresse ist fest
    const d = await domainOfAccount(existing);
    const v = accountInput(d ? { ...req.body, email: existing.email } : req.body, existing, d);
    const a = await db.one(
      `UPDATE mail_accounts SET name=$2, email=$3, imap_host=$4, imap_port=$5, imap_security=$6, imap_user=$7, imap_pass=$8,
              smtp_host=$9, smtp_port=$10, smtp_security=$11, smtp_user=$12, smtp_pass=$13, allow_insecure_tls=$14,
              save_sent=$15, enabled=$16, color=$17, status='pending', last_error=NULL
        WHERE id = $1 RETURNING *`,
      [existing.id, v.name, v.email, v.imap_host, v.imap_port, v.imap_security, v.imap_user, v.imap_pass,
        v.smtp_host, v.smtp_port, v.smtp_security, v.smtp_user, v.smtp_pass, v.allow_insecure_tls,
        v.save_sent, v.enabled, v.color]);
    // Serverwechsel -> lokalen Cache verwerfen
    if (existing.imap_host !== a.imap_host || existing.imap_user !== a.imap_user) {
      await db.query('DELETE FROM folders WHERE account_id = $1', [a.id]);
    }
    await manager.restart(a.id);
    res.json({ account: publicAccount(a, req.user.is_admin) });
  }));

  r.delete('/accounts/:id', wrap(async (req, res) => {
    const a = await ownAccount(req.params.id, req.user.id);
    await manager.stop(a.id);
    await db.query('DELETE FROM mail_accounts WHERE id = $1', [a.id]);
    res.json({ ok: true });
  }));

  /** Speicherplatz sofort neu abfragen */
  r.post('/accounts/:id/quota', wrap(async (req, res) => {
    const a = await ownAccount(req.params.id, req.user.id);
    const w = manager.get(a.id);
    if (!w) throw httpError(409, 'Das Konto ist nicht verbunden');
    const q = await w.refreshQuota();
    res.json({ quota: q ? { ...q, checkedAt: new Date().toISOString() } : null });
  }));

  r.post('/accounts/:id/sync', wrap(async (req, res) => {
    const a = await ownAccount(req.params.id, req.user.id);
    if (a.status === 'error') await manager.restart(a.id);
    else manager.get(a.id).scheduleFullSync();
    res.json({ ok: true });
  }));

  // ================================================================== Identitäten

  async function ownIdentity(id, userId) {
    const i = await db.one(
      'SELECT i.* FROM identities i JOIN mail_accounts a ON a.id = i.account_id WHERE i.id = $1 AND a.user_id = $2',
      [parseInt(id, 10) || 0, userId]);
    if (!i) throw httpError(404, 'Identität nicht gefunden');
    return i;
  }

  function identityInput(b, existing) {
    const v = {
      name: String(b.name ?? existing?.name ?? ''),
      email: String(b.email ?? existing?.email ?? '').trim(),
      reply_to: String(b.replyTo ?? existing?.reply_to ?? '').trim(),
      bcc: String(b.bcc ?? existing?.bcc ?? '').trim(),
      signature: String(b.signature ?? existing?.signature ?? ''),
      is_default: !!(b.isDefault ?? existing?.is_default ?? false),
      sort_order: parseInt(b.sortOrder ?? existing?.sort_order ?? 0, 10) || 0,
    };
    if (!v.email.includes('@')) throw httpError(400, 'Bitte eine gültige Absenderadresse angeben');
    return v;
  }

  r.post('/accounts/:id/identities', wrap(async (req, res) => {
    const a = await ownAccount(req.params.id, req.user.id);
    const v = identityInput(req.body);
    const row = await db.tx(async (t) => {
      if (v.is_default) await t.query('UPDATE identities SET is_default = false WHERE account_id = $1', [a.id]);
      const ins = await t.query(
        `INSERT INTO identities (account_id, name, email, reply_to, bcc, signature, is_default, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [a.id, v.name, v.email, v.reply_to, v.bcc, v.signature, v.is_default, v.sort_order]);
      return ins.rows[0];
    });
    res.json({ identity: publicIdentity(row) });
  }));

  r.patch('/identities/:id', wrap(async (req, res) => {
    const existing = await ownIdentity(req.params.id, req.user.id);
    const v = identityInput(req.body, existing);
    const row = await db.tx(async (t) => {
      if (v.is_default) await t.query('UPDATE identities SET is_default = false WHERE account_id = $1', [existing.account_id]);
      const up = await t.query(
        `UPDATE identities SET name=$2, email=$3, reply_to=$4, bcc=$5, signature=$6, is_default=$7, sort_order=$8
          WHERE id = $1 RETURNING *`,
        [existing.id, v.name, v.email, v.reply_to, v.bcc, v.signature, v.is_default, v.sort_order]);
      return up.rows[0];
    });
    res.json({ identity: publicIdentity(row) });
  }));

  r.delete('/identities/:id', wrap(async (req, res) => {
    const existing = await ownIdentity(req.params.id, req.user.id);
    const n = await db.one('SELECT count(*)::int AS n FROM identities WHERE account_id = $1', [existing.account_id]);
    if (n.n <= 1) throw httpError(400, 'Jedes Konto braucht mindestens eine Identität');
    await db.query('DELETE FROM identities WHERE id = $1', [existing.id]);
    if (existing.is_default) {
      await db.query(
        'UPDATE identities SET is_default = true WHERE id = (SELECT id FROM identities WHERE account_id = $1 ORDER BY sort_order, id LIMIT 1)',
        [existing.account_id]);
    }
    res.json({ ok: true });
  }));

  // ================================================================== Ordner

  r.post('/accounts/:id/folders', wrap(async (req, res) => {
    const a = await ownAccount(req.params.id, req.user.id);
    const name = String(req.body.name || '').trim();
    if (!name) throw httpError(400, 'Name fehlt');
    let path = name;
    if (req.body.parentId) {
      const parent = await ownFolder(req.body.parentId, req.user.id);
      if (parent.account_id !== a.id) throw httpError(400, 'Übergeordneter Ordner gehört zu anderem Konto');
      path = `${parent.path}${parent.delimiter || '/'}${name}`;
    }
    await manager.get(a.id).createFolder(path);
    res.json({ ok: true, path });
  }));

  r.patch('/folders/:id', wrap(async (req, res) => {
    const f = await ownFolder(req.params.id, req.user.id);
    const name = String(req.body.name || '').trim();
    if (!name) throw httpError(400, 'Name fehlt');
    const newPath = f.parent_path ? `${f.parent_path}${f.delimiter || '/'}${name}` : name;
    await manager.get(f.account_id).renameFolder(f.path, newPath);
    res.json({ ok: true });
  }));

  r.delete('/folders/:id', wrap(async (req, res) => {
    const f = await ownFolder(req.params.id, req.user.id);
    if (f.special_use) throw httpError(400, 'Systemordner können nicht gelöscht werden');
    await manager.get(f.account_id).deleteFolder(f.path);
    res.json({ ok: true });
  }));

  r.post('/folders/:id/sync', wrap(async (req, res) => {
    const f = await ownFolder(req.params.id, req.user.id);
    manager.get(f.account_id).scheduleFolderSync(f.path);
    res.json({ ok: true });
  }));

  r.post('/folders/:id/load-older', wrap(async (req, res) => {
    const f = await ownFolder(req.params.id, req.user.id);
    const n = await manager.get(f.account_id).loadOlder(f.path, 500);
    res.json({ loaded: n || 0 });
  }));

  r.post('/folders/:id/read-all', wrap(async (req, res) => {
    const f = await ownFolder(req.params.id, req.user.id);
    const w = manager.get(f.account_id);
    await w.withMailbox(f.path, (c) => c.messageFlagsAdd('1:*', ['\\Seen'], { uid: true }));
    await db.query(`UPDATE messages SET flags = array_append(flags, '\\Seen') WHERE folder_id = $1 AND NOT ('\\Seen' = ANY(flags))`, [f.id]);
    await db.query('UPDATE folders SET unseen = 0 WHERE id = $1', [f.id]);
    hub.send(req.user.id, { t: 'folder', accountId: f.account_id, folderId: f.id, total: f.total, unseen: 0, changed: true, newMessages: [] });
    res.json({ ok: true, folders: await folderCounts([f.id]) });
  }));

  r.post('/folders/:id/empty', wrap(async (req, res) => {
    const f = await ownFolder(req.params.id, req.user.id);
    if (!['\\Trash', '\\Junk'].includes(f.special_use)) throw httpError(400, 'Nur Papierkorb und Spam können geleert werden');
    const w = manager.get(f.account_id);
    await w.withMailbox(f.path, async (c) => {
      if (c.mailbox.exists) await c.messageDelete('1:*', { uid: true });
    });
    await db.query('DELETE FROM messages WHERE folder_id = $1', [f.id]);
    w.scheduleFolderSync(f.path, 200);
    w.refreshQuota().catch(() => {}); // Speicherplatz gleich wieder anzeigen
    res.json({ ok: true });
  }));

  // ================================================================== Thread-Liste

  r.get('/folders/:id/threads', wrap(async (req, res) => {
    const f = await ownFolder(req.params.id, req.user.id);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const q = String(req.query.q || '').trim();
    const unreadOnly = req.query.unread === '1';
    const flaggedOnly = req.query.flagged === '1';
    const includeAll = ['\\Trash', '\\Junk'].includes(f.special_use);

    const params = [f.id, limit + 1, offset, f.account_id, includeAll];
    let filter = '';
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
      filter += ` AND (subject ILIKE $${params.length} OR from_name ILIKE $${params.length} OR from_addr ILIKE $${params.length}
                      OR to_list::text ILIKE $${params.length} OR coalesce(preview,'') ILIKE $${params.length})`;
    }
    if (unreadOnly) filter += " AND NOT ('\\Seen' = ANY(flags))";
    if (flaggedOnly) filter += " AND ('\\Flagged' = ANY(flags))";

    const rows = await db.many(
      `WITH page AS (
         SELECT thread_id, max(date) AS last_date,
                bool_or(NOT ('\\Seen' = ANY(flags))) AS unread,
                bool_or('\\Flagged' = ANY(flags)) AS flagged,
                bool_or('\\Answered' = ANY(flags)) AS answered,
                array_agg(id ORDER BY date) AS ids
           FROM messages WHERE folder_id = $1 ${filter}
          GROUP BY thread_id
          ORDER BY max(date) DESC NULLS LAST
          LIMIT $2 OFFSET $3)
       SELECT p.thread_id, p.last_date, p.unread, p.flagged, p.answered, p.ids,
              agg.count, agg.has_attachments, agg.participants,
              latest.subject, latest.preview, latest.from_name, latest.from_addr
         FROM page p
         CROSS JOIN LATERAL (
           SELECT count(DISTINCT coalesce(m.message_id, m.id::text))::int AS count,
                  bool_or(m.has_attachments) AS has_attachments,
                  (array_agg(DISTINCT coalesce(nullif(m.from_name, ''), m.from_addr)))[1:4] AS participants
             FROM messages m JOIN folders fo ON fo.id = m.folder_id
            WHERE m.account_id = $4 AND m.thread_id = p.thread_id
              AND (fo.id = $1 OR $5 OR coalesce(fo.special_use, '') NOT IN ('\\Trash', '\\Junk'))
         ) agg
         CROSS JOIN LATERAL (
           SELECT subject, preview, from_name, from_addr FROM messages m
            WHERE m.folder_id = $1 AND m.thread_id = p.thread_id
            ORDER BY date DESC NULLS LAST LIMIT 1
         ) latest
        ORDER BY p.last_date DESC NULLS LAST`, params);

    const hasMore = rows.length > limit;
    res.json({
      folder: publicFolder({ ...f, local_count: null }),
      hasMore,
      canLoadOlder: f.min_synced_uid != null && f.min_synced_uid > 1 && offset + rows.length >= 0,
      threads: rows.slice(0, limit).map((t) => ({
        threadId: t.thread_id,
        date: t.last_date,
        unread: t.unread,
        flagged: t.flagged,
        answered: t.answered,
        messageIds: t.ids,
        count: t.count,
        hasAttachments: t.has_attachments,
        participants: t.participants || [],
        subject: t.subject,
        preview: t.preview,
        fromName: t.from_name,
        fromAddr: t.from_addr,
      })),
    });
  }));

  // ================================================================== Thread-Ansicht

  r.get('/threads/:threadId', wrap(async (req, res) => {
    const threadId = parseInt(req.params.threadId, 10);
    const folderId = parseInt(req.query.folder, 10) || 0;
    const all = await db.many(
      `SELECT m.*, f.path AS folder_path, f.name AS folder_name, f.special_use AS folder_special
         FROM messages m
         JOIN folders f ON f.id = m.folder_id
         JOIN mail_accounts a ON a.id = m.account_id
        WHERE m.thread_id = $1 AND a.user_id = $2
          AND (f.id = $3 OR coalesce(f.special_use, '') NOT IN ('\\Trash', '\\Junk')
               OR EXISTS (SELECT 1 FROM folders x WHERE x.id = $3 AND x.special_use IN ('\\Trash', '\\Junk')))
        ORDER BY (f.id = $3) DESC, (f.special_use = '\\All') ASC, m.id`,
      [threadId, req.user.id, folderId]);
    // Alle Exemplare im aktuellen Ordner anzeigen (auch doppelte – sonst bleiben unsichtbare Leichen).
    // Aus anderen Ordnern nur Nachrichten, die hier noch nicht vorkommen – je eine pro Message-ID.
    const key = (m) => m.message_id || `id:${m.id}`;
    const seenKeys = new Set();
    const rows = [];
    const dupCount = new Map();
    for (const m of all) {
      const k = key(m);
      if (m.folder_id === folderId) {
        dupCount.set(k, (dupCount.get(k) || 0) + 1);
        m.duplicate = dupCount.get(k) > 1;
        seenKeys.add(k);
        rows.push(m);
      } else if (!seenKeys.has(k)) {
        seenKeys.add(k);
        rows.push(m);
      }
    }
    rows.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    res.json({
      threadId,
      subject: rows.length ? rows[rows.length - 1].subject : '',
      messages: rows.map((m) => ({
        id: m.id, accountId: m.account_id, folderId: m.folder_id, folderName: m.folder_name, folderSpecial: m.folder_special,
        uid: m.uid, messageId: m.message_id, subject: m.subject, fromName: m.from_name, fromAddr: m.from_addr,
        to: m.to_list, cc: m.cc_list, date: m.date, flags: m.flags, hasAttachments: m.has_attachments,
        preview: m.preview, size: m.size, duplicate: !!m.duplicate,
      })),
    });
  }));

  // ================================================================== Einzelne Nachricht

  r.get('/messages/:id/body', wrap(async (req, res) => {
    const msg = await message.getOwned(parseInt(req.params.id, 10), req.user.id);
    const parsed = await message.loadParsed(msg);
    const payload = message.bodyPayload(msg, parsed);
    if (req.query.markSeen !== '0') {
      // Diese Nachricht und ungelesene Kopien (gleiche Message-ID) als gelesen markieren
      const targets = (msg.flags.includes('\\Seen') ? [] : [{ uid: msg.uid, folder_id: msg.folder_id, path: msg.folder_path }])
        .concat((await copiesOf([{ id: msg.id, account_id: msg.account_id, message_id: msg.message_id }]))
          .filter((c) => !(c.flags || []).includes('\\Seen')));
      if (targets.length) {
        const byFolder = new Map();
        for (const t of targets) {
          if (!byFolder.has(t.folder_id)) byFolder.set(t.folder_id, { path: t.path, uids: [] });
          byFolder.get(t.folder_id).uids.push(Number(t.uid));
        }
        for (const [folderId, g] of byFolder) {
          await store.changeFlagsLocal(folderId, g.uids, ['\\Seen'], true);
          manager.get(msg.account_id).setFlags(g.path, g.uids, ['\\Seen'], true).catch(() => {});
        }
        payload.folders = await folderCounts([...byFolder.keys()]);
        for (const f of payload.folders) {
          hub.send(req.user.id, { t: 'folder', accountId: f.accountId, folderId: f.id, total: f.total, unseen: f.unseen, changed: false, newMessages: [] });
        }
      }
    }
    res.json(payload);
  }));

  r.get('/messages/:id/attachments/:idx', wrap(async (req, res) => {
    const msg = await message.getOwned(parseInt(req.params.id, 10), req.user.id);
    const parsed = await message.loadParsed(msg);
    const a = (parsed.attachments || [])[parseInt(req.params.idx, 10)];
    if (!a) throw httpError(404, 'Anhang nicht gefunden');
    const filename = a.filename || `anhang-${req.params.idx}`;
    const inline = req.query.inline === '1' && /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/i.test(a.contentType);
    res.setHeader('Content-Type', inline ? a.contentType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.end(a.content);
  }));

  r.get('/messages/:id/source', wrap(async (req, res) => {
    const msg = await message.getOwned(parseInt(req.params.id, 10), req.user.id);
    const parsed = await message.loadParsed(msg);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="nachricht-${msg.id}.eml"`);
    res.end(parsed.__source);
  }));

  /** Kalendereinladung aus einer Mail in einen Kalender übernehmen. */
  r.post('/messages/:id/import-ics', wrap(async (req, res) => {
    const msg = await message.getOwned(parseInt(req.params.id, 10), req.user.id);
    const parsed = await message.loadParsed(msg);
    const a = (parsed.attachments || [])[parseInt(req.body.attachmentIdx, 10)];
    if (!a) throw httpError(404, 'Anhang nicht gefunden');
    const { uid, data, summary } = ics.prepareImport(a.content.toString('utf8'));
    let cal = req.body.calendar;
    let source;
    if (req.body.sourceId) {
      source = await davService.getSource(req.user, req.body.sourceId);
    } else {
      const all = await davService.allCollections(req.user);
      const first = all.collections.find((c) => c.type === 'calendar');
      if (!first) throw httpError(400, 'Kein Kalender vorhanden – bitte unter Einstellungen einen CalDAV-Server hinzufügen');
      source = await davService.getSource(req.user, first.sourceId);
      cal = first.url;
    }
    if (!cal) {
      const cols = await davService.collections(req.user, source);
      const first = cols.find((c) => c.type === 'calendar');
      if (!first) throw httpError(400, 'Kein Kalender vorhanden');
      cal = first.url;
    }
    cal = source.client.assertOwnUrl(cal);
    if (!cal.endsWith('/')) cal += '/';
    const url = `${cal}${encodeURIComponent(uid)}.ics`;
    try {
      await source.client.putObject(url, data, 'text/calendar');
    } catch (err) {
      if (err.status !== 412) throw err;
      const cur = await source.client.getObject(url);
      await source.client.putObject(url, data, 'text/calendar', cur.etag || undefined);
    }
    res.json({ ok: true, summary });
  }));

  // ================================================================== Einladungen (iMIP)

  async function invitationOf(req) {
    const msg = await message.getOwned(parseInt(req.params.id, 10), req.user.id);
    const parsed = await message.loadParsed(msg);
    const list = (parsed.attachments || []).map((a, idx) => ({ a, idx }))
      .filter(({ a }) => /^text\/calendar/i.test(a.contentType || '') || /\.ics$/i.test(a.filename || ''));
    // Teil mit METHOD bevorzugen
    const pick = list.find(({ a }) => /METHOD:/i.test(a.content.toString('utf8'))) || list[0];
    if (!pick) throw httpError(404, 'Diese Nachricht enthält keine Einladung');
    const data = pick.a.content.toString('utf8');
    let inv;
    try { inv = ics.parseInvitation(data, await scheduling.myEmails(req.user)); } catch (err) { throw httpError(400, `Einladung nicht lesbar: ${err.message}`); }
    return { msg, data, inv, idx: pick.idx };
  }

  /** Einladung lesen + Stand im eigenen Kalender */
  r.get('/messages/:id/invitation', wrap(async (req, res) => {
    const { inv, idx, data } = await invitationOf(req);
    let stored = null;
    try {
      const hit = await scheduling.findEvent(req.user, inv.uid);
      if (hit) {
        const mineInv = ics.parseInvitation(hit.data, await scheduling.myEmails(req.user));
        stored = {
          sourceId: hit.source.id, calendar: hit.calendar.url, calendarName: hit.calendar.name, url: hit.url,
          myStatus: mineInv.myStatus, sequence: mineInv.sequence, attendees: mineInv.attendees,
          organizer: mineInv.organizer,
        };
        // REPLY: ist die Antwort schon übernommen?
        if (inv.method === 'REPLY') {
          stored.replyApplied = !ics.applyReply(hit.data, data);
        }
      }
    } catch (_) { /* kein Kalender erreichbar */ }
    res.json({ ...inv, attachmentIdx: idx, stored, ruleText: scheduling.describeRule(inv.rrule) });
  }));

  /**
   * Auf Einladung antworten. body: { partstat, sourceId, calendar, notify (Standard: ja), comment, tz }
   * Zusagen/Vorbehalt: Termin wird im Kalender eingetragen bzw. aktualisiert. Absagen: Termin wird entfernt.
   */
  r.post('/messages/:id/invitation/respond', wrap(async (req, res) => {
    const partstat = String(req.body.partstat || '').toUpperCase();
    if (!['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(partstat)) throw httpError(400, 'Ungültige Antwort');
    const { inv, data } = await invitationOf(req);
    if (inv.method !== 'REQUEST') throw httpError(400, 'Auf diese Nachricht kann nicht geantwortet werden');
    if (!inv.me) throw httpError(400, 'Du stehst nicht auf der Teilnehmerliste dieser Einladung');
    const existing = await scheduling.findEvent(req.user, inv.uid);
    let mineData = ics.setMyPartstat(data, inv.me, partstat);
    if (existing && inv.recurrenceId) {
      // Einladung nur für ein Vorkommen: in die vorhandene Serie einfügen
      mineData = mergeOccurrence(existing.data, mineData);
    }
    let calendarName = null;
    if (partstat === 'DECLINED') {
      if (existing && !inv.recurrenceId) await existing.source.client.deleteObject(existing.url, existing.etag || undefined);
      else if (existing) await existing.source.client.putObject(existing.url, mineData, 'text/calendar', existing.etag || undefined);
    } else if (existing) {
      await existing.source.client.putObject(existing.url, mineData, 'text/calendar', existing.etag || undefined);
      calendarName = existing.calendar.name;
    } else {
      const { source, cal, name } = await targetCalendar(req);
      await source.client.putObject(`${cal}${encodeURIComponent(inv.uid)}.ics`, mineData, 'text/calendar');
      calendarName = name;
    }
    let notified = null;
    if (req.body.notify !== false) {
      try {
        notified = await scheduling.sendReply(req.user, data, partstat, { recurrenceId: inv.recurrenceId, tz: req.body.tz, comment: req.body.comment });
      } catch (err) { notified = { error: err.message }; }
    }
    res.json({ ok: true, partstat, calendarName, notified });
  }));

  /** Antwort eines Teilnehmers (REPLY) in den eigenen Termin übernehmen */
  r.post('/messages/:id/invitation/apply', wrap(async (req, res) => {
    const { inv, data } = await invitationOf(req);
    if (inv.method !== 'REPLY') throw httpError(400, 'Keine Antwort auf eine Einladung');
    const existing = await scheduling.findEvent(req.user, inv.uid);
    if (!existing) return res.json({ ok: false, reason: 'Der Termin ist in deinen Kalendern nicht (mehr) vorhanden' });
    const upd = ics.applyReply(existing.data, data);
    if (!upd) return res.json({ ok: true, changed: [] });
    await existing.source.client.putObject(existing.url, upd.data, 'text/calendar', existing.etag || undefined);
    res.json({ ok: true, changed: upd.changed });
  }));

  /** Absage (CANCEL): Termin bzw. Vorkommen aus dem Kalender entfernen */
  r.post('/messages/:id/invitation/remove', wrap(async (req, res) => {
    const { inv } = await invitationOf(req);
    const existing = await scheduling.findEvent(req.user, inv.uid);
    if (!existing) return res.json({ ok: true, removed: false });
    if (inv.recurrenceId) {
      try {
        const upd = ics.deleteOccurrence(existing.data, inv.recurrenceId);
        await existing.source.client.putObject(existing.url, upd.data, 'text/calendar', existing.etag || undefined);
        return res.json({ ok: true, removed: true, occurrence: true });
      } catch (_) { /* kein Serientermin: ganz löschen */ }
    }
    await existing.source.client.deleteObject(existing.url, existing.etag || undefined);
    res.json({ ok: true, removed: true });
  }));

  async function targetCalendar(req) {
    let source;
    let cal = req.body.calendar;
    if (req.body.sourceId) source = await davService.getSource(req.user, req.body.sourceId);
    else {
      const all = await davService.allCollections(req.user);
      const first = all.collections.find((c) => c.type === 'calendar');
      if (!first) throw httpError(400, 'Kein Kalender vorhanden – bitte unter Einstellungen einen CalDAV-Server hinzufügen');
      source = await davService.getSource(req.user, first.sourceId);
      cal = first.url;
    }
    const cols = await davService.collections(req.user, source);
    const c = cal ? cols.find((x) => x.url === cal) : cols.find((x) => x.type === 'calendar');
    if (!c && !cal) throw httpError(400, 'Kein Kalender vorhanden');
    let url = source.client.assertOwnUrl(cal || c.url);
    if (!url.endsWith('/')) url += '/';
    return { source, cal: url, name: c ? c.name : '' };
  }

  /** Ausnahme (RECURRENCE-ID) aus einer Einladung in die gespeicherte Serie übernehmen */
  function mergeOccurrence(seriesData, occData) {
    return ics.mergeOccurrence(seriesData, occData);
  }

  // ================================================================== Aktionen

  /**
   * body: { ids: [...], action: seen|unseen|flag|unflag|delete|archive|spam|move|copy, target: folderId }
   */
  /**
   * Weitere Exemplare derselben Nachricht (gleiche Message-ID, gleiches Konto) – z. B. doppelt
   * zugestellte Mails oder Kopien in anderen Ordnern. Die Konversations-Ansicht zeigt nur eines davon;
   * gelesen/ungelesen soll trotzdem für alle gelten.
   */
  async function copiesOf(rows) {
    const known = rows.map((m) => Number(m.id));
    const pairs = rows.filter((m) => m.message_id);
    if (!pairs.length) return [];
    return db.many(
      `SELECT m.id, m.uid, m.flags, m.account_id, m.folder_id, m.message_id, f.path, f.special_use
         FROM messages m JOIN folders f ON f.id = m.folder_id
        WHERE m.account_id = ANY($1::int[]) AND m.message_id = ANY($2::text[]) AND m.id <> ALL($3::bigint[])`,
      [[...new Set(pairs.map((m) => m.account_id))], [...new Set(pairs.map((m) => m.message_id))], known]);
  }

  r.post('/messages/actions', wrap(async (req, res) => {
    const ids = (req.body.ids || []).map((x) => parseInt(x, 10)).filter(Boolean);
    const action = String(req.body.action || '');
    if (!ids.length) return res.json({ ok: true });
    let rows = await db.many(
      `SELECT m.id, m.uid, m.flags, m.account_id, m.folder_id, m.message_id, f.path, f.special_use
         FROM messages m JOIN folders f ON f.id = m.folder_id JOIN mail_accounts a ON a.id = m.account_id
        WHERE m.id = ANY($1::bigint[]) AND a.user_id = $2`, [ids, req.user.id]);
    if (action === 'seen' || action === 'unseen') rows = rows.concat(await copiesOf(rows));

    let target = null;
    if (['move', 'copy'].includes(action)) target = await ownFolder(req.body.target, req.user.id);

    // Nach Ordner gruppieren
    const groups = new Map();
    for (const m of rows) {
      if (!groups.has(m.folder_id)) groups.set(m.folder_id, { accountId: m.account_id, folderId: m.folder_id, path: m.path, special: m.special_use, uids: [] });
      groups.get(m.folder_id).uids.push(Number(m.uid));
    }

    const flagMap = {
      seen: ['\\Seen', true], unseen: ['\\Seen', false], flag: ['\\Flagged', true], unflag: ['\\Flagged', false],
    };
    const touched = new Set();
    const touchedFolders = new Set();
    for (const g of groups.values()) {
      touchedFolders.add(g.folderId);
      const w = manager.get(g.accountId);
      touched.add(g.accountId);
      if (flagMap[action]) {
        const [flag, add] = flagMap[action];
        await store.changeFlagsLocal(g.folderId, g.uids, [flag], add);
        await w.setFlags(g.path, g.uids, [flag], add);
        continue;
      }
      let dest = null;
      if (action === 'delete') {
        if (g.special === '\\Trash') {
          await w.expunge(g.path, g.uids);
        } else {
          dest = await compose.findSpecialFolder(g.accountId, '\\Trash');
          if (!dest) await w.expunge(g.path, g.uids);
        }
      } else if (action === 'archive') {
        dest = await compose.findSpecialFolder(g.accountId, '\\Archive');
        if (!dest) throw httpError(400, 'Kein Archiv-Ordner vorhanden – bitte einen Ordner "Archiv" anlegen');
      } else if (action === 'spam') {
        dest = await compose.findSpecialFolder(g.accountId, '\\Junk');
        if (!dest) throw httpError(400, 'Kein Spam-Ordner vorhanden');
      } else if (action === 'notspam') {
        dest = await compose.findSpecialFolder(g.accountId, '\\Inbox');
      } else if (action === 'move' || action === 'copy') {
        dest = target;
      } else {
        throw httpError(400, 'Unbekannte Aktion');
      }
      if (dest && dest.id === g.folderId) continue;
      if (dest) {
        if (dest.account_id === g.accountId) {
          if (action === 'copy') await w.copy(g.path, g.uids, dest.path);
          else await w.move(g.path, g.uids, dest.path);
        } else {
          // Kontoübergreifend: Quelltext holen, im Ziel anhängen, Original entfernen
          const tw = manager.get(dest.account_id);
          for (const uid of g.uids) {
            const src = await w.fetchSource(g.path, uid);
            const flags = (rows.find((m) => m.folder_id === g.folderId && Number(m.uid) === uid) || {}).flags || [];
            await tw.append(dest.path, src, flags.filter((x) => x !== '\\Recent'));
          }
          if (action !== 'copy') await w.expunge(g.path, g.uids);
          touched.add(dest.account_id);
        }
      }
      if (action !== 'copy') {
        const cnt = await db.one(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT ('\\Seen' = ANY(flags)))::int AS unseen
             FROM messages WHERE folder_id = $1 AND uid = ANY($2::bigint[])`, [g.folderId, g.uids]);
        await db.query('DELETE FROM messages WHERE folder_id = $1 AND uid = ANY($2::bigint[])', [g.folderId, g.uids]);
        await db.query('UPDATE folders SET unseen = GREATEST(0, unseen - $2), total = GREATEST(0, total - $3) WHERE id = $1',
          [g.folderId, cnt.unseen, cnt.total]);
        if (dest) {
          await db.query('UPDATE folders SET unseen = unseen + $2, total = total + $3 WHERE id = $1', [dest.id, cnt.unseen, cnt.total]);
          touchedFolders.add(dest.id);
        }
      }
    }
    // Zähler an Clients (Push) und direkt in der Antwort (falls die Live-Verbindung fehlt)
    const counts = await folderCounts([...touchedFolders]);
    for (const f of counts) {
      hub.send(req.user.id, { t: 'folder', accountId: f.accountId, folderId: f.id, total: f.total, unseen: f.unseen, changed: true, newMessages: [] });
    }
    res.json({ ok: true, folders: counts });
  }));

  // ================================================================== Verfassen

  r.post('/send', wrap(async (req, res) => {
    res.json(await compose.send(req.body, req.user));
  }));

  r.post('/drafts', wrap(async (req, res) => {
    res.json(await compose.saveDraft(req.body, req.user));
  }));

  r.delete('/drafts', wrap(async (req, res) => {
    const ident = await db.one(
      'SELECT a.id FROM identities i JOIN mail_accounts a ON a.id = i.account_id WHERE i.id = $1 AND a.user_id = $2',
      [parseInt(req.query.identityId, 10) || 0, req.user.id]);
    if (ident && req.query.draftMessageId) await compose.removeDraft(ident.id, String(req.query.draftMessageId));
    res.json({ ok: true });
  }));

  /** Adress-Autovervollständigung: Kontakte (CardDAV) + bekannte Korrespondenten. */
  r.get('/addresses', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 1) return res.json({ results: [] });
    const results = [];
    const seen = new Set();
    try {
      const contacts = await davService.allContacts(req.user);
      for (const c of contacts) {
        for (const e of c.emails) {
          const hay = `${c.fn} ${e.value} ${c.org}`.toLowerCase();
          if (!hay.includes(q)) continue;
          const key = e.value.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ name: c.fn, address: e.value, contact: true });
        }
      }
    } catch (_) { /* DAV optional */ }
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const rows = await db.many(
      `SELECT name, addr, count(*) AS n FROM (
         SELECT m.from_name AS name, m.from_addr AS addr FROM messages m JOIN mail_accounts a ON a.id = m.account_id
          WHERE a.user_id = $1 AND (m.from_addr ILIKE $2 OR m.from_name ILIKE $2)
         UNION ALL
         SELECT x->>'name', x->>'address' FROM messages m
           JOIN folders f ON f.id = m.folder_id JOIN mail_accounts a ON a.id = m.account_id
           CROSS JOIN LATERAL jsonb_array_elements(m.to_list || m.cc_list) x
          WHERE a.user_id = $1 AND f.special_use = '\\Sent' AND ((x->>'address') ILIKE $2 OR (x->>'name') ILIKE $2)
       ) s WHERE addr <> '' GROUP BY name, addr ORDER BY n DESC LIMIT 30`, [req.user.id, like]);
    for (const r2 of rows) {
      const key = r2.addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ name: r2.name || '', address: r2.addr });
    }
    res.json({ results: results.slice(0, 12) });
  }));

  return r;
}

module.exports = { router };
