import { h, clear, icon, iconButton, toast, modal, confirmDialog, field, formValues, fullDate } from './ui.js';
import { get, post, put, patch, del } from './api.js';
import { state } from './state.js';

export function unmount() {}

export async function render(main, route) {
  if (!state.user.isAdmin) {
    clear(main, h('div', { class: 'empty-state' }, h('p', {}, 'Nur für Administratoren.')));
    return;
  }
  const section = (route && route.parts && route.parts[1]) || 'users';
  const content = h('div', { class: 'settings-content wide' }, h('span', { class: 'spinner' }));
  const c = h('div', { class: 'settings-view' },
    h('nav', { class: 'settings-tabs' },
      h('a', { href: '#/admin', class: section === 'users' ? 'active' : '' }, 'Benutzer'),
      h('a', { href: '#/admin/domains', class: section === 'domains' ? 'active' : '' }, 'Domains & Mailserver'),
      h('a', { href: '#/admin/security', class: section === 'security' ? 'active' : '' }, 'Sicherheit')),
    content);
  clear(main, c);
  if (section === 'domains') { await domainsSection(main, content); return; }
  if (section === 'security') { await securitySection(main, content); return; }
  let users;
  try {
    users = (await get('/admin/users')).users;
  } catch (err) {
    clear(content, h('div', { class: 'banner banner-error' }, err.message));
    return;
  }
  clear(content,
    h('div', { class: 'section-head' }, h('h2', {}, 'Benutzerverwaltung'),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => userDialog(main, null) }, icon('plus', 16), 'Benutzer anlegen')),
    h('p', { class: 'muted small' }, 'Jeder Benutzer hat eigene E-Mail-Konten sowie eigene eingebundene Kalender-/Kontakte-Server.'),
    h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Benutzer'), h('th', {}, 'Name'), h('th', {}, 'Konten'),
        h('th', {}, 'Letzte Anmeldung'), h('th', {}, 'Mailbox'), h('th', {}, 'Angelegt'), h('th', {}, ''))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, h('strong', {}, u.username), u.is_admin ? h('span', { class: 'chip' }, 'Admin') : null,
          u.auth_source === 'imap' ? h('span', { class: 'chip', title: 'Meldet sich mit den Zugangsdaten des Mailservers an' }, 'IMAP') : null),
        h('td', {}, u.display_name),
        h('td', {}, String(u.accounts)),
        h('td', { class: 'small nowrap', title: u.last_seen_at ? `Zuletzt aktiv: ${dateTime(u.last_seen_at)}` : '' },
          u.last_login_at ? relDate(u.last_login_at) : h('span', { class: 'muted' }, 'noch nie')),
        h('td', { class: 'small' }, mailboxCell(u.mailboxes || [])),
        h('td', { class: 'muted small nowrap', title: fullDate(u.created_at) }, dateTime(u.created_at).slice(0, 10)),
        h('td', { class: 'row-actions' },
          iconButton('edit', 'Bearbeiten', () => userDialog(main, u)),
          u.id !== state.user.id ? iconButton('trash', 'Löschen', async () => {
            if (!(await confirmDialog('Benutzer löschen', `„${u.username}“ mit allen Einstellungen aus Webmail entfernen? Mails, Kalender und Kontakte auf den Servern bleiben erhalten.`, { confirmLabel: 'Löschen' }))) return;
            try { await del(`/admin/users/${u.id}`); toast('Benutzer gelöscht'); render(main, { parts: ['admin'] }); } catch (err) { toast(err.message, 'error'); }
          }) : null))))));
}

const pad = (n) => String(n).padStart(2, '0');
function dateTime(d) {
  const x = new Date(d);
  return `${pad(x.getDate())}.${pad(x.getMonth() + 1)}.${x.getFullYear()} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
function relDate(d) {
  const x = new Date(d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(x); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  const t = `${pad(x.getHours())}:${pad(x.getMinutes())}`;
  const label = diff === 0 ? `heute ${t}` : diff === 1 ? `gestern ${t}` : dateTime(x);
  return h('span', { title: dateTime(x) }, label);
}

/** Bytes lesbar (de-CH): 1,2 GB */
function bytes(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('de-CH', { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

function mailboxCell(boxes) {
  const known = boxes.filter((b) => b.used !== null && b.used !== undefined);
  if (!boxes.length) return h('span', { class: 'muted' }, '–');
  if (!known.length) return h('span', { class: 'muted', title: 'Wird bei der nächsten Synchronisation ermittelt' }, 'wird ermittelt …');
  const used = known.reduce((a, b) => a + Number(b.used), 0);
  const withLimit = known.filter((b) => b.limit);
  const limit = withLimit.length === known.length ? withLimit.reduce((a, b) => a + Number(b.limit), 0) : 0;
  const estimated = known.some((b) => b.source === 'estimate');
  const tip = boxes.map((b) => `${b.name} (${b.email}): ${b.used === null || b.used === undefined ? 'noch nicht ermittelt'
    : `${b.source === 'estimate' ? 'ca. ' : ''}${bytes(b.used)}${b.limit ? ` von ${bytes(b.limit)}` : ''}`}`).join('\n')
    + (estimated ? '\n\n„ca.“ = geschätzt: Der Mailserver meldet keine Quota, Wert aus den synchronisierten Nachrichten hochgerechnet.' : '');
  const pct = limit ? Math.min(100, Math.round(used / limit * 100)) : null;
  return h('div', { class: 'mbox', title: tip },
    h('span', { class: 'nowrap' }, `${estimated ? 'ca. ' : ''}${bytes(used)}`, limit ? h('span', { class: 'muted' }, ` von ${bytes(limit)}`) : null),
    pct !== null ? h('span', { class: `mbox-bar${pct >= 90 ? ' full' : pct >= 75 ? ' warn' : ''}`, 'aria-label': `${pct} % belegt` },
      h('span', { style: { width: `${pct}%` } })) : null);
}

function userDialog(main, u) {
  const form = h('form', { class: 'form-grid' },
    !u ? field('Benutzername', h('input', { name: 'username', required: true, autocapitalize: 'none', pattern: '[a-z0-9][a-z0-9._-]{1,62}' }), 'Kleinbuchstaben, Ziffern, Punkt, Binde- und Unterstrich') : null,
    field('Anzeigename', h('input', { name: 'displayName', value: u ? u.display_name : '' })),
    u && u.auth_source === 'imap'
      ? h('p', { class: 'muted small' }, 'Passwort wird am Mailserver verwaltet.')
      : field(u ? 'Neues Passwort (leer = unverändert)' : 'Passwort (lokaler Benutzer)', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 8, required: !u })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isAdmin', checked: u ? u.is_admin : false }), ' Administrator'));
  modal({
    title: u ? `Benutzer ${u.username}` : 'Neuer Benutzer',
    body: form,
    actions: [
      { label: 'Abbrechen' },
      { label: 'Speichern', primary: true, onClick: async () => {
        const d = formValues(form);
        if (!d.password) delete d.password;
        if (u) await patch(`/admin/users/${u.id}`, d);
        else await post('/admin/users', d);
        toast('Gespeichert', 'success');
        render(main, { parts: ['admin'] });
      } },
    ],
  });
}

// ====================================================================== Domains & Mailserver

const SEC_LABEL = { ssl: 'SSL/TLS', starttls: 'STARTTLS', none: 'unverschlüsselt' };

async function domainsSection(main, content) {
  let data;
  try {
    data = await get('/admin/domains');
  } catch (err) {
    clear(content, h('div', { class: 'banner banner-error' }, err.message));
    return;
  }
  const reload = () => render(main, { parts: ['admin', 'domains'] });
  const custom = h('label', { class: 'check' }, h('input', {
    type: 'checkbox', checked: data.allowCustomServers,
    onChange: async (e) => {
      try { await put('/admin/settings', { allowCustomServers: e.target.checked }); toast('Gespeichert'); } catch (err) { toast(err.message, 'error'); }
    },
  }), ' Benutzer dürfen zusätzliche Konten bei anderen Mailservern einrichten (z. B. Gmail, GMX)');

  clear(content,
    h('div', { class: 'section-head' }, h('h2', {}, 'Domains & Mailserver'),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => domainDialog(null, reload) }, icon('plus', 16), 'Domain hinzufügen')),
    h('p', { class: 'muted small' },
      'Pro Domain sind Posteingang (IMAP) und Postausgang (SMTP) fest eingestellt. Benutzer melden sich mit ihrer E-Mail-Adresse an; '
      + 'die Domain der Adresse bestimmt den Server. „*“ gilt für alle übrigen Domains. Endbenutzer sehen diese Angaben nicht.'),
    data.domains.length ? h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Domain'), h('th', {}, 'Posteingang (IMAP)'), h('th', {}, 'Postausgang (SMTP)'),
        h('th', {}, 'Anmeldung'), h('th', {}, 'Konten'), h('th', {}, ''))),
      h('tbody', {}, data.domains.map((d) => h('tr', {},
        h('td', {}, h('strong', {}, d.isDefault ? '* (alle übrigen)' : d.domain), d.note ? h('div', { class: 'muted small' }, d.note) : null),
        h('td', { class: 'small' }, h('code', {}, `${d.imapHost}:${d.imapPort}`), h('div', { class: 'muted' }, SEC_LABEL[d.imapSecurity] || d.imapSecurity)),
        h('td', { class: 'small' }, h('code', {}, `${d.smtpHost}:${d.smtpPort}`), h('div', { class: 'muted' }, SEC_LABEL[d.smtpSecurity] || d.smtpSecurity)),
        h('td', { class: 'small' }, d.loginFormat === 'local' ? 'Teil vor dem @' : 'E-Mail-Adresse',
          d.davUrl ? h('div', { class: 'muted', title: d.davUrl }, '+ Kalender/Kontakte') : null),
        h('td', {}, String(d.accounts)),
        h('td', { class: 'row-actions' },
          iconButton('edit', 'Bearbeiten', () => domainDialog(d, reload)),
          iconButton('trash', 'Löschen', async () => {
            const warn = d.accounts ? ` ${d.accounts} Konto/Konten behalten ihre aktuellen Einstellungen, werden aber nicht mehr zentral verwaltet.` : '';
            if (!(await confirmDialog('Domain löschen', `„${d.domain}“ löschen?${warn}`, { confirmLabel: 'Löschen' }))) return;
            try { await del(`/admin/domains/${d.id}`, { force: '1' }); toast('Domain gelöscht'); reload(); } catch (err) { toast(err.message, 'error'); }
          })))))) : h('div', { class: 'banner' }, 'Noch keine Domain eingerichtet. Lege zuerst eine Domain an – z. B. „*“ für deinen Mailserver.'),
    h('h3', { style: { marginTop: '28px' } }, 'Optionen'),
    custom,
    h('p', { class: 'muted small' }, data.unassigned
      ? `${data.unassigned} Konto/Konten nutzen einen eigenen Server (nicht zentral verwaltet). Konten, deren Domain eingerichtet ist oder die auf dem Server von „*“ liegen, werden automatisch zugeordnet.`
      : 'Alle Konten werden zentral verwaltet.'),
    data.unassigned ? h('button', {
      class: 'btn', type: 'button', onClick: async () => {
        try { const r = await post('/admin/domains/assign'); toast(`${r.assigned} Konto/Konten zugeordnet`, 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Bestehende Konten jetzt zuordnen') : null);
}

// ====================================================================== Anmeldeschutz

async function securitySection(main, content) {
  let d;
  try { d = await get('/admin/security'); } catch (err) { clear(content, h('div', { class: 'banner banner-error' }, err.message)); return; }
  const reload = () => render(main, { parts: ['admin', 'security'] });
  const unblock = async (body, label) => {
    try { await post('/admin/security/unblock', body); toast(`${label} entsperrt`, 'success'); reload(); } catch (err) { toast(err.message, 'error'); }
  };
  const L = d.limits;
  const kindLabel = { login: 'Anmeldung', dav: 'Kalender/Kontakte', password: 'Passwort ändern' };
  clear(content,
    h('div', { class: 'section-head' }, h('h2', {}, 'Schutz vor Passwort-Raten'),
      h('button', { class: 'btn', type: 'button', onClick: reload }, icon('refresh', 16), 'Aktualisieren')),
    d.proxyWarning ? h('div', { class: 'banner banner-error' },
      `Alle Anfragen scheinen von ${d.yourIp} zu kommen (interne Adresse). Läuft die Webmail hinter einem Reverse-Proxy, `
      + 'muss in der .env TRUST_PROXY=true gesetzt sein – sonst würde eine Sperre alle Benutzer gleichzeitig treffen.') : null,
    h('p', { class: 'muted small' },
      `Nach ${L.perAccount} Fehlversuchen für ein Konto wird die Adresse für dieses Konto ${L.accountWindowMin} Minuten gesperrt, `
      + `nach ${L.perIp} Fehlversuchen von einer Adresse (beliebige Konten) ${L.ipWindowMin} Minuten ganz. `
      + 'Von anderen Adressen bleibt die Anmeldung möglich – ein Angreifer kann Benutzer so nicht aussperren. '
      + `Deine Adresse: ${d.yourIp}${d.whitelist ? ` · Ausgenommen: ${d.whitelist}` : ''}`),
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat' }, h('strong', {}, String(d.last24h.n)), h('span', {}, 'Fehlversuche in 24 h')),
      h('div', { class: 'stat' }, h('strong', {}, String(d.last24h.ips)), h('span', {}, 'Adressen')),
      h('div', { class: 'stat' }, h('strong', {}, String(d.locks.length)), h('span', {}, 'aktive Sperren'))),
    h('h3', {}, 'Aktive Sperren'),
    d.locks.length ? h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Adresse'), h('th', {}, 'Konto'), h('th', {}, 'Fehlversuche'), h('th', {}, 'Gesperrt bis'), h('th', {}, ''))),
      h('tbody', {}, d.locks.map((l) => h('tr', {},
        h('td', {}, h('code', {}, l.ip)),
        h('td', {}, l.kind === 'ip' ? h('span', { class: 'muted' }, `alle Konten (${l.accounts} versucht)`) : l.username),
        h('td', {}, String(l.count)),
        h('td', { class: 'nowrap' }, dateTime(l.until)),
        h('td', { class: 'row-actions' }, h('button', { class: 'btn btn-small', type: 'button',
          onClick: () => unblock(l.kind === 'ip' ? { ip: l.ip } : { ip: l.ip, username: l.username }, l.kind === 'ip' ? l.ip : l.username) }, 'Entsperren')))))) 
      : h('p', { class: 'muted' }, 'Keine Sperren.'),
    h('h3', { style: { marginTop: '24px' } }, 'Letzte Fehlversuche'),
    d.recent.length ? h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Zeit'), h('th', {}, 'Adresse'), h('th', {}, 'Konto'), h('th', {}, 'Art'))),
      h('tbody', {}, d.recent.map((f) => h('tr', {},
        h('td', { class: 'nowrap small' }, dateTime(f.at)),
        h('td', {}, h('code', {}, f.ip)),
        h('td', {}, f.username || '–'),
        h('td', { class: 'small muted' }, kindLabel[f.kind] || f.kind)))))
      : h('p', { class: 'muted' }, 'Keine Fehlversuche in den letzten zwei Tagen.'));
}

function secOptions(value) {
  return [['', 'Automatisch (nach Port)'], ['ssl', 'SSL/TLS'], ['starttls', 'STARTTLS'], ['none', 'Keine (unverschlüsselt)']]
    .map(([v, l]) => h('option', { value: v, selected: v === (value || '') }, l));
}

function domainDialog(d, done) {
  const v = d || { domain: '', imapHost: '', imapPort: 993, imapSecurity: '', smtpHost: '', smtpPort: 587, smtpSecurity: '', loginFormat: 'email', allowInsecureTls: false, davUrl: '', note: '', sievePort: 4190 };
  const result = h('div', { class: 'test-result' });
  const form = h('form', { class: 'form-grid' },
    h('div', { class: 'row2' },
      field('Domain', h('input', { name: 'domain', value: v.domain, required: true, placeholder: 'example.ch oder * für alle übrigen', autocapitalize: 'none' })),
      field('Notiz (optional)', h('input', { name: 'note', value: v.note, placeholder: 'z. B. interner Server' }))),
    h('fieldset', {}, h('legend', {}, 'Posteingang (IMAP)'),
      h('div', { class: 'row3' },
        field('Server (Name oder IP)', h('input', { name: 'imapHost', value: v.imapHost, required: true, placeholder: 'z. B. 192.168.1.23' })),
        field('Port', h('input', { name: 'imapPort', type: 'number', value: v.imapPort, min: 1, max: 65535 })),
        field('Verschlüsselung', h('select', { name: 'imapSecurity' }, secOptions(v.imapSecurity))))),
    h('fieldset', {}, h('legend', {}, 'Postausgang (SMTP)'),
      h('div', { class: 'row3' },
        field('Server (Name oder IP)', h('input', { name: 'smtpHost', value: v.smtpHost, required: true })),
        field('Port', h('input', { name: 'smtpPort', type: 'number', value: v.smtpPort, min: 1, max: 65535 })),
        field('Verschlüsselung', h('select', { name: 'smtpSecurity' }, secOptions(v.smtpSecurity))))),
    h('fieldset', {}, h('legend', {}, 'Anmeldung & Optionen'),
      field('Benutzername am Mailserver', h('select', { name: 'loginFormat' },
        h('option', { value: 'email', selected: v.loginFormat !== 'local' }, 'Vollständige E-Mail-Adresse (name@domain)'),
        h('option', { value: 'local', selected: v.loginFormat === 'local' }, 'Nur Teil vor dem @ (name)'))),
      field('Kalender & Kontakte (optional)', h('input', { name: 'davUrl', value: v.davUrl, placeholder: 'https://cloud.example.ch/remote.php/dav' }),
        'Wird beim Login automatisch mit denselben Zugangsdaten eingebunden.'),
      field('Filter & Abwesenheit (Sieve-Port)', h('input', { name: 'sievePort', type: 'number', value: v.sievePort ?? 4190, min: 0, max: 65535 }),
        'ManageSieve auf dem IMAP-Server (mailcow/Dovecot: 4190). 0 = ausgeschaltet.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'allowInsecureTls', checked: v.allowInsecureTls }), ' Ungültige/selbstsignierte Zertifikate akzeptieren (z. B. interner Server)')),
    h('fieldset', {}, h('legend', {}, 'Verbindung testen'),
      h('p', { class: 'muted small' }, 'Ohne Zugangsdaten wird nur die Erreichbarkeit geprüft. Mit einer Test-Adresse und deren Passwort zusätzlich die Anmeldung.'),
      h('div', { class: 'row2' },
        field('Test-Adresse (optional)', h('input', { name: 'testEmail', type: 'email', autocomplete: 'off' })),
        field('Passwort (optional)', h('input', { name: 'testPassword', type: 'password', autocomplete: 'new-password' }))),
      h('div', {}, h('button', {
        class: 'btn', type: 'button', onClick: async () => {
          clear(result, h('span', { class: 'spinner' }), ' Teste …');
          try {
            const r = await post('/admin/domains/test', formValues(form));
            const line = (ok, label, text) => h('div', { class: ok ? 'ok-text' : 'error-text' }, `${ok ? '✓' : '✗'} ${label}: ${text}`);
            clear(result,
              line(r.imap.ok, 'IMAP erreichbar', r.imap.ok ? `${r.imap.greeting} (${r.imap.ms} ms)` : r.imap.error),
              line(r.smtp.ok, 'SMTP erreichbar', r.smtp.ok ? `${r.smtp.greeting} (${r.smtp.ms} ms)` : r.smtp.error),
              r.login ? line(r.login.imap.ok, 'IMAP-Anmeldung', r.login.imap.ok ? `ok (${r.login.imap.folders} Ordner)` : r.login.imap.error) : null,
              r.login ? line(r.login.smtp.ok, 'SMTP-Anmeldung', r.login.smtp.ok ? 'ok' : r.login.smtp.error) : null);
          } catch (err) { clear(result, h('div', { class: 'error-text' }, err.message)); }
        },
      }, 'Verbindung testen')),
      result));
  // Port und Verschlüsselung: Standardport bei Wahl
  const pairs = { imap: { ssl: 993, starttls: 143, none: 143 }, smtp: { ssl: 465, starttls: 587, none: 25 } };
  for (const kind of ['imap', 'smtp']) {
    const sec = form.querySelector(`[name=${kind}Security]`);
    const port = form.querySelector(`[name=${kind}Port]`);
    sec.addEventListener('change', () => { if (sec.value) port.value = pairs[kind][sec.value]; });
  }
  modal({
    title: d ? `Domain ${d.isDefault ? '* (alle übrigen)' : d.domain}` : 'Neue Domain',
    body: form,
    wide: true,
    actions: [
      { label: 'Abbrechen' },
      { label: 'Speichern', primary: true, onClick: async () => {
        const body = formValues(form);
        delete body.testEmail; delete body.testPassword;
        const r = d ? await patch(`/admin/domains/${d.id}`, body) : await post('/admin/domains', body);
        const parts = [];
        if (r.updated) parts.push(`${r.updated} Konto/Konten umgestellt`);
        if (r.assigned) parts.push(`${r.assigned} bestehende(s) Konto/Konten zugeordnet`);
        toast(`Gespeichert${parts.length ? ` – ${parts.join(', ')}` : ''}`, 'success', 6000);
        done();
      } },
    ],
  });
}
