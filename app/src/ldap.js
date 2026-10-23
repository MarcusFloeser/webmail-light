'use strict';

/**
 * Passwortverwaltung im LDAP (OpenLDAP, 389-DS, FreeIPA, Active Directory …).
 *
 *  - changeOwnPassword(): Benutzer ändert sein Passwort (Bind mit altem Passwort).
 *  - resetPassword():     Setzen ohne altes Passwort über das Dienstkonto ("Passwort vergessen").
 *  - findUser():          Benutzer-DN + Wiederherstellungs-Adresse über das Dienstkonto ermitteln.
 *
 * Methoden (LDAP_PASSWORD_METHOD):
 *   exop  – RFC 3062 Password Modify (Standard; Server hasht selbst und prüft ppolicy)
 *   ssha  – userPassword als {SSHA}-Hash ersetzen
 *   plain – userPassword im Klartext ersetzen (Server hasht z. B. per ppolicy hash_cleartext)
 *   ad    – Active Directory unicodePwd (nur über LDAPS)
 */
const crypto = require('crypto');
const { Client, Change, Attribute } = require('ldapts');
const config = require('./config');

const PASSWD_MODIFY_OID = '1.3.6.1.4.1.4203.1.11.1';

class LdapError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

function enabled() {
  return !!(config.ldap.url && (config.ldap.baseDn || config.ldap.userDnTemplate));
}

/** RFC 4515: Sonderzeichen in Filterwerten maskieren */
function escapeFilter(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** RFC 4514: Sonderzeichen in DN-Werten maskieren */
function escapeDn(v) {
  return String(v)
    .replace(/[\\,+"<>;=#]/g, (c) => '\\' + c)
    .replace(/^ | $/g, (c) => '\\' + c);
}

function placeholders(tpl, login, escape) {
  const user = String(login || '').trim();
  const local = user.split('@')[0];
  const domain = user.includes('@') ? user.split('@')[1] : '';
  return tpl.replace(/\{user\}/g, escape(user)).replace(/\{localpart\}/g, escape(local)).replace(/\{domain\}/g, escape(domain));
}

/**
 * Verbindungsziel aus LDAP_URL ableiten. Typische Verwechslungen werden korrigiert:
 *   ldaps://host:389 -> ldap://host:389 + StartTLS   (389 spricht nie direkt TLS)
 *   ldap://host:636  -> ldaps://host:636             (636 spricht immer direkt TLS)
 */
function endpoint() {
  const u = new URL(config.ldap.url);
  let scheme = u.protocol.replace(':', '').toLowerCase();
  const port = u.port || (scheme === 'ldaps' ? '636' : '389');
  let startTls = config.ldap.startTls;
  if (scheme === 'ldaps' && port === '389') { scheme = 'ldap'; startTls = true; }
  if (scheme === 'ldap' && port === '636') { scheme = 'ldaps'; startTls = false; }
  if (scheme === 'ldaps') startTls = false;
  return { url: `${scheme}://${u.hostname}:${port}`, startTls, host: u.hostname, port };
}

let learned = null; // per Fallback ermittelte funktionierende Variante

async function connect(ep) {
  const tlsOptions = { rejectUnauthorized: !config.ldap.tlsInsecure };
  const hostname = ep.host.replace(/^\[|\]$/g, '');
  if (!/^[\d.:]+$/.test(hostname)) tlsOptions.servername = hostname; // SNI nur für Namen, nicht für IPs
  // Wichtig: ldapts baut eine TLS-Verbindung auf, sobald tlsOptions übergeben werden – auch bei ldap://.
  // Daher tlsOptions nur für ldaps:// an den Client geben; bei StartTLS erst an startTLS().
  const secure = ep.url.startsWith('ldaps://');
  const client = new Client({ url: ep.url, timeout: 15000, connectTimeout: 10000, ...(secure ? { tlsOptions } : {}) });
  if (ep.startTls) {
    try {
      await client.startTLS(tlsOptions);
    } catch (err) {
      err.duringStartTls = true;
      throw err;
    }
  }
  return client;
}

function isTlsMismatch(err) {
  return /disconnected before secure TLS|wrong version number|EPROTO|unknown protocol|packet length too long/i.test(String(err && err.message));
}

async function attempt(ep, fn) {
  let client;
  try {
    client = await connect(ep);
    return await fn(client);
  } finally {
    if (client) await client.unbind().catch(() => {});
  }
}

async function withClient(fn) {
  const ep = learned || endpoint();
  try {
    return await attempt(ep, fn);
  } catch (err) {
    // ldaps:// auf einem Port, der unverschlüsseltes LDAP spricht -> einmal mit StartTLS versuchen
    if (!learned && isTlsMismatch(err) && ep.url.startsWith('ldaps://')) {
      const alt = { ...ep, url: `ldap://${ep.host}:${ep.port}`, startTls: true };
      try {
        const res = await attempt(alt, fn);
        learned = alt;
        console.warn(`[ldap] ${ep.url} spricht kein LDAPS – verwende ${alt.url} mit StartTLS. Bitte LDAP_URL=${alt.url} und LDAP_STARTTLS=true setzen.`);
        return res;
      } catch (err2) {
        throw mapError(err2, alt);
      }
    }
    throw mapError(err, ep);
  }
}

function mapError(err, ep = endpoint()) {
  if (err instanceof LdapError) return err;
  const name = err && (err.constructor && err.constructor.name);
  const msg = String((err && err.message) || err);
  const where = `${ep.host}:${ep.port}`;
  console.error('[ldap]', name, msg, `(${ep.url}${ep.startTls ? ' + StartTLS' : ''})`);
  if (err && err.serviceBind) return new LdapError(500, 'Anmeldung des LDAP-Dienstkontos fehlgeschlagen – LDAP_BIND_DN und LDAP_BIND_PASSWORD prüfen');
  if (name === 'InvalidCredentialsError' || /invalid credentials|data 52e/i.test(msg)) return new LdapError(400, 'Das aktuelle Passwort ist falsch');
  if (name === 'ConstraintViolationError' || /constraint|password.*(quality|history|policy|too short|too young)|0000052D/i.test(msg)) {
    return new LdapError(400, 'Das neue Passwort erfüllt die Passwort-Richtlinie des Servers nicht (Länge, Komplexität oder bereits verwendet)');
  }
  if (name === 'InsufficientAccessError' || /insufficient access/i.test(msg)) return new LdapError(403, 'Keine Berechtigung, das Passwort im Verzeichnis zu ändern (ACL prüfen)');
  if (name === 'ConfidentialityRequiredError' || /confidentiality required/i.test(msg)) {
    return new LdapError(500, 'Der LDAP-Server verlangt eine verschlüsselte Verbindung – ldaps:// (Port 636) oder LDAP_STARTTLS=true verwenden');
  }
  if (err && err.duringStartTls && !/certificate|self[- ]signed|unable to verify/i.test(msg)) {
    return new LdapError(500, `StartTLS mit ${where} fehlgeschlagen (${msg}). Unterstützt der Server StartTLS? Sonst ldaps:// auf Port 636 verwenden`);
  }
  if (isTlsMismatch(err)) {
    return new LdapError(500, `Auf ${where} antwortet kein LDAPS. Entweder LDAP_URL=ldaps://${ep.host}:636 oder LDAP_URL=ldap://${ep.host}:389 mit LDAP_STARTTLS=true verwenden`);
  }
  if (/self[- ]signed|unable to (verify|get local issuer)|certificate|altnames/i.test(msg)) {
    return new LdapError(500, `Zertifikat des LDAP-Servers wird nicht vertraut (${msg}) – Hostnamen in LDAP_URL prüfen oder LDAP_TLS_INSECURE=true setzen`);
  }
  if (/ECONNREFUSED/i.test(msg)) return new LdapError(503, `LDAP-Server ${where} lehnt die Verbindung ab – läuft slapd auf diesem Port?`);
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return new LdapError(503, `LDAP-Server ${ep.host} nicht gefunden (DNS) – vom Container aus erreichbar?`);
  if (/ETIMEDOUT|timeout|EHOSTUNREACH/i.test(msg)) return new LdapError(503, `LDAP-Server ${where} antwortet nicht (Firewall?)`);
  return new LdapError(500, `LDAP-Fehler: ${msg}`);
}

async function bindService(client) {
  try {
    await client.bind(config.ldap.bindDn, config.ldap.bindPassword);
  } catch (err) {
    if (err && (err.constructor && err.constructor.name === 'InvalidCredentialsError')) err.serviceBind = true;
    throw err;
  }
}

function firstValue(v) {
  if (Array.isArray(v)) return v.length ? String(v[0]) : '';
  return v === undefined || v === null ? '' : String(v);
}

/** Sucht den Benutzer per Dienstkonto. Ergebnis: { dn, mail, recovery } oder null */
async function findUser(login) {
  if (config.ldap.userDnTemplate && !config.ldap.bindDn) {
    return { dn: placeholders(config.ldap.userDnTemplate, login, escapeDn), mail: '', recovery: [] };
  }
  return withClient(async (client) => {
    if (config.ldap.bindDn) await bindService(client);
    if (config.ldap.userDnTemplate) {
      const dn = placeholders(config.ldap.userDnTemplate, login, escapeDn);
      const { searchEntries } = await client.search(dn, { scope: 'base', filter: '(objectClass=*)', attributes: [config.ldap.mailAttr, ...config.ldap.recoveryAttrs] });
      return searchEntries[0] ? entryInfo(searchEntries[0]) : null;
    }
    const filter = placeholders(config.ldap.userFilter, login, escapeFilter);
    const { searchEntries } = await client.search(config.ldap.baseDn, {
      scope: 'sub', filter, sizeLimit: 2, attributes: [config.ldap.mailAttr, ...config.ldap.recoveryAttrs],
    });
    if (searchEntries.length !== 1) return null; // nicht gefunden oder nicht eindeutig
    return entryInfo(searchEntries[0]);
  });
}

function entryInfo(e) {
  const lower = {};
  for (const [k, v] of Object.entries(e)) lower[k.toLowerCase()] = v;
  const recovery = [];
  for (const attr of config.ldap.recoveryAttrs) {
    const v = lower[attr.toLowerCase()];
    for (const x of (Array.isArray(v) ? v : [v])) if (x && /@/.test(String(x))) recovery.push(String(x).replace(/^smtp:/i, ''));
  }
  return { dn: e.dn, mail: firstValue(lower[config.ldap.mailAttr.toLowerCase()]), recovery };
}

// ------------------------------------------------------------------ Passwort setzen

function berLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}

function berTlv(tag, value) {
  return Buffer.concat([Buffer.from([tag]), berLength(value.length), value]);
}

/** PasswdModifyRequestValue ::= SEQUENCE { userIdentity [0], oldPasswd [1], newPasswd [2] } */
function passwdModifyValue(dn, oldPw, newPw) {
  const parts = [];
  if (dn) parts.push(berTlv(0x80, Buffer.from(dn, 'utf8')));
  if (oldPw) parts.push(berTlv(0x81, Buffer.from(oldPw, 'utf8')));
  parts.push(berTlv(0x82, Buffer.from(newPw, 'utf8')));
  return berTlv(0x30, Buffer.concat(parts));
}

function sshaHash(pw) {
  const salt = crypto.randomBytes(8);
  const digest = crypto.createHash('sha1').update(Buffer.from(pw, 'utf8')).update(salt).digest();
  return '{SSHA}' + Buffer.concat([digest, salt]).toString('base64');
}

function adPassword(pw) {
  return Buffer.from(`"${pw}"`, 'utf16le');
}

async function writePassword(client, dn, oldPw, newPw) {
  const method = config.ldap.passwordMethod;
  if (method === 'exop') {
    await client.exop(PASSWD_MODIFY_OID, passwdModifyValue(dn, oldPw, newPw));
    return;
  }
  if (method === 'ad') {
    if (oldPw) {
      // Selbständerung im AD: altes Passwort löschen + neues hinzufügen in einem Schritt
      await client.modify(dn, [
        new Change({ operation: 'delete', modification: new Attribute({ type: 'unicodePwd', values: [adPassword(oldPw)] }) }),
        new Change({ operation: 'add', modification: new Attribute({ type: 'unicodePwd', values: [adPassword(newPw)] }) }),
      ]);
    } else {
      await client.modify(dn, new Change({ operation: 'replace', modification: new Attribute({ type: 'unicodePwd', values: [adPassword(newPw)] }) }));
    }
    return;
  }
  const value = method === 'ssha' ? sshaHash(newPw) : newPw;
  await client.modify(dn, new Change({ operation: 'replace', modification: new Attribute({ type: 'userPassword', values: [value] }) }));
}

function checkPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < config.passwordMinLength) {
    throw new LdapError(400, `Das neue Passwort muss mindestens ${config.passwordMinLength} Zeichen haben`);
  }
}

/** Benutzer ändert sein eigenes Passwort. */
async function changeOwnPassword(login, oldPw, newPw) {
  checkPolicy(newPw);
  const user = await findUser(login);
  if (!user) throw new LdapError(404, 'Benutzer im Verzeichnis nicht gefunden');
  await withClient(async (client) => {
    await client.bind(user.dn, oldPw); // prüft zugleich das alte Passwort
    await writePassword(client, config.ldap.passwordMethod === 'exop' ? user.dn : user.dn, oldPw, newPw);
  });
}

/** Setzt ein neues Passwort über das Dienstkonto (Passwort-vergessen-Ablauf). */
async function resetPassword(dn, newPw) {
  checkPolicy(newPw);
  if (!config.ldap.bindDn) throw new LdapError(500, 'Für das Zurücksetzen ist ein LDAP-Dienstkonto (LDAP_BIND_DN) nötig');
  await withClient(async (client) => {
    await bindService(client);
    await writePassword(client, dn, null, newPw);
  });
}

/** Verbindungs- und Konfigurationstest (für tools/ldap-check.js) */
async function diagnose(login) {
  const ep = endpoint();
  const steps = [];
  steps.push(`Ziel: ${ep.url}${ep.startTls ? ' + StartTLS' : ''}${!ep.startTls && ep.url.startsWith('ldap://') ? ' (unverschlüsselt – nur im internen Netz verwenden)' : ''}`);
  await withClient(async (client) => {
    steps.push('Verbindung + Verschlüsselung: OK');
    if (config.ldap.bindDn) { await bindService(client); steps.push(`Dienstkonto ${config.ldap.bindDn}: Anmeldung OK`); }
  });
  if (learned) steps.push(`Hinweis: funktioniert nur mit ${learned.url} + StartTLS – .env anpassen`);
  if (login) {
    const u = await findUser(login);
    steps.push(u ? `Benutzer gefunden: ${u.dn} (mail: ${u.mail || '–'}, Ersatz-Adresse: ${u.recovery.join(', ') || '–'})` : `Benutzer "${login}" nicht gefunden (Filter: ${config.ldap.userFilter})`);
  }
  return steps;
}

module.exports = {
  enabled, findUser, changeOwnPassword, resetPassword, diagnose, endpoint, LdapError,
  // für Tests
  _internal: { isTlsMismatch, escapeFilter, escapeDn, placeholders, passwdModifyValue, sshaHash, entryInfo },
};
