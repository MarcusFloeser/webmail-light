'use strict';

/**
 * "Passwort vergessen" (Link per E-Mail an die Wiederherstellungsadresse aus dem LDAP)
 * und Passwortänderung im LDAP.
 */
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');
const db = require('./db');
const config = require('./config');
const ldap = require('./ldap');
const { normalizeLogin, syncStoredPasswords } = require('./imap-auth');
const { randomToken } = require('./crypto');
const { smtpConnectOptions } = require('./tls');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function resetAvailable() {
  return ldap.enabled() && !!config.ldap.bindDn && !!config.systemSmtp.host && !!config.publicUrl;
}

function ldapChangeAvailable() {
  return ldap.enabled() && config.authMode === 'imap';
}

/** Was die Anmeldeseite/das Profil anbieten können */
function capabilities() {
  return {
    passwordReset: resetAvailable() ? 'email' : (config.passwordHelp ? 'help' : null),
    passwordHelp: config.passwordHelp || null,
    ldapPasswordChange: ldapChangeAvailable(),
    passwordMinLength: config.passwordMinLength,
  };
}

// ------------------------------------------------------------------ Rate-Limit
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
}, 600000).unref();

// ------------------------------------------------------------------ Mail
function maskAddress(a) {
  const [l, d] = String(a).split('@');
  return `${l.slice(0, 2)}${'•'.repeat(Math.max(1, l.length - 2))}@${d}`;
}

async function sendResetMail(to, login, link) {
  const s = config.systemSmtp;
  const transport = nodemailer.createTransport({
    host: s.host,
    ...smtpConnectOptions(s.port, s.security, s.allowInsecureTls),
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
  });
  const host = new URL(config.publicUrl).hostname;
  const minutes = config.resetTokenMinutes;
  try {
    await transport.sendMail({
      from: s.from || `Webmail <noreply@${host}>`,
      to,
      subject: 'Passwort zurücksetzen',
      text: `Hallo\n\nfür das Konto „${login}“ wurde ein neues Passwort angefordert.\n\n`
        + `Über diesen Link kannst du ein neues Passwort festlegen (gültig ${minutes} Minuten):\n${link}\n\n`
        + 'Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.\n',
      html: `<p>Hallo</p><p>für das Konto <b>${login.replace(/[<>&]/g, '')}</b> wurde ein neues Passwort angefordert.</p>`
        + `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#2f5fd0;color:#fff;border-radius:6px;text-decoration:none">Neues Passwort festlegen</a></p>`
        + `<p style="color:#666">Der Link ist ${minutes} Minuten gültig. Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.</p>`,
    });
  } finally {
    transport.close();
  }
}

async function processForgot(login, ip) {
  const lookup = config.authMode === 'imap' ? normalizeLogin(login) : login;
  let user;
  try {
    user = await ldap.findUser(lookup);
  } catch (err) {
    console.error('[passwort] LDAP-Suche fehlgeschlagen:', err.message);
    return;
  }
  if (!user) {
    console.log(`[passwort] Zurücksetzen angefordert für unbekannten Login "${lookup}"`);
    return;
  }
  let recipients = user.recovery;
  if (!recipients.length && config.ldap.recoveryFallbackPrimary && user.mail) recipients = [user.mail];
  if (!recipients.length) {
    console.log(`[passwort] Keine Wiederherstellungsadresse für ${user.dn}`);
    return;
  }
  const token = randomToken(32);
  await db.query("DELETE FROM password_resets WHERE dn = $1 OR expires_at < now() - interval '1 day'", [user.dn]);
  await db.query(
    `INSERT INTO password_resets (token_hash, login, dn, expires_at, ip)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, $5)`,
    [sha256(token), lookup, user.dn, String(config.resetTokenMinutes), ip]);
  const link = `${config.publicUrl}/#/reset/${token}`;
  try {
    await sendResetMail(recipients.join(', '), lookup, link);
    console.log(`[passwort] Link für ${lookup} an ${recipients.map(maskAddress).join(', ')} gesendet`);
  } catch (err) {
    console.error('[passwort] Versand fehlgeschlagen:', err.message);
  }
}

async function validToken(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  return db.one('SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()', [sha256(token)]);
}

// ------------------------------------------------------------------ Routen
function router() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  r.post('/password/forgot', wrap(async (req, res) => {
    if (!resetAvailable()) {
      return res.status(400).json({ error: config.passwordHelp || 'Das Zurücksetzen per E-Mail ist nicht eingerichtet. Bitte wende dich an die Administration.' });
    }
    const login = String(req.body.login || '').trim().toLowerCase();
    if (!login) return res.status(400).json({ error: 'Bitte Benutzername oder E-Mail-Adresse angeben' });
    if (limited(`ip:${req.ip}`, 10, 3600000) || limited(`login:${login}`, 3, 3600000)) {
      return res.status(429).json({ error: 'Zu viele Anfragen – bitte später erneut versuchen' });
    }
    // Immer dieselbe Antwort und sofort antworten: verrät nicht, ob es das Konto gibt
    res.json({
      ok: true,
      message: 'Falls ein passendes Konto existiert, haben wir einen Link zum Zurücksetzen an die hinterlegte Wiederherstellungs-Adresse gesendet. Bitte prüfe auch den Spam-Ordner.',
    });
    processForgot(login, req.ip).catch((err) => console.error('[passwort]', err.message));
  }));

  r.get('/password/reset/:token', wrap(async (req, res) => {
    const row = await validToken(req.params.token);
    if (!row) return res.status(410).json({ error: 'Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.' });
    res.json({ ok: true, login: row.login, minLength: config.passwordMinLength });
  }));

  r.post('/password/reset', wrap(async (req, res) => {
    if (limited(`reset:${req.ip}`, 20, 3600000)) return res.status(429).json({ error: 'Zu viele Versuche – bitte später erneut versuchen' });
    const row = await validToken(req.body.token);
    if (!row) return res.status(410).json({ error: 'Der Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.' });
    const password = String(req.body.password || '');
    await ldap.resetPassword(row.dn, password);
    await db.query('UPDATE password_resets SET used_at = now() WHERE token_hash = $1', [row.token_hash]);
    await db.query('DELETE FROM password_resets WHERE dn = $1 AND used_at IS NULL', [row.dn]);
    await syncStoredPasswords(row.login, password).catch((err) => console.error('[passwort] Konten-Update:', err.message));
    // Alle Sitzungen dieses Benutzers beenden
    await db.query('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = $1)', [row.login]);
    console.log(`[passwort] Passwort für ${row.login} über Link zurückgesetzt`);
    res.json({ ok: true });
  }));

  return r;
}

/** Passwortänderung im LDAP für angemeldete IMAP-Benutzer (aus /me/password aufgerufen). */
async function changeViaLdap(user, current, password) {
  await ldap.changeOwnPassword(user.username, current, password);
  await syncStoredPasswords(user.username, password);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [user.id, user.sid]);
}

module.exports = { router, capabilities, changeViaLdap, ldapChangeAvailable, _internal: { maskAddress, sha256 } };
