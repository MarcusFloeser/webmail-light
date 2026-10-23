import { h, clear, icon, iconButton, toast, modal, confirmDialog, field, formValues, fullDate } from './ui.js';
import { get, post, patch, del } from './api.js';
import { state } from './state.js';

export function unmount() {}

export async function render(main) {
  if (!state.user.isAdmin) {
    clear(main, h('div', { class: 'empty-state' }, h('p', {}, 'Nur für Administratoren.')));
    return;
  }
  const c = h('div', { class: 'settings-view' }, h('div', { class: 'settings-content' }, h('span', { class: 'spinner' })));
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
      h('thead', {}, h('tr', {}, h('th', {}, 'Benutzer'), h('th', {}, 'Name'), h('th', {}, 'Konten'), h('th', {}, 'Angelegt'), h('th', {}, ''))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, h('strong', {}, u.username), u.is_admin ? h('span', { class: 'chip' }, 'Admin') : null,
          u.auth_source === 'imap' ? h('span', { class: 'chip', title: 'Meldet sich mit den Zugangsdaten des Mailservers an' }, 'IMAP') : null),
        h('td', {}, u.display_name),
        h('td', {}, String(u.accounts)),
        h('td', { class: 'muted small' }, fullDate(u.created_at)),
        h('td', { class: 'row-actions' },
          iconButton('edit', 'Bearbeiten', () => userDialog(main, u)),
          u.id !== state.user.id ? iconButton('trash', 'Löschen', async () => {
            if (!(await confirmDialog('Benutzer löschen', `„${u.username}“ mit allen Einstellungen aus Webmail entfernen? Mails, Kalender und Kontakte auf den Servern bleiben erhalten.`, { confirmLabel: 'Löschen' }))) return;
            try { await del(`/admin/users/${u.id}`); toast('Benutzer gelöscht'); render(main); } catch (err) { toast(err.message, 'error'); }
          }) : null))))));
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
