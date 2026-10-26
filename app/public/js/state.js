// Gemeinsamer Zustand der App (Benutzer, Konten, Ordner, Identitäten)
import { get } from './api.js';
import { setPhotoEmails } from './ui.js';

const subs = new Set();

export const state = {
  user: null,
  accounts: [],
  config: {},
  contactEmails: new Set(), // alle Adressen aus den Adressbüchern (kleingeschrieben)
};

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function notify(what) {
  for (const fn of subs) fn(what);
}

export async function loadAccounts() {
  const { accounts } = await get('/accounts');
  state.accounts = accounts;
  notify('accounts');
  return accounts;
}

export function findFolder(id) {
  id = Number(id);
  for (const a of state.accounts) {
    const f = a.folders.find((x) => x.id === id);
    if (f) return { account: a, folder: f };
  }
  return null;
}

export function specialFolder(accountId, use) {
  const a = state.accounts.find((x) => x.id === accountId);
  return a ? a.folders.find((f) => f.specialUse === use) : null;
}

export function allIdentities() {
  const out = [];
  for (const a of state.accounts) {
    for (const i of a.identities) out.push({ ...i, account: a });
  }
  return out;
}

export function defaultIdentity(accountId) {
  const ids = allIdentities();
  if (accountId) {
    const own = ids.filter((i) => i.accountId === accountId);
    return own.find((i) => i.isDefault) || own[0] || ids[0];
  }
  return ids.find((i) => i.isDefault) || ids[0];
}

/** Sucht die Identität, an die eine Nachricht adressiert war (für Antworten). */
export function identityForMessage(accountId, recipients) {
  const ids = allIdentities();
  const addrs = new Set((recipients || []).map((r) => String(r.address || '').toLowerCase()));
  return ids.find((i) => i.accountId === accountId && addrs.has(i.email.toLowerCase()))
    || ids.find((i) => addrs.has(i.email.toLowerCase()))
    || defaultIdentity(accountId);
}

export const SPECIAL_NAMES = {
  '\\Inbox': 'Posteingang',
  '\\Drafts': 'Entwürfe',
  '\\Sent': 'Gesendet',
  '\\Archive': 'Archiv',
  '\\Junk': 'Spam',
  '\\Trash': 'Papierkorb',
  '\\All': 'Alle Nachrichten',
  '\\Flagged': 'Markiert',
  '\\Important': 'Wichtig',
};

export const SPECIAL_ICONS = {
  '\\Inbox': 'inbox', '\\Drafts': 'draft', '\\Sent': 'send', '\\Archive': 'archive',
  '\\Junk': 'junk', '\\Trash': 'trash', '\\All': 'all', '\\Flagged': 'star', '\\Important': 'star',
};

export function folderLabel(f) {
  return SPECIAL_NAMES[f.specialUse] || f.name;
}

/** Kontaktadressen laden: mit Foto (Avatare) und alle bekannten (Bilder automatisch anzeigen). */
export function loadContactPhotos(bust = false) {
  return get('/contact-photos').then((r) => {
    setPhotoEmails(r.emails, { bust });
    state.contactEmails = new Set(r.known || []);
    notify('contacts');
  }).catch(() => {});
}

/** Ist die Adresse ein Kontakt im Adressbuch? */
export function isContact(address) {
  return !!address && state.contactEmails.has(String(address).trim().toLowerCase());
}

/** Externe Bilder bei Mails von Kontakten automatisch laden? (Profil-Einstellung, Standard: ja) */
export function imagesFromContacts() {
  return !state.user || !state.user.settings || state.user.settings.imagesFromContacts !== false;
}

/** Ordnerzähler (ungelesen/gesamt) übernehmen und Seitenleiste neu zeichnen. */
export function applyFolderCounts(list) {
  if (!Array.isArray(list) || !list.length) return;
  let changed = false;
  for (const c of list) {
    const f = findFolder(c.id);
    if (!f) continue;
    if (f.folder.unseen !== c.unseen || f.folder.total !== c.total) {
      f.folder.unseen = c.unseen;
      f.folder.total = c.total;
      changed = true;
    }
  }
  if (changed) notify('counts');
}

export function refreshFolderCounts() {
  return get('/folder-counts').then((r) => applyFolderCounts(r.folders)).catch(() => {});
}
