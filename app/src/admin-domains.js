'use strict';

/** Admin-API: Mailserver-Konfiguration pro Domain + globale Einstellungen. */
const net = require('net');
const tls = require('tls');
const express = require('express');
const db = require('./db');
const domains = require('./domains');
const { encrypt } = require('./crypto');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function adminOnly(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Nur für Administratoren' });
  next();
}

/**
 * Erreichbarkeit prüfen, ohne Anmeldung: Verbindung aufbauen und Begrüssung lesen
 * (IMAP "* OK …", SMTP "220 …"). Bei SSL/TLS-Ports direkt verschlüsselt.
 */
function probe({ host, port, security, allowInsecureTls, kind }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    let buf = '';
    const finish = (r) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve({ ...r, ms: Date.now() - started });
    };
    const opts = { host, port, timeout: 8000 };
    const sock = security === 'ssl'
      ? tls.connect({ ...opts, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !allowInsecureTls })
      : net.connect(opts);
    sock.setTimeout(8000);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (/\r?\n/.test(buf)) {
        const line = buf.split(/\r?\n/)[0].slice(0, 160);
        const good = kind === 'imap' ? /^\* (OK|PREAUTH)/i.test(line) : /^220[ -]/.test(line);
        finish(good ? { ok: true, greeting: line } : { ok: false, error: `Unerwartete Antwort: ${line}` });
      }
    });
    sock.on('timeout', () => finish({ ok: false, error: 'Zeitüberschreitung – Server antwortet nicht (Adresse/Port/Firewall prüfen)' }));
    sock.on('error', (err) => {
      let msg = err.message;
      if (err.code === 'ECONNREFUSED') msg = 'Verbindung abgelehnt – auf diesem Port läuft kein Dienst';
      else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') msg = 'Servername nicht gefunden (DNS)';
      else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') msg = 'Server nicht erreichbar (Netzwerk/Firewall)';
      else if (/certificate|self.signed|CERT_/i.test(err.message) || /CERT/.test(err.code || '')) msg = `Zertifikat nicht vertrauenswürdig (${err.code || err.message}) – ggf. „Ungültige Zertifikate akzeptieren“ aktivieren`;
      else if (/wrong version number|EPROTO|packet length/i.test(err.message)) msg = 'Kein SSL/TLS auf diesem Port – Verschlüsselung „STARTTLS“ oder „keine“ wählen';
      finish({ ok: false, error: msg });
    });
  });
}

function router() {
  const r = express.Router();

  r.get('/admin/domains', adminOnly, wrap(async (req, res) => {
    const rows = await domains.list();
    res.json({
      domains: rows.map((d) => domains.publicDomain(d, d.account_count)),
      allowCustomServers: await domains.customServersAllowed(),
      unassigned: (await db.one('SELECT count(*)::int AS n FROM mail_accounts WHERE domain_id IS NULL')).n,
    });
  }));

  r.post('/admin/domains', adminOnly, wrap(async (req, res) => {
    const v = domains.domainInput(req.body, null);
    const dup = await db.one('SELECT 1 FROM mail_domains WHERE domain = $1', [v.domain]);
    if (dup) throw httpError(409, `Die Domain ${v.domain} ist bereits eingerichtet`);
    const d = await db.one(
      `INSERT INTO mail_domains (domain, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security,
                                 login_format, allow_insecure_tls, dav_url, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [v.domain, v.imap_host, v.imap_port, v.imap_security, v.smtp_host, v.smtp_port, v.smtp_security,
        v.login_format, v.allow_insecure_tls, v.dav_url, v.note]);
    const assigned = await domains.assignExisting();
    res.json({ domain: domains.publicDomain(d), assigned });
  }));

  r.patch('/admin/domains/:id', adminOnly, wrap(async (req, res) => {
    const existing = await db.one('SELECT * FROM mail_domains WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
    if (!existing) throw httpError(404, 'Domain nicht gefunden');
    const v = domains.domainInput(req.body, existing);
    if (v.domain !== existing.domain) {
      const dup = await db.one('SELECT 1 FROM mail_domains WHERE domain = $1 AND id <> $2', [v.domain, existing.id]);
      if (dup) throw httpError(409, `Die Domain ${v.domain} ist bereits eingerichtet`);
    }
    const d = await db.one(
      `UPDATE mail_domains SET domain=$2, imap_host=$3, imap_port=$4, imap_security=$5, smtp_host=$6, smtp_port=$7,
              smtp_security=$8, login_format=$9, allow_insecure_tls=$10, dav_url=$11, note=$12, updated_at=now()
        WHERE id = $1 RETURNING *`,
      [existing.id, v.domain, v.imap_host, v.imap_port, v.imap_security, v.smtp_host, v.smtp_port, v.smtp_security,
        v.login_format, v.allow_insecure_tls, v.dav_url, v.note]);
    const updated = await domains.applyToAccounts(d.id);
    const assigned = await domains.assignExisting();
    res.json({ domain: domains.publicDomain(d), updated, assigned });
  }));

  r.delete('/admin/domains/:id', adminOnly, wrap(async (req, res) => {
    const d = await db.one('SELECT * FROM mail_domains WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
    if (!d) throw httpError(404, 'Domain nicht gefunden');
    const n = (await db.one('SELECT count(*)::int AS n FROM mail_accounts WHERE domain_id = $1', [d.id])).n;
    if (n && req.query.force !== '1') {
      throw httpError(409, `${n} Konto/Konten nutzen diese Domain. Beim Löschen behalten sie ihre Einstellungen, werden aber nicht mehr zentral verwaltet.`);
    }
    await db.query('DELETE FROM mail_domains WHERE id = $1', [d.id]);
    res.json({ ok: true, released: n });
  }));

  /** Bestehende Konten (neu) zuordnen */
  r.post('/admin/domains/assign', adminOnly, wrap(async (req, res) => {
    res.json({ assigned: await domains.assignExisting() });
  }));

  /**
   * Verbindung testen. Ohne Zugangsdaten: Erreichbarkeit + Begrüssung (IMAP und SMTP).
   * Mit Test-Adresse + Passwort: zusätzlich Anmeldung an IMAP und SMTP.
   */
  r.post('/admin/domains/test', adminOnly, wrap(async (req, res) => {
    const v = domains.domainInput({ domain: req.body.domain || '*', ...req.body }, null);
    const [imap, smtp] = await Promise.all([
      probe({ host: v.imap_host, port: v.imap_port, security: v.imap_security, allowInsecureTls: v.allow_insecure_tls, kind: 'imap' }),
      probe({ host: v.smtp_host, port: v.smtp_port, security: v.smtp_security, allowInsecureTls: v.allow_insecure_tls, kind: 'smtp' }),
    ]);
    const out = { imap, smtp };
    const email = String(req.body.testEmail || '').trim();
    const pass = String(req.body.testPassword || '');
    if (email && pass) {
      const { testImap } = require('./imap/worker');
      const compose = require('./mail/compose');
      const acc = {
        ...domains.accountFields(v), imap_user: domains.loginFor(v, email), imap_pass: encrypt(pass),
        smtp_user: '', smtp_pass: '', email,
      };
      const [li, ls] = await Promise.all([testImap(acc), compose.testSmtp(acc)]);
      out.login = { imap: li, smtp: ls };
    }
    res.json(out);
  }));

  r.get('/admin/settings', adminOnly, wrap(async (req, res) => {
    res.json({ allowCustomServers: await domains.customServersAllowed() });
  }));

  r.put('/admin/settings', adminOnly, wrap(async (req, res) => {
    if (req.body.allowCustomServers !== undefined) await domains.setSetting('allowCustomServers', !!req.body.allowCustomServers);
    res.json({ allowCustomServers: await domains.customServersAllowed() });
  }));

  return r;
}

module.exports = { router, probe };
