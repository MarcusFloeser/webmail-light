'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const config = require('./config');
const { hashPassword, verifyPassword, randomToken } = require('./crypto');
const { authenticate } = require('./imap-auth');
const password = require('./password');
const guard = require('./loginguard');

const COOKIE = 'wm_sid';
const BACKGROUND_MAX = 4 * 1048576; // Hintergrundbild: max. 4 MB
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * maxAgeSec: Zahl → dauerhaftes Cookie, null → Sitzungs-Cookie (endet mit dem Browser).
 */
function setSessionCookie(res, sid, maxAgeSec) {
  const parts = [
    `${COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (maxAgeSec !== null && maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.display_name, isAdmin: u.is_admin, settings: u.settings || {},
    authSource: u.auth_source || 'local',
  };
}

/** Gültigkeit einer Sitzung in Sekunden: „angemeldet bleiben" vs. nur diese Browser-Sitzung. */
function sessionLifetimeSec(persistent) {
  return persistent ? config.sessionDays * 86400 : config.sessionIdleHours * 3600;
}

/**
 * Sitzung aus dem Cookie lesen. Ablauf ist gleitend: bei Aktivität wird die Sitzung verlängert
 * (höchstens alle paar Minuten ein Schreibzugriff). Mit `res` wird bei dauerhaften Sitzungen
 * auch das Cookie erneuert, damit es bei regelmässiger Nutzung nie abläuft.
 */
async function userFromRequest(req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (!sid || sid.length !== 64) return null;
  const row = await db.one(
    `SELECT u.*, s.expires_at AS s_expires, s.persistent AS s_persistent
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`, [sid]);
  if (!row) return null;
  const lifetime = sessionLifetimeSec(row.s_persistent);
  const remaining = new Date(row.s_expires).getTime() - Date.now();
  // dauerhaft: höchstens 1× pro Tag verlängern, sonst höchstens alle 5 Minuten
  const slack = row.s_persistent ? 86400000 : 300000;
  if (remaining < lifetime * 1000 - slack) {
    db.query(`UPDATE sessions SET expires_at = now() + ($2 || ' seconds')::interval WHERE id = $1`,
      [sid, String(lifetime)]).catch(() => {});
    if (res && row.s_persistent && !res.headersSent) setSessionCookie(res, sid, lifetime);
  }
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60000) {
    db.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [row.id]).catch(() => {});
  }
  row.sid = sid;
  return row;
}

// Einfaches Brute-Force-Limit pro IP + Benutzername

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

async function requireAuth(req, res, next) {
  try {
    const user = await userFromRequest(req, res);
    if (!user) return res.status(401).json({ error: 'Nicht angemeldet' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Nur für Administratoren' });
  next();
}

/** CSRF-Schutz: schreibende API-Aufrufe brauchen einen eigenen Header. */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'webmail') {
    return res.status(403).json({ error: 'CSRF-Prüfung fehlgeschlagen' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Basic-Auth für DAV-Clients (Thunderbird, DAVx5, iOS ...), mit kurzem Cache
// ---------------------------------------------------------------------------

const basicCache = new Map(); // sha256(user:pass) -> { user, until }

async function verifyBasic(header, ip = '') {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const username = decoded.slice(0, i).trim().toLowerCase();
  const password = decoded.slice(i + 1);
  const key = crypto.createHash('sha256').update(username + '\0' + password).digest('hex');
  const cached = basicCache.get(key);
  if (cached && cached.until > Date.now()) return cached.user;
  if (await guard.check(ip, username)) return null;
  const user = await authenticate(username, password);
  if (!user) {
    await guard.fail(ip, username, 'dav');
    return null;
  }
  basicCache.set(key, { user, until: Date.now() + 5 * 60000 });
  return user;
}

function clearBasicCacheFor(username) {
  for (const [k, v] of basicCache) if (v.user.username === username) basicCache.delete(k);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function ensureAdmin() {
  const count = await db.one('SELECT count(*)::int AS n FROM users');
  if (count.n > 0) return;
  if (config.authMode === 'imap' && !config.adminPassword) {
    console.log(`[auth] IMAP-Anmeldung aktiv (Mailserver je Domain, siehe Benutzer → Domains). Administratoren: ${config.authAdmins.join(', ') || '(keine – AUTH_ADMINS setzen)'}`);
    return;
  }
  let pw = config.adminPassword;
  let generated = false;
  if (!pw) { pw = randomToken(9); generated = true; }
  await db.query(
    'INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ($1, $2, $3, true)',
    [config.adminUsername, await hashPassword(pw), 'Administrator']);
  console.log('==========================================================');
  console.log(` Administrator angelegt: ${config.adminUsername}`);
  if (generated) console.log(` Generiertes Passwort:   ${pw}`);
  console.log('==========================================================');
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Passwort muss mindestens 8 Zeichen haben';
  return null;
}

function router({ onUserDeleted }) {
  const r = express.Router();

  r.get('/config', (req, res) => {
    res.json({
      allowRegistration: config.allowRegistration && config.authMode !== 'imap',
      authMode: config.authMode,
      defaultDomain: config.authDefaultDomain || null,
      quotaWarnPercent: config.quotaPercent.warn,
      quotaFullPercent: config.quotaPercent.full,
      ...password.capabilities(),
    });
  });

  r.post('/login', async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const block = await guard.check(req.ip, username);
      if (block) {
        console.warn(`[login] Gesperrt (${block.reason}) für "${username}" von ${guard.normIp(req.ip)}`);
        return res.status(429).json({ error: guard.message(block) });
      }
      // Mit IMAP-Anmeldung gilt die vollständige E-Mail-Adresse als Login.
      // Ausnahme: lokal angelegte Benutzer (z. B. Notfall-Admin) mit ihrem Benutzernamen.
      if (config.authMode === 'imap' && !username.includes('@')) {
        const local = await db.one("SELECT 1 FROM users WHERE username = $1 AND auth_source <> 'imap'", [username]);
        if (!local) return res.status(400).json({ error: 'Bitte mit der vollständigen E-Mail-Adresse anmelden (z. B. name@beispiel.ch)' });
      }
      const user = await authenticate(username, password);
      if (!user) {
        await guard.fail(req.ip, username, 'login');
        return res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
      }
      await guard.success(req.ip, username);
      const sid = randomToken(32);
      // „Angemeldet bleiben": dauerhaftes Cookie (SESSION_DAYS), sonst Sitzungs-Cookie,
      // das beim Schliessen des Browsers verfällt (serverseitig zusätzlich SESSION_IDLE_HOURS)
      const persistent = req.body.remember === true || req.body.remember === 'true';
      const lifetime = sessionLifetimeSec(persistent);
      await db.query(
        `INSERT INTO sessions (id, user_id, expires_at, user_agent, persistent)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4, $5)`,
        [sid, user.id, String(lifetime), String(req.get('user-agent') || '').slice(0, 300), persistent]);
      db.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
      db.query('UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE id = $1', [user.id]).catch(() => {});
      setSessionCookie(res, sid, persistent ? lifetime : null);
      res.json({ user: publicUser(user) });
    } catch (err) { next(err); }
  });

  r.post('/register', async (req, res, next) => {
    try {
      if (!config.allowRegistration || config.authMode === 'imap') return res.status(403).json({ error: 'Registrierung ist deaktiviert' });
      const username = String(req.body.username || '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Ungültiger Benutzername (a–z, 0–9, . _ -)' });
      const pwErr = validatePassword(req.body.password);
      if (pwErr) return res.status(400).json({ error: pwErr });
      const exists = await db.one('SELECT 1 FROM users WHERE username = $1', [username]);
      if (exists) return res.status(409).json({ error: 'Benutzername vergeben' });
      await db.query('INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3)',
        [username, await hashPassword(req.body.password), String(req.body.displayName || username)]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  r.post('/logout', async (req, res) => {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) await db.query('DELETE FROM sessions WHERE id = $1', [sid]).catch(() => {});
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch('/me', requireAuth, async (req, res, next) => {
    try {
      const displayName = req.body.displayName !== undefined ? String(req.body.displayName) : req.user.display_name;
      const settings = req.body.settings && typeof req.body.settings === 'object'
        ? { ...(req.user.settings || {}), ...req.body.settings } : req.user.settings;
      const u = await db.one('UPDATE users SET display_name = $2, settings = $3 WHERE id = $1 RETURNING *',
        [req.user.id, displayName, settings]);
      res.json({ user: publicUser(u) });
    } catch (err) { next(err); }
  });

  r.post('/me/password', requireAuth, async (req, res, next) => {
    try {
      // Auch das aktuelle Passwort darf nicht beliebig oft geraten werden (z. B. offene Sitzung)
      const block = await guard.check(req.ip, req.user.username);
      if (block) return res.status(429).json({ error: guard.message(block) });
      const wrongCurrent = async () => {
        await guard.fail(req.ip, req.user.username, 'password');
        return res.status(400).json({ error: 'Das aktuelle Passwort ist falsch' });
      };
      if (req.user.auth_source === 'imap') {
        if (!password.ldapChangeAvailable()) {
          return res.status(400).json({ error: 'Dein Passwort ist das des Mailservers und wird dort geändert' });
        }
        try {
          await password.changeViaLdap(req.user, String(req.body.current || ''), String(req.body.password || ''));
        } catch (err) {
          if (err.status === 400 && /aktuelle Passwort ist falsch/i.test(err.message)) return wrongCurrent();
          throw err;
        }
        clearBasicCacheFor(req.user.username);
        return res.json({ ok: true });
      }
      if (!(await verifyPassword(String(req.body.current || ''), req.user.password_hash))) return wrongCurrent();
      const pwErr = validatePassword(req.body.password);
      if (pwErr) return res.status(400).json({ error: pwErr });
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await hashPassword(req.body.password)]);
      await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.user.sid]);
      clearBasicCacheFor(req.user.username);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // ---------------- Hintergrundbild ----------------
  r.get('/me/background', requireAuth, async (req, res, next) => {
    try {
      const row = await db.one('SELECT mime, data FROM user_backgrounds WHERE user_id = $1', [req.user.id]);
      if (!row) return res.status(404).end();
      res.setHeader('Content-Type', row.mime);
      // Die URL enthält eine Versionsnummer (?v=…), daher lange cachebar
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.end(Buffer.from(row.data, 'base64'));
    } catch (err) { next(err); }
  });

  r.put('/me/background', requireAuth, async (req, res, next) => {
    try {
      const m = String(req.body.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return res.status(400).json({ error: 'Bitte ein Bild im Format JPEG, PNG oder WebP wählen' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > BACKGROUND_MAX) return res.status(413).json({ error: `Bild zu groß (max. ${Math.round(BACKGROUND_MAX / 1048576)} MB)` });
      const sig = buf.subarray(0, 12);
      const isImage = (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff)
        || sig.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        || (sig.subarray(0, 4).toString('latin1') === 'RIFF' && sig.subarray(8, 12).toString('latin1') === 'WEBP');
      if (!isImage) return res.status(400).json({ error: 'Die Datei ist kein gültiges Bild' });
      await db.query(
        `INSERT INTO user_backgrounds (user_id, mime, data, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`,
        [req.user.id, m[1], m[2]]);
      const lum = Math.min(1, Math.max(0, Number(req.body.luminance)));
      const appearance = { ...((req.user.settings || {}).appearance || {}), image: { v: Date.now(), lum: Number.isFinite(lum) ? lum : 0.5 } };
      const u = await db.one('UPDATE users SET settings = $2 WHERE id = $1 RETURNING *',
        [req.user.id, { ...(req.user.settings || {}), appearance }]);
      res.json({ user: publicUser(u) });
    } catch (err) { next(err); }
  });

  r.delete('/me/background', requireAuth, async (req, res, next) => {
    try {
      await db.query('DELETE FROM user_backgrounds WHERE user_id = $1', [req.user.id]);
      const appearance = { ...((req.user.settings || {}).appearance || {}), image: null };
      const u = await db.one('UPDATE users SET settings = $2 WHERE id = $1 RETURNING *',
        [req.user.id, { ...(req.user.settings || {}), appearance }]);
      res.json({ user: publicUser(u) });
    } catch (err) { next(err); }
  });

  // ---------------- Admin ----------------
  r.get('/admin/users', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const rows = await db.many(
        `SELECT u.id, u.username, u.display_name, u.is_admin, u.created_at, u.auth_source,
                u.last_login_at, u.last_seen_at,
                (SELECT count(*)::int FROM mail_accounts a WHERE a.user_id = u.id) AS accounts,
                (SELECT coalesce(json_agg(json_build_object(
                          'name', a.name, 'email', a.email, 'used', a.quota_used, 'limit', a.quota_limit,
                          'source', a.quota_source, 'checked', a.quota_checked_at) ORDER BY a.sort_order, a.id), '[]'::json)
                   FROM mail_accounts a WHERE a.user_id = u.id) AS mailboxes
         FROM users u ORDER BY u.username`);
      res.json({ users: rows });
    } catch (err) { next(err); }
  });

  r.post('/admin/users', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Ungültiger Benutzername (a–z, 0–9, . _ -)' });
      const pwErr = validatePassword(req.body.password);
      if (pwErr) return res.status(400).json({ error: pwErr });
      const exists = await db.one('SELECT 1 FROM users WHERE username = $1', [username]);
      if (exists) return res.status(409).json({ error: 'Benutzername vergeben' });
      const u = await db.one(
        'INSERT INTO users (username, password_hash, display_name, is_admin) VALUES ($1,$2,$3,$4) RETURNING id',
        [username, await hashPassword(req.body.password), String(req.body.displayName || username), !!req.body.isAdmin]);
      res.json({ id: u.id });
    } catch (err) { next(err); }
  });

  r.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const u = await db.one('SELECT * FROM users WHERE id = $1', [id]);
      if (!u) return res.status(404).json({ error: 'Nicht gefunden' });
      if (req.body.password) {
        if (u.auth_source === 'imap') return res.status(400).json({ error: 'Dieser Benutzer meldet sich mit dem Passwort des Mailservers an' });
        const pwErr = validatePassword(req.body.password);
        if (pwErr) return res.status(400).json({ error: pwErr });
        await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await hashPassword(req.body.password)]);
        await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
        clearBasicCacheFor(u.username);
      }
      if (req.body.isAdmin !== undefined) {
        if (id === req.user.id && !req.body.isAdmin) return res.status(400).json({ error: 'Eigene Admin-Rechte können nicht entzogen werden' });
        await db.query('UPDATE users SET is_admin = $2 WHERE id = $1', [id, !!req.body.isAdmin]);
      }
      if (req.body.displayName !== undefined) {
        await db.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, String(req.body.displayName)]);
      }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  r.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (id === req.user.id) return res.status(400).json({ error: 'Eigenes Konto kann nicht gelöscht werden' });
      const accounts = await db.many('SELECT id FROM mail_accounts WHERE user_id = $1', [id]);
      const u = await db.one('DELETE FROM users WHERE id = $1 RETURNING username', [id]);
      if (u) clearBasicCacheFor(u.username);
      if (onUserDeleted) await onUserDeleted(accounts.map((a) => a.id));
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return r;
}

module.exports = {
  router, requireAuth, requireAdmin, csrfGuard, userFromRequest, verifyBasic, ensureAdmin, publicUser,
};
