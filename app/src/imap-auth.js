'use strict';

/**
 * Anmeldung mit den Zugangsdaten des IMAP-Servers (AUTH_MODE=imap).
 *
 *  - Benutzername/Passwort werden per IMAP-LOGIN am konfigurierten Server geprüft.
 *  - Beim ersten Login wird der Webmail-Benutzer angelegt und – sofern
 *    AUTH_CREATE_ACCOUNT nicht false ist – das Postfach als E-Mail-Konto
 *    inklusive Standard-Identität eingerichtet.
 *  - Ändert sich das Passwort am Mailserver, wird das gespeicherte
 *    Konto-Passwort beim nächsten Login automatisch nachgezogen.
 *  - Lokale Benutzer (z. B. der Bootstrap-Admin) melden sich weiterhin
 *    mit ihrem lokalen Passwort an.
 */
const { ImapFlow } = require('imapflow');
const db = require('./db');
const config = require('./config');
const { encrypt, decrypt, verifyPassword } = require('./crypto');
const { imapConnectOptions, friendlyError } = require('./tls');
const domains = require('./domains');

class AuthUnavailableError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 503;
  }
}

class DomainNotConfiguredError extends Error {
  constructor(domain) {
    super(domain ? `Für die Domain ${domain} ist kein Mailserver eingerichtet` : 'Kein Mailserver eingerichtet');
    this.status = 400;
  }
}

function normalizeLogin(raw) {
  let u = String(raw || '').trim().toLowerCase();
  if (u && config.authDefaultDomain && !u.includes('@')) u = `${u}@${config.authDefaultDomain}`;
  return u;
}

/** Prüft die Zugangsdaten am IMAP-Server. Ergebnis: true | false, wirft bei Serverproblemen. */
async function checkImapLogin(d, username, password) {
  if (!username || !password) return false;
  const c = new ImapFlow({
    host: d.imap_host,
    ...imapConnectOptions(d.imap_port, d.imap_security, d.allow_insecure_tls),
    auth: { user: username, pass: password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
  c.on('error', () => {});
  try {
    await c.connect();
    await c.logout().catch(() => c.close());
    return true;
  } catch (err) {
    try { c.close(); } catch (_) { /* ignore */ }
    if (err.authenticationFailed || err.responseStatus === 'NO') return false;
    console.error('[auth] IMAP-Server für Anmeldung nicht erreichbar:',
      friendlyError(err, { kind: 'imap', port: d.imap_port, security: d.imap_security }));
    throw new AuthUnavailableError('Der Mailserver ist für die Anmeldung gerade nicht erreichbar');
  }
}

/** Legt Benutzer + Postfach an bzw. aktualisiert das gespeicherte Passwort. */
async function provision(username, password, existing, d) {
  const manager = require('./imap/manager'); // spät laden (vermeidet Zyklen)
  const isAdmin = config.authAdmins.includes(username);
  let user = existing;
  if (!user) {
    user = await db.one(
      `INSERT INTO users (username, password_hash, display_name, is_admin, auth_source)
       VALUES ($1, '', $2, $3, 'imap')
       ON CONFLICT (username) DO UPDATE SET auth_source = 'imap'
       RETURNING *`,
      [username, username.split('@')[0], isAdmin]);
    console.log(`[auth] Benutzer ${username} beim ersten IMAP-Login angelegt`);
  } else if (isAdmin && !user.is_admin) {
    user = await db.one('UPDATE users SET is_admin = true WHERE id = $1 RETURNING *', [user.id]);
  }

  const imapUser = domains.loginFor(d, username);
  const accounts = await loginAccounts(user.id, username, d);

  if (!accounts.length && config.authCreateAccount) {
    const email = username;
    const f = domains.accountFields(d);
    const acc = await db.tx(async (t) => {
      const ins = await t.query(
        `INSERT INTO mail_accounts (user_id, name, email, imap_host, imap_port, imap_security, imap_user, imap_pass,
                                    smtp_host, smtp_port, smtp_security, smtp_user, smtp_pass, allow_insecure_tls, sort_order, domain_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'','',$12,0,$13) RETURNING *`,
        [user.id, email, email, f.imap_host, f.imap_port, f.imap_security, imapUser, encrypt(password),
          f.smtp_host, f.smtp_port, f.smtp_security, f.allow_insecure_tls, d.id]);
      await t.query('INSERT INTO identities (account_id, name, email, is_default) VALUES ($1, $2, $3, true)',
        [ins.rows[0].id, user.display_name || '', email]);
      return ins.rows[0];
    });
    manager.start(acc);
  } else {
    for (const acc of accounts) {
      let stored = '';
      try { stored = decrypt(acc.imap_pass); } catch (_) { /* Schlüssel geändert */ }
      if (stored !== password) {
        await db.query("UPDATE mail_accounts SET imap_pass = $2, status = 'pending', last_error = NULL WHERE id = $1",
          [acc.id, encrypt(password)]);
        await manager.restart(acc.id);
      }
    }
  }
  const davUrl = d.dav_url || config.authDavUrl;
  if (davUrl) await provisionDav(user, username, password, davUrl);
  return user;
}

/** Konten des Benutzers, die zu seinem Anmelde-Postfach gehören (über die Domain oder Server + Login). */
function loginAccounts(userId, username, d) {
  return db.many(
    `SELECT * FROM mail_accounts
      WHERE user_id = $1 AND ((domain_id = $2 AND lower(email) = $3)
         OR (lower(imap_host) = lower($4) AND lower(imap_user) IN ($3, $5)))`,
    [userId, d.id, username, d.imap_host, domains.loginFor(d, username)]);
}

/** Bindet den CalDAV/CardDAV-Server aus AUTH_DAV_URL mit den Login-Daten ein (bzw. aktualisiert das Passwort). */
async function provisionDav(user, username, password, davUrl) {
  try {
    const row = await db.one('SELECT * FROM dav_sources WHERE user_id = $1 AND url = $2', [user.id, davUrl]);
    if (!row) {
      await db.query('INSERT INTO dav_sources (user_id, name, url, username, password) VALUES ($1,$2,$3,$4,$5)',
        [user.id, config.authDavName, davUrl, username, encrypt(password)]);
      console.log(`[auth] CalDAV/CardDAV-Server für ${username} eingebunden`);
    } else {
      let stored = '';
      try { stored = decrypt(row.password); } catch (_) { /* ignore */ }
      if (stored !== password || row.username !== username) {
        await db.query('UPDATE dav_sources SET password = $2, username = $3 WHERE id = $1', [row.id, encrypt(password), username]);
      }
    }
    require('./dav/service').invalidate(user);
  } catch (err) {
    console.error('[auth] DAV-Server konnte nicht eingebunden werden:', err.message);
  }
}

/**
 * Zentrale Anmeldeprüfung für Web-Login und CalDAV/CardDAV-Clients.
 * Liefert den Benutzer-Datensatz oder null.
 */
async function authenticate(rawUser, password) {
  const raw = String(rawUser || '').trim().toLowerCase();
  if (!raw || !password) return null;

  // Lokale Benutzer (Notfall-Admin, manuell angelegte) behalten ihr lokales Passwort –
  // zuerst unter dem exakt eingegebenen Namen suchen (ohne Domain-Ergänzung).
  const local = await db.one("SELECT * FROM users WHERE username = $1 AND auth_source <> 'imap'", [raw]);
  if (local) return (await verifyPassword(password, local.password_hash)) ? local : null;
  if (config.authMode !== 'imap') return null;

  const username = normalizeLogin(raw);
  const existing = await db.one('SELECT * FROM users WHERE username = $1', [username]);
  if (existing && existing.auth_source !== 'imap') {
    return (await verifyPassword(password, existing.password_hash)) ? existing : null;
  }
  const d = await domains.findForEmail(username);
  if (!d) throw new DomainNotConfiguredError(domains.domainOf(username));
  if (!(await checkImapLogin(d, domains.loginFor(d, username), password))) return null;
  return provision(username, password, existing, d);
}

/**
 * Nach einer Passwortänderung im LDAP: gespeicherte Passwörter des Postfachs
 * und des automatisch eingebundenen DAV-Servers nachziehen, Konten neu verbinden.
 */
async function syncStoredPasswords(login, newPassword) {
  const manager = require('./imap/manager');
  const username = normalizeLogin(login);
  const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);
  if (!user) return;
  const d = await domains.findForEmail(username);
  const accounts = d ? await loginAccounts(user.id, username, d) : [];
  for (const a of accounts) {
    await db.query("UPDATE mail_accounts SET imap_pass = $2, status = 'pending', last_error = NULL WHERE id = $1", [a.id, encrypt(newPassword)]);
    await manager.restart(a.id).catch(() => {});
  }
  const davUrl = (d && d.dav_url) || config.authDavUrl;
  if (davUrl) {
    await db.query('UPDATE dav_sources SET password = $3 WHERE user_id = $1 AND url = $2', [user.id, davUrl, encrypt(newPassword)]);
    require('./dav/service').invalidate(user);
  }
}

module.exports = { authenticate, normalizeLogin, syncStoredPasswords, AuthUnavailableError, DomainNotConfiguredError };
