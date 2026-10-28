// Gemeinsamer Zustand der App (Benutzer, Konten, Ordner, Identitäten)
import { get, patch } from './api.js';
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
  const { accounts, customServers } = await get('/accounts');
  state.accounts = accounts;
  state.customServers = !!customServers; // dürfen eigene Mailserver eingetragen werden?
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

// ------------------------------------------------------------------ Favoriten-Ordner
// Gespeichert im Benutzerprofil (settings.favoriteFolders = [{ id, accountId, path }]) – auf allen Geräten gleich.
// Die ID ist massgebend; Konto + Pfad dienen als Rückfall, falls ein Ordner neu angelegt wurde.

function favoriteEntries() {
  const list = state.user && state.user.settings && state.user.settings.favoriteFolders;
  return Array.isArray(list) ? list.filter((x) => x && x.id) : [];
}

/** → [{ folder, account }] in der gespeicherten Reihenfolge (nicht mehr vorhandene werden ausgelassen) */
export function favoriteFolders() {
  const out = [];
  for (const e of favoriteEntries()) {
    for (const a of state.accounts) {
      const f = a.folders.find((x) => x.id === e.id) || (a.id === e.accountId ? a.folders.find((x) => x.path === e.path) : null);
      if (f && f.selectable && !out.some((o) => o.folder.id === f.id)) { out.push({ folder: f, account: a }); break; }
    }
  }
  return out;
}

export function isFavorite(folder) {
  return favoriteFolders().some((x) => x.folder.id === folder.id);
}

async function saveFavorites(list) {
  const favoriteFolders = list.map(({ folder, account }) => ({ id: folder.id, accountId: account.id, path: folder.path }));
  // sofort anzeigen, dann speichern
  state.user = { ...state.user, settings: { ...(state.user.settings || {}), favoriteFolders } };
  notify('favorites');
  const r = await patch('/me', { settings: { favoriteFolders } });
  state.user = r.user;
}

export function toggleFavorite(folder, account) {
  const list = favoriteFolders();
  const i = list.findIndex((x) => x.folder.id === folder.id);
  if (i >= 0) list.splice(i, 1); else list.push({ folder, account });
  return saveFavorites(list);
}

/** Favorit in der Reihenfolge verschieben (dir: -1 nach oben, +1 nach unten) */
export function moveFavorite(folder, dir) {
  const list = favoriteFolders();
  const i = list.findIndex((x) => x.folder.id === folder.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return Promise.resolve();
  [list[i], list[j]] = [list[j], list[i]];
  return saveFavorites(list);
}

// ------------------------------------------------------------------ Kontakte: Sortierung und Anzeige
/** 'first' = „Vorname Nachname“ (Standard), 'last' = „Nachname, Vorname“ */
export function contactSortMode() {
  return state.user && state.user.settings && state.user.settings.contactSort === 'last' ? 'last' : 'first';
}

/** Anzeigename eines Kontakts gemäss Einstellung (ohne Vor-/Nachname: wie gespeichert, z. B. Firma) */
export function contactDisplayName(c, mode = contactSortMode()) {
  const first = String(c.firstName || '').trim();
  const last = String(c.lastName || '').trim();
  if (mode === 'last' && last) return first ? `${last}, ${first}` : last;
  return c.fn || [first, last].filter(Boolean).join(' ') || c.org || '';
}

const contactCollator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
/** Vergleichsfunktion für Kontakte gemäss Einstellung */
export function compareContacts(mode = contactSortMode()) {
  return (a, b) => contactCollator.compare(contactDisplayName(a, mode), contactDisplayName(b, mode))
    || contactCollator.compare(a.fn || '', b.fn || '');
}
