import { h, clear, icon, iconButton, toast, modal, confirmDialog, field, formValues, fullDate } from './ui.js';
import { get, post, patch, del } from './api.js';
import { state } from './state.js';

export function unmount() {}

export async function render(main) {
  if (!state.user.isAdmin) {
    clear(main, h('div', { class: 'empty-state' }, h('p', {}, 'Nur für Administratoren.')));
    return;
  }
  const c = h('div', { class: 'settings-view' }, h('div', { class: 'settings-content wide' }, h('span', { class: 'spinner' })));
  clear(main, c);
  const content = c.firstChild;
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
            try { await del(`/admin/users/${u.id}`); toast('Benutzer gelöscht'); render(main); } catch (err) { toast(err.message, 'error'); }
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
        render(main);
      } },
    ],
  });
}
