'use strict';
// LDAP-Verbindung testen:  docker compose exec app node src/tools/ldap-check.js [login]
const ldap = require('../ldap');
const { normalizeLogin } = require('../imap-auth');

(async () => {
  if (!ldap.enabled()) { console.log('LDAP ist nicht konfiguriert (LDAP_URL / LDAP_BASE_DN fehlen).'); process.exit(1); }
  const login = process.argv[2] ? normalizeLogin(process.argv[2]) : null;
  try {
    for (const line of await ldap.diagnose(login)) console.log('✓', line);
    process.exit(0);
  } catch (err) {
    console.log('✗', err.message);
    process.exit(1);
  }
})();
