'use strict';

const env = process.env;

function required(name) {
  const v = env[name];
  if (!v || v === 'bitte-aendern') {
    console.error(`[config] Umgebungsvariable ${name} fehlt oder hat noch den Platzhalterwert.`);
    process.exit(1);
  }
  return v;
}

module.exports = {
  port: parseInt(env.PORT, 10) || 8080,
  databaseUrl: env.DATABASE_URL || 'postgres://webmail:webmail@localhost:5432/webmail',
  secretKey: required('SECRET_KEY'),
  adminUsername: (env.ADMIN_USERNAME || 'admin').toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  cookieSecure: env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === 'true',
  allowRegistration: env.ALLOW_REGISTRATION === 'true',
  syncInitialMessages: parseInt(env.SYNC_INITIAL_MESSAGES, 10) || 1000,
  pollIntervalMs: (parseInt(env.POLL_INTERVAL_SECONDS, 10) || 120) * 1000,
  sessionDays: parseInt(env.SESSION_DAYS, 10) || 30,
  // Anmeldung: 'local' (eigene Passwörter) oder 'imap' (Zugangsdaten des Mailservers)
  authMode: (env.AUTH_MODE || 'local').toLowerCase() === 'imap' ? 'imap' : 'local',
  authImap: {
    host: env.AUTH_IMAP_HOST || '',
    port: parseInt(env.AUTH_IMAP_PORT, 10) || 993,
    security: env.AUTH_IMAP_SECURITY || '', // leer = automatisch nach Port (993 SSL, 143 STARTTLS)
  },
  authSmtp: {
    host: env.AUTH_SMTP_HOST || env.AUTH_IMAP_HOST || '',
    port: parseInt(env.AUTH_SMTP_PORT, 10) || 465,
    security: env.AUTH_SMTP_SECURITY || '', // leer = automatisch nach Port (465 SSL, 587/25 STARTTLS)
  },
  authAllowInsecureTls: env.AUTH_ALLOW_INSECURE_TLS === 'true',
  authDefaultDomain: (env.AUTH_DEFAULT_DOMAIN || '').toLowerCase().replace(/^@/, ''),
  authAdmins: (env.AUTH_ADMINS || '').toLowerCase().split(/[,\s]+/).filter(Boolean),
  authCreateAccount: env.AUTH_CREATE_ACCOUNT !== 'false',
  // Optional: CalDAV/CardDAV-Server, der beim IMAP-Login mit denselben Zugangsdaten eingebunden wird
  authDavUrl: env.AUTH_DAV_URL || '',
  authDavName: env.AUTH_DAV_NAME || 'Kalender & Kontakte',
  maxBodyMb: parseInt(env.MAX_UPLOAD_MB, 10) || 35,
  passwordMinLength: parseInt(env.PASSWORD_MIN_LENGTH, 10) || 8,

  // Öffentliche Adresse der Webmail (für Links in E-Mails, z. B. https://mail.example.com)
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // LDAP: Passwort ändern / zurücksetzen
  ldap: {
    url: env.LDAP_URL || '',
    startTls: env.LDAP_STARTTLS === 'true',
    tlsInsecure: env.LDAP_TLS_INSECURE === 'true',
    bindDn: env.LDAP_BIND_DN || '',
    bindPassword: env.LDAP_BIND_PASSWORD || '',
    baseDn: env.LDAP_BASE_DN || '',
    userFilter: env.LDAP_USER_FILTER || '(|(uid={user})(mail={user}))',
    userDnTemplate: env.LDAP_USER_DN_TEMPLATE || '',
    mailAttr: env.LDAP_MAIL_ATTR || 'mail',
    recoveryAttrs: (env.LDAP_RECOVERY_ATTRS || 'mailAlternateAddress').split(/[,\s]+/).filter(Boolean),
    recoveryFallbackPrimary: env.LDAP_RECOVERY_FALLBACK_PRIMARY === 'true',
    passwordMethod: ['exop', 'ssha', 'plain', 'ad'].includes(env.LDAP_PASSWORD_METHOD) ? env.LDAP_PASSWORD_METHOD : 'exop',
  },

  // Systemmails (Passwort vergessen)
  systemSmtp: {
    host: env.SYSTEM_SMTP_HOST || '',
    port: parseInt(env.SYSTEM_SMTP_PORT, 10) || 587,
    security: env.SYSTEM_SMTP_SECURITY || '',
    user: env.SYSTEM_SMTP_USER || '',
    password: env.SYSTEM_SMTP_PASSWORD || '',
    from: env.SYSTEM_MAIL_FROM || '',
    allowInsecureTls: env.SYSTEM_SMTP_TLS_INSECURE === 'true',
  },
  resetTokenMinutes: parseInt(env.PASSWORD_RESET_MINUTES, 10) || 30,
  // Text, der bei "Passwort vergessen" angezeigt wird, wenn kein automatischer Ablauf möglich ist
  passwordHelp: env.PASSWORD_HELP_TEXT || '',
};
