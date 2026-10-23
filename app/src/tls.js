'use strict';

/**
 * Verschlüsselung für IMAP/SMTP passend zum Port.
 *
 *  IMAP: 993 = SSL/TLS (implizit), 143 = STARTTLS (oder unverschlüsselt im internen Netz)
 *  SMTP: 465 = SSL/TLS,            587/25 = STARTTLS
 *
 * Offensichtliche Fehlkombinationen an Standardports (z. B. "SSL" auf 143)
 * werden korrigiert, statt mit einem TLS-Fehler abzubrechen.
 */

const STANDARD = {
  imap: { 993: 'ssl', 143: 'starttls' },
  smtp: { 465: 'ssl', 587: 'starttls', 25: 'starttls' },
};
const VALID = ['ssl', 'starttls', 'none'];

function effectiveSecurity(kind, port, security) {
  const std = STANDARD[kind][Number(port)];
  const s = VALID.includes(security) ? security : null;
  if (!s) return std || (kind === 'imap' ? 'ssl' : 'starttls');
  if (std === 'ssl' && s !== 'ssl') return 'ssl';            // 993/465 sprechen immer direkt TLS
  if (std === 'starttls' && s === 'ssl') return 'starttls';  // 143/587/25 beginnen immer unverschlüsselt
  return s;
}

/** Optionen für imapflow */
function imapConnectOptions(port, security, allowInsecureTls) {
  const sec = effectiveSecurity('imap', port, security);
  return {
    port: Number(port),
    secure: sec === 'ssl',
    // starttls: STARTTLS erzwingen; none: kein STARTTLS (nur für interne Server)
    doSTARTTLS: sec === 'starttls' ? true : (sec === 'none' ? false : undefined),
    tls: { rejectUnauthorized: !allowInsecureTls },
  };
}

/** Optionen für nodemailer */
function smtpConnectOptions(port, security, allowInsecureTls) {
  const sec = effectiveSecurity('smtp', port, security);
  return {
    port: Number(port),
    secure: sec === 'ssl',
    requireTLS: sec === 'starttls',
    ignoreTLS: sec === 'none',
    tls: { rejectUnauthorized: !allowInsecureTls },
  };
}

/** Verständliche Meldung für typische Verbindungsfehler */
function friendlyError(err, { kind = 'imap', port, security } = {}) {
  const msg = String((err && (err.responseText || err.response || err.message)) || err || '');
  const code = err && err.code;
  if (err && err.authenticationFailed) return 'Anmeldung fehlgeschlagen (Benutzername oder Passwort falsch)';
  if (/STARTTLS/i.test(msg) && /not|unsupported|support|kein/i.test(msg)) {
    return `Der Server bietet auf Port ${port} kein STARTTLS an – Verschlüsselung auf „Keine“ stellen (nur im internen Netz) oder Port ${kind === 'imap' ? 993 : 465} mit SSL/TLS verwenden`;
  }
  if (/wrong version number|EPROTO|packet length too long|unknown protocol/i.test(msg) || code === 'EPROTO') {
    return `Verschlüsselung passt nicht zum Port ${port}: für ${kind === 'imap' ? '143 STARTTLS, für 993' : '587 STARTTLS, für 465'} SSL/TLS wählen`;
  }
  if (/self[- ]signed|unable to (verify|get local issuer)|certificate/i.test(msg)) {
    return `Zertifikat des Servers wird nicht vertraut (${msg}). Bei eigenem/selbstsigniertem Zertifikat „Ungültige Zertifikate akzeptieren“ aktivieren`;
  }
  if (/LOGINDISABLED|plaintext|cleartext/i.test(msg)) {
    return 'Der Server erlaubt die Anmeldung nur verschlüsselt – Verschlüsselung auf STARTTLS stellen';
  }
  if (code === 'ECONNREFUSED') return `Verbindung abgelehnt – läuft der Dienst auf Port ${port}?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Servername nicht gefunden (DNS)';
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return `Zeitüberschreitung – Server oder Port ${port} nicht erreichbar (Firewall?)`;
  return msg || 'Unbekannter Fehler';
}

module.exports = { effectiveSecurity, imapConnectOptions, smtpConnectOptions, friendlyError };
