import { h, clear, icon, iconButton, toast, modal, confirmDialog, field, formValues, fullDate } from './ui.js';
import { get, post, put, patch, del } from './api.js';
import * as appearance from './appearance.js';
import { richEditor } from './richtext.js';
import { state, loadAccounts } from './state.js';
import * as reminders from './reminders.js';

const PRESETS = [
  { domains: ['gmail.com', 'googlemail.com'], name: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecurity: 'ssl', saveSent: false, hint: 'Gmail: App-Passwort verwenden (Google-Konto → Sicherheit → App-Passwörter). Gmail legt gesendete Mails selbst ab.' },
  { domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.de', 'hotmail.de'], name: 'Outlook.com', imapHost: 'outlook.office365.com', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecurity: 'starttls', saveSent: false, hint: 'Microsoft erlaubt bei vielen Konten nur noch OAuth – Passwort-Anmeldung funktioniert ggf. nicht.' },
  { domains: ['icloud.com', 'me.com', 'mac.com'], name: 'iCloud', imapHost: 'imap.mail.me.com', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecurity: 'starttls', saveSent: true, hint: 'iCloud: app-spezifisches Passwort unter appleid.apple.com erzeugen.' },
  { domains: ['gmx.ch', 'gmx.de', 'gmx.net', 'gmx.at'], name: 'GMX', imapHost: 'imap.gmx.net', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'mail.gmx.net', smtpPort: 587, smtpSecurity: 'starttls', saveSent: true, hint: 'GMX: IMAP-Zugriff in den GMX-Einstellungen aktivieren.' },
  { domains: ['web.de'], name: 'WEB.DE', imapHost: 'imap.web.de', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp.web.de', smtpPort: 587, smtpSecurity: 'starttls', saveSent: true, hint: 'WEB.DE: IMAP-Zugriff in den Einstellungen aktivieren.' },
  { domains: ['posteo.de', 'posteo.net', 'posteo.ch'], name: 'Posteo', imapHost: 'posteo.de', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'posteo.de', smtpPort: 465, smtpSecurity: 'ssl', saveSent: true },
  { domains: ['mailbox.org'], name: 'mailbox.org', imapHost: 'imap.mailbox.org', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp.mailbox.org', smtpPort: 465, smtpSecurity: 'ssl', saveSent: true },
  { domains: ['fastmail.com', 'fastmail.fm'], name: 'Fastmail', imapHost: 'imap.fastmail.com', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSecurity: 'ssl', saveSent: true, hint: 'Fastmail: App-Passwort verwenden.' },
  { domains: ['yahoo.com', 'yahoo.de', 'ymail.com'], name: 'Yahoo', imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecurity: 'ssl', saveSent: true, hint: 'Yahoo: App-Passwort verwenden.' },
  { domains: ['bluewin.ch'], name: 'Bluewin', imapHost: 'imaps.bluewin.ch', imapPort: 993, imapSecurity: 'ssl', smtpHost: 'smtpauths.bluewin.ch', smtpPort: 465, smtpSecurity: 'ssl', saveSent: true },
];

let root = null;

export function unmount() { root = null; }

export async function render(main, route) {
  const section = route.parts[1] || 'accounts';
  const tabs = [['accounts', 'E-Mail-Konten'], ['dav', 'Kalender & Kontakte'], ['appearance', 'Darstellung'], ['profile', 'Profil']];
  const content = h('div', { class: 'settings-content' });
  root = h('div', { class: 'settings-view' },
    h('nav', { class: 'settings-tabs' }, tabs.map(([k, l]) => h('a', { href: `#/settings/${k}`, class: section === k ? 'active' : '' }, l))),
    content);
  clear(main, root);
  if (section === 'accounts') {
    const sub = route.parts[2];
    if (sub === 'new') accountForm(content, null);
    else if (sub) {
      const acc = state.accounts.find((a) => a.id === Number(sub));
      if (acc) accountDetail(content, acc); else accountList(content);
    } else accountList(content);
  } else if (section === 'dav') {
    await davSection(content);
  } else if (section === 'appearance') {
    appearanceSection(content);
  } else {
    profileSection(content);
  }
}

// ====================================================================== Konten

function statusBadge(a) {
  const map = { ok: ['ok', 'verbunden'], error: ['error', 'Fehler'], syncing: ['busy', 'synchronisiert…'], pending: ['busy', 'verbinde…'] };
  const [cls, label] = map[a.status] || ['busy', a.status];
  return h('span', { class: `status-pill ${cls}`, title: a.lastError || '' }, label);
}

function accountList(c) {
  clear(c,
    h('div', { class: 'section-head' }, h('h2', {}, 'E-Mail-Konten'),
      h('a', { class: 'btn btn-primary', href: '#/settings/accounts/new' }, icon('plus', 16), 'Konto hinzufügen')),
    state.accounts.length
      ? h('div', { class: 'card-list' }, state.accounts.map((a) => h('a', { class: 'acc-card', href: `#/settings/accounts/${a.id}` },
        h('span', { class: 'acc-dot big', style: { background: a.color } }),
        h('div', { class: 'grow' },
          h('strong', {}, a.name), h('div', { class: 'muted' }, a.email),
          h('div', { class: 'muted small' }, `${a.identities.length} Identität(en) · ${a.folders.length} Ordner${a.lastSync ? ' · zuletzt ' + fullDate(a.lastSync) : ''}`),
          a.status === 'error' && a.lastError ? h('div', { class: 'error-text small' }, a.lastError) : null),
        a.enabled ? statusBadge(a) : h('span', { class: 'status-pill' }, 'deaktiviert'))))
      : h('p', { class: 'muted' }, 'Noch keine Konten. Du kannst beliebig viele IMAP-Konten hinzufügen.'));
}

function accountDetail(c, a) {
  clear(c,
    h('div', { class: 'section-head' },
      h('a', { href: '#/settings/accounts', class: 'icon-btn', title: 'Zurück' }, icon('back')),
      h('h2', {}, a.name), statusBadge(a)),
    a.lastError ? h('div', { class: 'banner banner-error' }, a.lastError) : null,
    h('h3', {}, 'Identitäten'),
    h('p', { class: 'muted small' }, 'Absender, die du mit diesem Konto verwenden kannst (z. B. Aliasse). Antworten wählen automatisch die passende Identität.'),
    h('div', { class: 'card-list' }, a.identities.map((i) => h('div', { class: 'ident-card' },
      h('div', { class: 'grow' },
        h('strong', {}, i.name || '(ohne Namen)'), ' ', h('span', { class: 'muted' }, `<${i.email}>`),
        i.isDefault ? h('span', { class: 'chip' }, 'Standard') : null,
        i.replyTo ? h('div', { class: 'muted small' }, `Antwort an: ${i.replyTo}`) : null,
        i.signature ? h('div', { class: 'muted small' }, 'mit Signatur') : null),
      iconButton('edit', 'Bearbeiten', () => identityDialog(a, i)),
      a.identities.length > 1 ? iconButton('trash', 'Löschen', async () => {
        if (!(await confirmDialog('Identität löschen', `${i.email} entfernen?`, { confirmLabel: 'Löschen' }))) return;
        try { await del(`/identities/${i.id}`); await loadAccounts(); render(document.getElementById('main'), { parts: ['settings', 'accounts', String(a.id)] }); } catch (err) { toast(err.message, 'error'); }
      }) : null))),
    h('button', { class: 'btn', type: 'button', onClick: () => identityDialog(a, null) }, icon('plus', 16), 'Identität hinzufügen'),
    h('h3', {}, a.managed ? 'Konto-Einstellungen' : 'Server-Einstellungen'));
  accountForm(c, a, true);
}

function presetFor(email) {
  const domain = String(email || '').split('@')[1];
  if (!domain) return null;
  return PRESETS.find((p) => p.domains.includes(domain.toLowerCase()))
    || { name: domain, imapHost: `imap.${domain}`, imapPort: 993, imapSecurity: 'ssl', smtpHost: `smtp.${domain}`, smtpPort: 465, smtpSecurity: 'ssl', saveSent: true, guessed: true };
}

function secSelect(name, value) {
  return h('select', { name }, [['ssl', 'SSL/TLS'], ['starttls', 'STARTTLS'], ['none', 'Keine (unsicher)']]
    .map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function accountForm(c, a, append = false) {
  const isNew = !a;
  // Verwaltet = Server aus der zentralen Domain-Konfiguration (für Endbenutzer unsichtbar)
  let managed = a ? !!a.managed : !state.customServers;
  const v = a || { name: '', email: '', imapHost: '', imapPort: 993, imapSecurity: 'ssl', imapUser: '', smtpHost: '', smtpPort: 465, smtpSecurity: 'ssl', smtpUser: '', smtpSameCredentials: true, allowInsecureTls: false, saveSent: true, enabled: true, color: '#3b6fd8' };
  const hint = h('div', { class: 'hint-box', hidden: true });
  const result = h('div', { class: 'test-result' });
  const smtpCreds = h('div', { class: 'row2', hidden: v.smtpSameCredentials });

  const isAdmin = state.user && state.user.isAdmin;
  const managedInfo = h('div', { class: 'info-card managed-info' },
    h('strong', {}, 'Mailserver wird zentral verwaltet'),
    h('p', { class: 'muted small' }, 'Die Verbindung zum Mailserver (Adresse, Port, Verschlüsselung) stellt der Administrator ein. Du brauchst nur deine E-Mail-Adresse und dein Passwort.'),
    isAdmin && a && a.imapHost ? h('p', { class: 'small' },
      `IMAP ${a.imapHost}:${a.imapPort} (${a.imapSecurity}) · SMTP ${a.smtpHost}:${a.smtpPort} (${a.smtpSecurity}) · Login ${a.imapUser} – `,
      h('a', { href: '#/admin/domains' }, 'Domains verwalten')) : null);
  // Neues Konto bei erlaubten eigenen Servern: wählbar
  const ownServer = isNew && state.customServers ? h('label', { class: 'check own-server' }, h('input', {
    type: 'checkbox', name: 'ownServer',
    onChange: (e) => { managed = !e.target.checked; applyManaged(); },
  }), ' Eigenen Mailserver eintragen (z. B. Gmail, GMX) – sonst wird der zentral eingestellte Server verwendet') : null;
  if (isNew && state.customServers) managed = true;

  const form = h('form', { class: 'form-grid account-form', autocomplete: 'off' },
    isNew ? h('div', { class: 'section-head' }, h('a', { href: '#/settings/accounts', class: 'icon-btn', title: 'Zurück' }, icon('back')), h('h2', {}, 'Neues E-Mail-Konto')) : null,
    h('div', { class: 'row2' },
      field('E-Mail-Adresse', h('input', { name: 'email', type: 'email', value: v.email, required: true, autocomplete: 'off', readonly: !isNew && !!v.managed, title: !isNew && v.managed ? 'Die Adresse eines zentral verwalteten Kontos ist fest' : '' })),
      field('Kontoname', h('input', { name: 'name', value: v.name, placeholder: 'z. B. Privat, Arbeit' }))),
    isNew ? field('Dein Name (Absender)', h('input', { name: 'senderName', value: state.user.displayName || '' })) : null,
    h('div', { class: 'row2' },
      field(isNew ? 'Passwort' : 'Passwort (leer = unverändert)', h('input', { name: 'imapPass', type: 'password', autocomplete: 'new-password' })),
      field('Farbe', h('input', { name: 'color', type: 'color', value: v.color }))),
    hint,
    managedInfo,
    ownServer,
    h('fieldset', { class: 'srv' }, h('legend', {}, 'Posteingang (IMAP)'),
      h('div', { class: 'row3' },
        field('Server', h('input', { name: 'imapHost', value: v.imapHost, required: true })),
        field('Port', h('input', { name: 'imapPort', type: 'number', value: v.imapPort, min: 1, max: 65535 })),
        field('Verschlüsselung', secSelect('imapSecurity', v.imapSecurity))),
      field('Benutzername', h('input', { name: 'imapUser', value: v.imapUser, placeholder: 'meist die E-Mail-Adresse' }))),
    h('fieldset', { class: 'srv' }, h('legend', {}, 'Postausgang (SMTP)'),
      h('div', { class: 'row3' },
        field('Server', h('input', { name: 'smtpHost', value: v.smtpHost, required: true })),
        field('Port', h('input', { name: 'smtpPort', type: 'number', value: v.smtpPort, min: 1, max: 65535 })),
        field('Verschlüsselung', secSelect('smtpSecurity', v.smtpSecurity))),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', name: 'smtpSameCredentials', checked: v.smtpSameCredentials,
        onChange: (e) => { smtpCreds.hidden = e.target.checked; },
      }), ' Gleiche Zugangsdaten wie IMAP'),
      smtpCreds),
    h('fieldset', {}, h('legend', {}, 'Optionen'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'saveSent', checked: v.saveSent }), ' Gesendete Nachrichten im Ordner „Gesendet“ ablegen'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'enabled', checked: v.enabled }), ' Konto aktiv (synchronisieren)'),
      h('label', { class: 'check srv' }, h('input', { type: 'checkbox', name: 'allowInsecureTls', checked: v.allowInsecureTls }), ' Ungültige/selbstsignierte Zertifikate akzeptieren')),
    result,
    h('div', { class: 'form-actions' },
      !isNew ? h('button', { class: 'btn btn-danger', type: 'button', onClick: async () => {
        if (!(await confirmDialog('Konto entfernen', `„${a.name}“ aus Webmail entfernen? Die Mails auf dem Server bleiben erhalten.`, { confirmLabel: 'Entfernen' }))) return;
        try { await del(`/accounts/${a.id}`); await loadAccounts(); localStorage.removeItem('wm.lastFolder'); location.hash = '#/settings/accounts'; toast('Konto entfernt'); } catch (err) { toast(err.message, 'error'); }
      } }, 'Konto entfernen') : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onClick: () => test() }, 'Verbindung testen'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, isNew ? 'Hinzufügen' : 'Speichern')));

  // Serverfelder bei verwalteten Konten ausblenden (und nicht mitschicken)
  function applyManaged() {
    managedInfo.hidden = !managed;
    for (const el of form.querySelectorAll('.srv')) {
      el.hidden = managed;
      for (const i of el.querySelectorAll('input, select')) i.disabled = managed;
    }
  }

  smtpCreds.append(
    field('SMTP-Benutzer', h('input', { name: 'smtpUser', value: v.smtpUser })),
    field('SMTP-Passwort', h('input', { name: 'smtpPass', type: 'password', autocomplete: 'new-password', placeholder: isNew ? '' : 'leer = unverändert' })));

  // Port und Verschlüsselung zusammenhalten (993/465 = SSL/TLS, 143/587/25 = STARTTLS)
  const STD = { imap: { 993: 'ssl', 143: 'starttls' }, smtp: { 465: 'ssl', 587: 'starttls', 25: 'starttls' } };
  for (const kind of ['imap', 'smtp']) {
    const portEl = form.querySelector(`[name=${kind}Port]`);
    const secEl = form.querySelector(`[name=${kind}Security]`);
    portEl.addEventListener('change', () => {
      const std = STD[kind][Number(portEl.value)];
      if (std === 'ssl') secEl.value = 'ssl';
      else if (std === 'starttls' && secEl.value === 'ssl') secEl.value = 'starttls';
    });
    secEl.addEventListener('change', () => {
      const p = Number(portEl.value);
      if (secEl.value === 'ssl' && STD[kind][p] === 'starttls') portEl.value = kind === 'imap' ? 993 : 465;
      if (secEl.value !== 'ssl' && STD[kind][p] === 'ssl') portEl.value = kind === 'imap' ? 143 : 587;
    });
  }

  const set = (name, value) => { const el = form.querySelector(`[name="${name}"]`); if (el) { if (el.type === 'checkbox') el.checked = value; else el.value = value; } };
  applyManaged();
  if (isNew) {
    const email = form.querySelector('[name=email]');
    email.addEventListener('change', () => {
      if (managed) return; // zentral verwaltet: keine Vorschläge für Server
      const p = presetFor(email.value);
      if (!p) return;
      set('imapHost', p.imapHost); set('imapPort', p.imapPort); set('imapSecurity', p.imapSecurity);
      set('smtpHost', p.smtpHost); set('smtpPort', p.smtpPort); set('smtpSecurity', p.smtpSecurity);
      set('saveSent', p.saveSent);
      set('imapUser', email.value);
      if (!form.querySelector('[name=name]').value) set('name', p.guessed ? email.value : p.name);
      hint.hidden = !(p.hint || p.guessed);
      hint.textContent = p.hint || 'Servereinstellungen wurden geraten – bitte bei deinem Anbieter prüfen.';
    });
  }

  const payload = () => {
    const d = formValues(form);
    if (managed) {
      for (const k of ['imapHost', 'imapPort', 'imapSecurity', 'imapUser', 'smtpHost', 'smtpPort', 'smtpSecurity', 'smtpUser', 'smtpPass', 'smtpSameCredentials', 'allowInsecureTls']) delete d[k];
    }
    delete d.ownServer;
    if (a) d.id = a.id;
    return d;
  };
  const test = async () => {
    clear(result, h('span', { class: 'spinner' }), ' Teste Verbindung…');
    try {
      const r = await post('/accounts/test', payload());
      clear(result,
        h('div', { class: r.imap.ok ? 'ok-text' : 'error-text' }, r.imap.ok ? `✓ Posteingang verbunden (${r.imap.folders} Ordner)` : `✗ Posteingang: ${r.imap.error}`),
        h('div', { class: r.smtp.ok ? 'ok-text' : 'error-text' }, r.smtp.ok ? '✓ Postausgang verbunden' : `✗ Postausgang: ${r.smtp.error}`));
    } catch (err) {
      clear(result, h('div', { class: 'error-text' }, err.message));
    }
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    clear(result, h('span', { class: 'spinner' }), isNew ? ' Verbinde und lege Konto an…' : ' Speichere…');
    try {
      if (isNew) {
        const r = await post('/accounts', payload());
        await loadAccounts();
        toast('Konto hinzugefügt – Synchronisierung läuft', 'success');
        location.hash = `#/settings/accounts/${r.account.id}`;
      } else {
        await patch(`/accounts/${a.id}`, payload());
        await loadAccounts();
        toast('Gespeichert – Konto verbindet neu', 'success');
        clear(result);
      }
    } catch (err) {
      clear(result, h('div', { class: 'error-text' }, err.message));
    } finally {
      btn.disabled = false;
    }
  });
  if (append) c.appendChild(form); else clear(c, form);
}

function identityDialog(a, i) {
  const v = i || { name: state.user.displayName || '', email: '', replyTo: '', bcc: '', signature: '', isDefault: false };
  const sig = richEditor({ html: v.signature, placeholder: 'z. B. Name, Funktion, Telefon, Logo …' });
  const form = h('form', { class: 'form-grid' },
    h('div', { class: 'row2' },
      field('Name', h('input', { name: 'name', value: v.name })),
      field('E-Mail-Adresse', h('input', { name: 'email', type: 'email', value: v.email, required: true }))),
    h('div', { class: 'row2' },
      field('Antwort an (optional)', h('input', { name: 'replyTo', type: 'email', value: v.replyTo })),
      field('Immer Bcc an (optional)', h('input', { name: 'bcc', type: 'email', value: v.bcc }))),
    field('Signatur', sig.el, 'Wird beim Schreiben mit „-- “ abgetrennt unter der Nachricht eingefügt. Bilder (z. B. Logo) werden eingebettet mitgeschickt. Über </> lässt sich der HTML-Quelltext bearbeiten.'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isDefault', checked: v.isDefault }), ' Standard-Identität dieses Kontos'));
  modal({
    title: i ? 'Identität bearbeiten' : 'Neue Identität',
    wide: true,
    body: form,
    actions: [
      { label: 'Abbrechen' },
      { label: 'Speichern', primary: true, onClick: async () => {
        const d = formValues(form);
        d.signature = sig.getHtml();
        if (i) await patch(`/identities/${i.id}`, d);
        else await post(`/accounts/${a.id}/identities`, d);
        await loadAccounts();
        const fresh = state.accounts.find((x) => x.id === a.id);
        const main = document.querySelector('.settings-content');
        if (fresh && main) accountDetail(main, fresh);
        toast('Identität gespeichert', 'success');
      } },
    ],
  });
}

// ====================================================================== DAV

async function davSection(c) {
  clear(c, h('span', { class: 'spinner' }));
  let info;
  let cols = { collections: [], errors: [] };
  try {
    info = await get('/dav/sources');
    cols = await get('/dav/collections', { fresh: 1 });
  } catch (err) {
    clear(c, h('div', { class: 'banner banner-error' }, err.message));
    return;
  }
  const colRows = (sourceId) => cols.collections.filter((x) => x.sourceId === sourceId).map((x) => h('li', {},
    x.type === 'calendar' ? h('span', { class: 'cal-dot', style: { background: x.color || '#3b6fd8' } }) : icon('contacts', 14),
    ' ', x.name, ' ', h('span', { class: 'muted small' }, x.type === 'calendar' ? 'Kalender' : 'Adressbuch')));

  clear(c,
    h('div', { class: 'section-head' }, h('h2', {}, 'Kalender & Kontakte'),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => addSourceDialog(c) }, icon('plus', 16), 'Server hinzufügen')),
    h('p', { class: 'muted small' }, 'Webmail zeigt und bearbeitet Kalender und Kontakte direkt auf deinem CalDAV/CardDAV-Server – z. B. Nextcloud, mailcow/SOGo, Radicale, Baïkal, mailbox.org, Fastmail oder iCloud (mit App-Passwort). Die Daten bleiben dort und sind weiterhin mit Handy und Thunderbird synchron.'),
    cols.errors.map((e) => h('div', { class: 'banner banner-error' }, `${e.sourceName}: ${e.message}`)),
    info.sources.length ? h('div', { class: 'card-list' }, info.sources.map((s) => h('div', { class: 'ident-card' },
      h('div', { class: 'grow' }, h('strong', {}, s.name), h('div', { class: 'muted small' }, `${s.url} · ${s.username}`),
        h('ul', { class: 'col-list' }, colRows(String(s.id)))),
      iconButton('trash', 'Entfernen', async () => {
        if (!(await confirmDialog('Server entfernen', `„${s.name}“ entfernen? Die Daten auf dem Server bleiben erhalten.`, { confirmLabel: 'Entfernen' }))) return;
        await del(`/dav/sources/${s.id}`);
        davSection(c);
      })))) : h('div', { class: 'info-card' }, h('p', {}, 'Noch kein Server eingebunden.'),
      h('button', { class: 'btn', type: 'button', onClick: () => addSourceDialog(c) }, icon('plus', 16), 'Server hinzufügen')));
}

function addSourceDialog(c) {
  const form = h('form', { class: 'form-grid' },
    field('Name', h('input', { name: 'name', placeholder: 'z. B. Nextcloud' })),
    field('URL', h('input', { name: 'url', type: 'url', required: true, placeholder: 'https://cloud.example.com/remote.php/dav' }),
      'Kalender und Adressbücher werden automatisch gefunden. Beispiele: Nextcloud https://cloud.example.com/remote.php/dav · mailcow/SOGo https://mail.example.com/SOGo/dav · Radicale/Baïkal: Basis-URL des Servers'),
    h('div', { class: 'row2' },
      field('Benutzername', h('input', { name: 'username', autocomplete: 'off' })),
      field('Passwort', h('input', { name: 'password', type: 'password', autocomplete: 'new-password' }))));
  modal({
    title: 'CalDAV/CardDAV-Server hinzufügen',
    wide: true,
    body: form,
    actions: [
      { label: 'Abbrechen' },
      { label: 'Verbinden', primary: true, onClick: async () => {
        const r = await post('/dav/sources', formValues(form));
        toast(`${r.found} Kalender/Adressbücher gefunden`, 'success');
        davSection(c);
      } },
    ],
  });
}

// ====================================================================== Profil

function profileSection(c) {
  const nameForm = h('form', { class: 'form-grid narrow' },
    field('Anzeigename', h('input', { name: 'displayName', value: state.user.displayName || '' })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Speichern')));
  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await patch('/me', formValues(nameForm));
      state.user = r.user;
      toast('Gespeichert', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  const pwForm = h('form', { class: 'form-grid narrow' },
    field('Aktuelles Passwort', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
    field(`Neues Passwort (mind. ${state.config.passwordMinLength || 8} Zeichen)`, h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: state.config.passwordMinLength || 8 })),
    field('Neues Passwort wiederholen', h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', required: true })),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Passwort ändern')));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formValues(pwForm);
    if (d.password !== d.password2) { toast('Die Passwörter stimmen nicht überein', 'error'); return; }
    try {
      await post('/me/password', d);
      pwForm.reset();
      toast('Passwort geändert – andere Sitzungen wurden abgemeldet. Denk an deine CalDAV/CardDAV-Programme.', 'success', 7000);
    } catch (err) { toast(err.message, 'error'); }
  });

  const replySel = h('select', {},
    [['original', 'Im Ordner der beantworteten Nachricht'],
      ['original_noinbox', 'Im Ordner der beantworteten Nachricht – ausser Posteingang (dann „Gesendet“)'],
      ['sent', 'Immer im Ordner „Gesendet“']]
      .map(([v, l]) => h('option', { value: v, selected: (state.user.settings.replyFolder || 'original') === v }, l)));
  replySel.addEventListener('change', async () => {
    const r = await patch('/me', { settings: { replyFolder: replySel.value } });
    state.user = r.user;
    toast('Gespeichert');
  });
  const imgContacts = h('label', { class: 'check' }, h('input', {
    type: 'checkbox', checked: state.user.settings.imagesFromContacts !== false,
    onChange: async (e) => {
      const r = await patch('/me', { settings: { imagesFromContacts: e.target.checked } });
      state.user = r.user;
      toast('Gespeichert');
    },
  }), ' Externe Bilder in Nachrichten von Absendern aus meinen Kontakten automatisch anzeigen');
  let trustedCount = 0;
  try { trustedCount = JSON.parse(localStorage.getItem('wm.trusted') || '[]').length; } catch { /* leer */ }
  const trustedInfo = trustedCount ? h('p', { class: 'muted small' },
    `Zusätzlich ${trustedCount === 1 ? 'ist 1 Absender' : `sind ${trustedCount} Absender`} über „Immer von …“ freigegeben (in diesem Browser). `,
    h('button', {
      class: 'link-btn', type: 'button', onClick: (e) => {
        try { localStorage.removeItem('wm.trusted'); } catch { /* egal */ }
        e.target.parentNode.remove();
        toast('Freigaben zurückgesetzt');
      },
    }, 'Zurücksetzen')) : null;
  const mailPrefs = h('div', { class: 'form-grid narrow' },
    field('Antworten ablegen', replySel, 'Gilt für „Antworten“ und „Allen antworten“. Antworten auf Nachrichten aus Gesendet, Papierkorb oder Spam landen immer in „Gesendet“.'),
    imgContacts,
    trustedInfo);

  const notifOn = state.user.settings.notifications !== false;
  const remCfg = reminders.settings();
  const remDefault = h('select', { disabled: !remCfg.enabled },
    h('option', { value: 'none', selected: remCfg.defaultMinutes === null }, 'Keine'),
    reminders.REMINDER_OPTIONS.map(([m, l]) => h('option', { value: String(m), selected: remCfg.defaultMinutes === m }, l)));
  remDefault.addEventListener('change', async () => {
    const v = remDefault.value === 'none' ? null : Number(remDefault.value);
    const r = await patch('/me', { settings: { reminderDefault: v } });
    state.user = r.user;
    reminders.reschedule();
    toast('Gespeichert');
  });
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const notif = h('div', { class: 'form-grid narrow' },
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: notifOn,
      onChange: async (e) => {
        const r = await patch('/me', { settings: { notifications: e.target.checked } });
        state.user = r.user;
        if (e.target.checked && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      },
    }), ' Desktop-Benachrichtigung bei neuen Nachrichten im Posteingang'),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: remCfg.enabled,
      onChange: async (e) => {
        const r = await patch('/me', { settings: { reminders: e.target.checked } });
        state.user = r.user;
        remDefault.disabled = !e.target.checked;
        if (e.target.checked && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
        reminders.reschedule();
      },
    }), ' Erinnerung an anstehende Kalendertermine'),
    field('Standard-Erinnerung (für Termine ohne eigene Erinnerung)', remDefault,
      'Ganztägige Termine: um 09:00 Uhr am Tag selbst. Erinnerungen kommen, solange ein Webmail-Tab geöffnet ist.'),
    perm === 'default' ? h('button', { class: 'btn', type: 'button', onClick: async () => { await Notification.requestPermission(); profileSection(c); } }, 'Browser-Berechtigung erteilen') : null,
    perm === 'denied' ? h('p', { class: 'muted small' }, 'Benachrichtigungen sind im Browser blockiert – in den Website-Einstellungen des Browsers erlauben. Erinnerungen erscheinen bis dahin nur in der Seite.') : null,
    perm === 'unsupported' ? h('p', { class: 'muted small' }, 'Dieser Browser unterstützt keine Benachrichtigungen.') : null);

  clear(c,
    h('div', { class: 'section-head' }, h('h2', {}, 'Profil')),
    h('p', { class: 'muted' }, `Angemeldet als ${state.user.username}${state.user.isAdmin ? ' (Administrator)' : ''}`),
    nameForm,
    h('h3', {}, 'E-Mail'), mailPrefs,
    h('h3', {}, 'Benachrichtigungen'), notif,
    h('h3', {}, 'Passwort ändern'),
    state.user.authSource === 'imap' && !state.config.ldapPasswordChange
      ? h('p', { class: 'muted' }, 'Du meldest dich mit dem Passwort deines Mailservers an. Ändere es dort – beim nächsten Login übernimmt Webmail das neue Passwort automatisch für dein Postfach.')
      : [state.user.authSource === 'imap'
        ? h('p', { class: 'muted small' }, 'Das Passwort wird im zentralen Verzeichnis (LDAP) geändert und gilt danach für E-Mail, Webmail und alle angebundenen Dienste. Aktualisiere es anschliessend auch in Mail-Programmen auf Handy und Computer.')
        : null, pwForm],
    h('h3', {}, 'Tastenkürzel'),
    h('table', { class: 'shortcuts' }, [
      ['c', 'Neue Nachricht'], ['j / k', 'Nächste / vorherige Konversation'], ['r', 'Antworten'], ['a', 'Allen antworten'],
      ['f', 'Weiterleiten'], ['e', 'Archivieren'], ['# / Entf', 'Löschen'], ['s', 'Markieren'], ['u', 'Als ungelesen markieren'],
      ['v', 'Verschieben'], ['/', 'Suchen'], ['Strg+Enter', 'Senden (im Editor)'],
    ].map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))));
}

// ====================================================================== Darstellung

function appearanceSection(c) {
  let cfg = appearance.normalize(state.user.settings.appearance);
  let saveTimer = null;

  const save = (immediate = false) => {
    clearTimeout(saveTimer);
    const run = async () => {
      try {
        const r = await patch('/me', { settings: { appearance: { color: cfg.color, veil: cfg.veil, image: cfg.image, listGlass: cfg.listGlass, theme: cfg.theme } } });
        state.user = r.user;
      } catch (err) { toast(err.message, 'error'); }
    };
    if (immediate) run(); else saveTimer = setTimeout(run, 400);
  };
  const update = (changes, immediate) => {
    cfg = { ...cfg, ...changes };
    appearance.apply(cfg);
    render();
    save(immediate);
  };

  const fileInput = h('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp,image/*', hidden: true,
    onChange: async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        toast('Bild wird hochgeladen …');
        const img = await appearance.prepareImage(file);
        const r = await put('/me/background', { dataUrl: img.dataUrl, luminance: img.luminance });
        state.user = r.user;
        cfg = appearance.normalize(r.user.settings.appearance);
        appearance.apply(cfg);
        render();
        toast('Hintergrundbild gespeichert', 'success');
      } catch (err) { toast(err.message, 'error'); }
    },
  });

  const themeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Farbschema' });
  const renderTheme = () => clear(themeSeg, ...[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, l]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(cfg.theme === k), class: cfg.theme === k ? 'on' : '',
    onClick: () => { update({ theme: k }, true); renderTheme(); },
  }, l)));
  renderTheme();

  const swatchRow = h('div', { class: 'swatches' });
  const colorPick = h('input', {
    type: 'color', value: cfg.color || '#e8edf5', title: 'Eigene Farbe wählen',
    onInput: (e) => { cfg = { ...cfg, color: e.target.value }; appearance.apply(cfg); markSwatches(); save(); },
  });
  function markSwatches() {
    for (const b of swatchRow.querySelectorAll('.swatch')) b.classList.toggle('on', (b.dataset.color || null) === cfg.color);
  }
  for (const [col, label] of appearance.PRESETS) {
    const dark = col && appearance.luminance([1, 3, 5].map((i) => parseInt(col.slice(i, i + 2), 16))) < 0.3;
    swatchRow.appendChild(h('button', {
      type: 'button', class: `swatch${col ? '' : ' default'}${dark ? ' dark' : ''}`, title: label, 'aria-label': label,
      dataset: col ? { color: col } : {}, style: col ? { background: col } : {},
      onClick: () => { if (col) colorPick.value = col; update({ color: col }, true); },
    }));
  }
  swatchRow.appendChild(h('label', { class: 'swatch-custom' }, colorPick, 'Eigene Farbe'));

  const veilOut = h('output');
  const veil = h('input', {
    type: 'range', min: '0', max: '90', step: '5', value: String(cfg.veil), 'aria-label': 'Farbschleier über dem Bild',
    onInput: (e) => { cfg = { ...cfg, veil: Number(e.target.value) }; veilOut.textContent = `${cfg.veil} %`; appearance.apply(cfg); save(); },
  });
  const imgArea = h('div');
  const preview = h('div', { class: 'appear-preview', 'aria-hidden': 'true' },
    h('div', { class: 'pv-side' }, h('div', { class: 'pv-line accent' }), h('div', { class: 'pv-line' }), h('div', { class: 'pv-line short' }), h('div', { class: 'pv-line' }), h('div', { class: 'pv-line short' })),
    h('div', { class: 'pv-panel' }, h('div', { class: 'pv-line' }), h('div', { class: 'pv-line short' }), h('div', { class: 'pv-line' })));

  function render() {
    markSwatches();
    veilOut.textContent = `${cfg.veil} %`;
    veil.value = String(cfg.veil);
    const thumb = h('div', { class: 'appear-thumb', style: cfg.image ? { backgroundImage: `url("/api/me/background?v=${encodeURIComponent(cfg.image.v)}")` } : {} },
      cfg.image ? null : icon('image', 24));
    clear(imgArea,
      h('div', { class: 'appear-img-row' }, thumb,
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onClick: () => fileInput.click() }, icon('image', 16), cfg.image ? 'Anderes Bild wählen …' : 'Bild wählen …'),
          cfg.image ? h('button', {
            class: 'btn btn-danger', type: 'button', onClick: async () => {
              try {
                const r = await del('/me/background');
                state.user = r.user;
                cfg = appearance.normalize(r.user.settings.appearance);
                appearance.apply(cfg);
                render();
                toast('Hintergrundbild entfernt');
              } catch (err) { toast(err.message, 'error'); }
            },
          }, icon('trash', 16), 'Entfernen') : null)),
      h('p', { class: 'muted small' }, 'JPEG, PNG oder WebP. Grosse Bilder werden automatisch verkleinert (max. 2560 px). Das Bild ist nur für dich sichtbar.'),
      cfg.image ? field('Farbschleier über dem Bild', h('div', { class: 'veil-row' }, veil, veilOut),
        'Legt die gewählte Hintergrundfarbe halbtransparent über das Bild – höhere Werte machen Ordner und Termine besser lesbar.') : null);
  }

  render();
  clear(c,
    h('div', { class: 'section-head' }, h('h2', {}, 'Darstellung')),
    preview,
    h('h3', {}, 'Farbschema'),
    themeSeg,
    h('p', { class: 'muted small' }, '„Automatisch“ folgt der Einstellung deines Geräts (hell oder dunkel). „Hell“ bzw. „Dunkel“ gilt unabhängig davon.'),
    h('h3', { style: { marginTop: '28px' } }, 'Hintergrundfarbe'),
    swatchRow,
    h('p', { class: 'muted small' }, 'Die Farbe erscheint hinter Ordnerliste, Lesebereich und Terminspalte. Schrift wird automatisch hell oder dunkel gesetzt. Die Farbe wird genau so verwendet, wie du sie wählst – auch im dunklen Farbschema.'),
    h('h3', { style: { marginTop: '28px' } }, 'Hintergrundbild'),
    imgArea,
    h('h3', { style: { marginTop: '28px' } }, 'Mail-Liste, Kontakte, Kalender'),
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: cfg.listGlass,
      onChange: (e) => update({ listGlass: e.target.checked }, true),
    }), ' Auch Mail-Liste, Kontakte und Kalender in der gewählten Farbe darstellen'),
    fileInput,
    h('p', { class: 'muted small', style: { marginTop: '24px' } }, 'Die Einstellungen gelten für dein Benutzerkonto – auf allen Geräten und in allen Browsern.'),
    h('p', { class: 'muted small', style: { wordBreak: 'break-all' } }, `Browser: ${navigator.userAgent}`));
}
