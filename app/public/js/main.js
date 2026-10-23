import { h, clear, icon, iconButton, toast, avatar } from './ui.js';
import { get, post, onEvent, connectPush, disconnectPush } from './api.js';
import { state, subscribe, loadAccounts, loadContactPhotos, findFolder, folderLabel, SPECIAL_ICONS } from './state.js';
import * as mail from './mail.js';
import * as compose from './compose.js';
import * as calendar from './calendar.js';
import * as contacts from './contacts.js';
import * as settings from './settings.js';
import * as admin from './admin.js';
import * as reminders from './reminders.js';

const $ = (sel) => document.querySelector(sel);
let currentView = null;

// ====================================================================== Login

function renderLogin() {
  $('#shell').hidden = true;
  const root = $('#login');
  root.hidden = false;
  let mode = 'login';
  const err = h('p', { class: 'form-error', role: 'alert' });
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const display = h('input', { name: 'displayName', autocomplete: 'name' });
  const displayField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Anzeigename'), display);
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Anmelden');
  const switcher = state.config.allowRegistration ? h('button', {
    type: 'button', class: 'link-btn', onClick: () => {
      mode = mode === 'login' ? 'register' : 'login';
      displayField.hidden = mode === 'login';
      submit.textContent = mode === 'login' ? 'Anmelden' : 'Konto erstellen';
      switcher.textContent = mode === 'login' ? 'Neues Konto erstellen' : 'Zurück zur Anmeldung';
      pass.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    },
  }, 'Neues Konto erstellen') : null;

  const form = h('form', {
    class: 'login-card', onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        if (mode === 'register') {
          await post('/register', { username: user.value, password: pass.value, displayName: display.value });
          toast('Konto erstellt – du kannst dich jetzt anmelden', 'success');
        }
        const r = await post('/login', { username: user.value, password: pass.value });
        state.user = r.user;
        resetFolderState();
        await startApp();
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
  h('div', { class: 'login-brand' }, icon('mail', 28), h('span', {}, 'Webmail')),
  h('label', { class: 'field' }, h('span', {}, state.config.authMode === 'imap'
    ? (state.config.defaultDomain ? `E-Mail-Adresse oder Benutzername (@${state.config.defaultDomain})` : 'E-Mail-Adresse / Benutzername')
    : 'Benutzername'), user),
  state.config.authMode === 'imap' ? h('p', { class: 'muted small login-hint' }, 'Melde dich mit den Zugangsdaten deines E-Mail-Postfachs an.') : null,
  displayField,
  h('label', { class: 'field' }, h('span', {}, 'Passwort'), pass),
  err, submit, switcher,
  state.config.passwordReset ? h('button', {
    type: 'button', class: 'link-btn forgot-link', onClick: () => renderForgot(user.value),
  }, 'Passwort vergessen?') : null);
  clear(root, form);
  setTimeout(() => user.focus(), 50);
}

function loginShell() {
  $('#shell').hidden = true;
  const root = $('#login');
  root.hidden = false;
  return root;
}

function backToLogin() {
  if (location.hash.startsWith('#/reset/')) history.replaceState(null, '', location.pathname);
  renderLogin();
}

function renderForgot(prefill) {
  const root = loginShell();
  const brand = h('div', { class: 'login-brand' }, icon('mail', 28), h('span', {}, 'Webmail'));
  const back = h('button', { type: 'button', class: 'link-btn forgot-link', onClick: backToLogin }, '← Zurück zur Anmeldung');
  if (state.config.passwordReset !== 'email') {
    clear(root, h('div', { class: 'login-card' }, brand, h('h2', {}, 'Passwort vergessen'),
      h('p', { class: 'help-text' }, state.config.passwordHelp || 'Bitte wende dich an die Administration.'), back));
    return;
  }
  const err = h('p', { class: 'form-error', role: 'alert' });
  const login = h('input', { name: 'login', value: prefill || '', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Link anfordern');
  const form = h('form', {
    class: 'login-card', onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const r = await post('/password/forgot', { login: login.value });
        clear(form, brand, h('h2', {}, 'E-Mail unterwegs'), h('p', { class: 'help-text' }, r.message), back);
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  brand,
  h('h2', {}, 'Passwort vergessen'),
  h('p', { class: 'muted small' }, 'Gib deinen Benutzernamen oder deine E-Mail-Adresse ein. Du erhältst einen Link zum Festlegen eines neuen Passworts an deine hinterlegte Wiederherstellungs-Adresse.'),
  h('label', { class: 'field' }, h('span', {}, 'Benutzername / E-Mail-Adresse'), login),
  err, submit, back);
  clear(root, form);
  setTimeout(() => login.focus(), 50);
}

async function renderReset(token) {
  const root = loginShell();
  const brand = h('div', { class: 'login-brand' }, icon('mail', 28), h('span', {}, 'Webmail'));
  const back = h('button', { type: 'button', class: 'link-btn forgot-link', onClick: backToLogin }, '← Zur Anmeldung');
  let info;
  try {
    info = await get(`/password/reset/${encodeURIComponent(token)}`);
  } catch (ex) {
    clear(root, h('div', { class: 'login-card' }, brand, h('h2', {}, 'Link ungültig'), h('p', { class: 'help-text' }, ex.message),
      state.config.passwordReset === 'email' ? h('button', { class: 'btn btn-block', type: 'button', onClick: () => renderForgot('') }, 'Neuen Link anfordern') : null, back));
    return;
  }
  const min = info.minLength || 8;
  const err = h('p', { class: 'form-error', role: 'alert' });
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: min });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Passwort speichern');
  const form = h('form', {
    class: 'login-card', onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (pw1.value.length < min) { err.textContent = `Mindestens ${min} Zeichen`; return; }
      if (pw1.value !== pw2.value) { err.textContent = 'Die Passwörter stimmen nicht überein'; return; }
      submit.disabled = true;
      try {
        await post('/password/reset', { token, password: pw1.value });
        history.replaceState(null, '', location.pathname);
        clear(form, brand, h('h2', {}, 'Passwort geändert'),
          h('p', { class: 'help-text' }, 'Dein neues Passwort ist gespeichert. Denk daran, es auch in Mail-Programmen auf Handy oder Computer zu aktualisieren.'),
          h('button', { class: 'btn btn-primary btn-block', type: 'button', onClick: backToLogin }, 'Zur Anmeldung'));
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  brand,
  h('h2', {}, 'Neues Passwort festlegen'),
  h('p', { class: 'muted small' }, `Für ${info.login}`),
  h('label', { class: 'field' }, h('span', {}, `Neues Passwort (mind. ${min} Zeichen)`), pw1),
  h('label', { class: 'field' }, h('span', {}, 'Neues Passwort wiederholen'), pw2),
  err, submit, back);
  clear(root, form);
  setTimeout(() => pw1.focus(), 50);
}

function resetTokenFromHash() {
  const m = location.hash.match(/^#\/reset\/([0-9a-f]{64})$/);
  return m ? m[1] : null;
}

// ====================================================================== Shell

function renderSidebar() {
  const nav = $('#nav');
  const route = parseRoute();
  const navItem = (name, label, ic, href) => h('a', {
    href, class: `appnav-item ${route.view === name ? 'active' : ''}`, title: label, 'aria-label': label,
    'aria-current': route.view === name ? 'page' : null,
  }, icon(ic, 21), h('span', { class: 'appnav-label' }, label));
  clear(nav,
    navItem('mail', 'E-Mail', 'mail', mailHome()),
    navItem('calendar', 'Kalender', 'calendar', '#/calendar'),
    navItem('contacts', 'Kontakte', 'contacts', '#/contacts'),
    navItem('settings', 'Einstellungen', 'settings', '#/settings'),
    state.user.isAdmin ? navItem('admin', 'Benutzer', 'shield', '#/admin') : null);
  renderFolderTree();
  const name = state.user.displayName || state.user.username;
  clear($('#appbar-user'),
    h('a', { class: 'appbar-who', href: '#/settings/profile', title: `${name} (${state.user.username}) – Profil` },
      avatar(name, state.user.username, 30),
      h('span', { class: 'who-text' }, h('strong', {}, name), h('small', {}, state.user.username))),
    h('button', { class: 'icon-btn appbar-logout', type: 'button', title: 'Abmelden', 'aria-label': 'Abmelden', onClick: logout }, icon('logout', 21)));
}

function collapsedAccounts() {
  try { return new Set(JSON.parse(localStorage.getItem('wm.collapsed') || '[]')); } catch { return new Set(); }
}

const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash', '\\All'];

// Unterordner sind standardmässig zugeklappt; gemerkt werden nur die aufgeklappten
// (bis zur nächsten Anmeldung).
function expandedFolders() {
  try { return new Set(JSON.parse(localStorage.getItem('wm.expandedFolders') || '[]')); } catch { return new Set(); }
}

function resetFolderState() {
  try { localStorage.removeItem('wm.expandedFolders'); localStorage.removeItem('wm.collapsedFolders'); } catch { /* ignore */ }
}

function toggleFolder(key) {
  const c = expandedFolders();
  if (c.has(key)) c.delete(key); else c.add(key);
  localStorage.setItem('wm.expandedFolders', JSON.stringify([...c]));
  renderFolderTree();
}

/**
 * Systemordner zuerst, danach hierarchisch alphabetisch.
 * Unterordner eingeklappter Ordner werden ausgelassen; deren ungelesene
 * Nachrichten werden am eingeklappten Ordner aufsummiert.
 */
function sortFolders(account, activeFolderId) {
  const folders = account.folders;
  const byPath = new Map(folders.map((f) => [f.path, f]));
  const children = new Map();
  const roots = [];
  for (const f of folders) {
    if (f.parentPath && byPath.has(f.parentPath)) {
      if (!children.has(f.parentPath)) children.set(f.parentPath, []);
      children.get(f.parentPath).push(f);
    } else roots.push(f);
  }
  // Vorfahren des aktiven Ordners immer aufgeklappt lassen
  const forcedOpen = new Set();
  let cur = folders.find((f) => f.id === activeFolderId);
  while (cur && cur.parentPath && byPath.has(cur.parentPath)) {
    forcedOpen.add(cur.parentPath);
    cur = byPath.get(cur.parentPath);
  }
  const expanded = expandedFolders();
  const rank = (f) => {
    const i = SPECIAL_ORDER.indexOf(f.specialUse);
    return i >= 0 ? i : 100;
  };
  const cmp = (a, b) => rank(a) - rank(b) || folderLabel(a).localeCompare(folderLabel(b), 'de', { sensitivity: 'base' });
  const descendantUnread = (f) => (children.get(f.path) || []).reduce((s, c) => s + c.unseen + descendantUnread(c), 0);
  const out = [];
  const walk = (list, depth) => {
    list.sort(cmp);
    for (const f of list) {
      const key = `${account.id}:${f.path}`;
      const hasChildren = children.has(f.path);
      const open = !hasChildren || forcedOpen.has(f.path) || expanded.has(key);
      out.push({ folder: f, depth, hasChildren, open, key, hiddenUnread: open ? 0 : descendantUnread(f) });
      if (hasChildren && open) walk(children.get(f.path), depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

function renderFolderTree() {
  const tree = $('#folder-tree');
  const route = parseRoute();
  const collapsed = collapsedAccounts();
  if (!state.accounts.length) {
    clear(tree, h('div', { class: 'empty-side' },
      h('p', {}, 'Noch kein E-Mail-Konto eingerichtet.'),
      h('a', { class: 'btn btn-small', href: '#/settings/accounts/new' }, 'Konto hinzufügen')));
    return;
  }
  clear(tree, state.accounts.map((a) => {
    const isCollapsed = collapsed.has(a.id);
    const statusIcon = a.status === 'error'
      ? h('span', { class: 'acc-status error', title: a.lastError || 'Fehler' }, '!')
      : a.status === 'syncing' || a.status === 'pending' ? h('span', { class: 'acc-status syncing', title: 'Synchronisiere…' }) : null;
    const unreadTotal = a.folders.filter((f) => f.specialUse === '\\Inbox').reduce((s, f) => s + f.unseen, 0);
    const head = h('div', { class: 'acc-head' },
      h('button', {
        class: 'acc-toggle', type: 'button', 'aria-expanded': String(!isCollapsed),
        onClick: () => {
          const c = collapsedAccounts();
          if (c.has(a.id)) c.delete(a.id); else c.add(a.id);
          localStorage.setItem('wm.collapsed', JSON.stringify([...c]));
          renderFolderTree();
        },
      },
      h('span', { class: `chev ${isCollapsed ? 'closed' : ''}` }, icon('chevronDown', 14)),
      h('span', { class: 'acc-dot', style: { background: a.color } }),
      h('span', { class: 'acc-name', title: a.email }, a.name),
      isCollapsed && unreadTotal ? h('span', { class: 'badge' }, unreadTotal) : null),
      statusIcon,
      iconButton('refresh', 'Jetzt synchronisieren', async () => {
        try { await post(`/accounts/${a.id}/sync`); toast('Synchronisierung gestartet'); } catch (e) { toast(e.message, 'error'); }
      }, { class: 'tiny' }),
      iconButton('plus', 'Ordner anlegen', () => mail.createFolderDialog(a), { class: 'tiny' }));
    const activeId = route.view === 'mail' ? Number(route.folderId) : null;
    const list = isCollapsed ? null : h('ul', { class: 'folders' }, sortFolders(a, activeId).map(({ folder: f, depth, hasChildren, open, key, hiddenUnread }) => {
      const active = activeId === f.id;
      const label = folderLabel(f);
      const twisty = hasChildren
        ? h('button', {
          type: 'button', class: `twisty ${open ? '' : 'closed'}`, 'aria-expanded': String(open),
          title: open ? 'Unterordner einklappen' : 'Unterordner ausklappen',
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); toggleFolder(key); },
        }, icon('chevronDown', 13))
        : h('span', { class: 'twisty-space' });
      const unread = f.specialUse !== '\\Sent' && f.specialUse !== '\\Trash' ? f.unseen + hiddenUnread : 0;
      const pad = { paddingLeft: `${4 + depth * 14}px` };
      const li = h('li', {},
        f.selectable
          ? h('a', {
            href: `#/mail/${f.id}`,
            class: `folder ${active ? 'active' : ''} ${f.unseen ? 'has-unread' : ''}`,
            style: pad,
            dataset: { folderId: f.id },
            onContextmenu: (e) => { e.preventDefault(); mail.folderMenu(f, a, e); },
          },
          twisty,
          icon(SPECIAL_ICONS[f.specialUse] || 'folder', 16),
          h('span', { class: 'folder-name', title: f.path }, label),
          unread ? h('span', { class: `badge ${hiddenUnread && !f.unseen ? 'badge-soft' : ''}` }, unread) : null)
          : h('span', { class: 'folder disabled', style: pad },
            twisty, icon('folder', 16), h('span', { class: 'folder-name' }, label),
            hiddenUnread ? h('span', { class: 'badge badge-soft' }, hiddenUnread) : null));
      if (f.selectable) mail.makeDropTarget(li.firstChild, f);
      return li;
    }));
    return h('section', { class: 'acc' }, head, a.status === 'error' && !isCollapsed
      ? h('a', { class: 'acc-error', href: `#/settings/accounts/${a.id}` }, a.lastError || 'Verbindungsfehler') : null, list);
  }));
  updateTitle();
}

function updateTitle() {
  const unread = state.accounts.reduce((s, a) => s + a.folders.filter((f) => f.specialUse === '\\Inbox').reduce((x, f) => x + f.unseen, 0), 0);
  document.title = unread ? `(${unread}) Webmail` : 'Webmail';
}

function mailHome() {
  const last = localStorage.getItem('wm.lastFolder');
  if (last && findFolder(last)) return `#/mail/${last}`;
  for (const a of state.accounts) {
    const inbox = a.folders.find((f) => f.specialUse === '\\Inbox');
    if (inbox) return `#/mail/${inbox.id}`;
  }
  return '#/mail';
}

// ====================================================================== Routing

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = parts[0] || 'mail';
  return { view, folderId: view === 'mail' ? parts[1] : null, threadId: view === 'mail' ? parts[2] : null, parts };
}

async function route() {
  const resetToken = resetTokenFromHash();
  if (resetToken) { renderReset(resetToken); return; }
  if (!state.user) return; // abgemeldet – Login-Seite ist aktiv
  const r = parseRoute();
  document.body.classList.remove('sidebar-open');
  document.querySelectorAll('.modal-overlay, .popup-menu').forEach((x) => x.remove());
  if (r.view === 'mail' && !r.folderId) {
    const home = mailHome();
    if (home !== '#/mail') { location.replace(home); return; }
  }
  const main = $('#main');
  const views = { mail, calendar, contacts, settings, admin };
  const mod = views[r.view] || mail;
  if (currentView && currentView !== mod && currentView.unmount) currentView.unmount();
  if (currentView !== mod) clear(main);
  currentView = mod;
  renderSidebar();
  try {
    await mod.render(main, r);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ====================================================================== Push-Ereignisse

let foldersReloadTimer = null;
function scheduleAccountsReload() {
  clearTimeout(foldersReloadTimer);
  foldersReloadTimer = setTimeout(() => loadAccounts().catch(() => {}), 300);
}

function handlePush(msg) {
  if (msg.t === 'unauthorized') {
    disconnectPush();
    reminders.stop();
    state.user = null;
    renderLogin();
    return;
  }
  if (msg.t === 'connected' || msg.t === 'disconnected') {
    $('#conn').classList.toggle('offline', msg.t === 'disconnected');
    $('#conn').title = msg.t === 'connected' ? 'Live-Verbindung aktiv' : 'Keine Live-Verbindung – versuche neu zu verbinden';
    if (msg.t === 'connected') scheduleAccountsReload();
    return;
  }
  if (msg.t === 'folders' || msg.t === 'account') {
    if (msg.t === 'account') {
      const a = state.accounts.find((x) => x.id === msg.accountId);
      if (a) { a.status = msg.status; a.lastError = msg.error; renderFolderTree(); }
    }
    scheduleAccountsReload();
    return;
  }
  if (msg.t === 'folder') {
    const found = findFolder(msg.folderId);
    if (found) {
      found.folder.unseen = msg.unseen;
      found.folder.total = msg.total;
      renderFolderTree();
    } else {
      scheduleAccountsReload();
    }
    if (msg.newMessages && msg.newMessages.length) notifyNew(msg);
    mail.onFolderEvent(msg);
  }
}

function notifyNew(msg) {
  const settingsOn = state.user && state.user.settings && state.user.settings.notifications !== false;
  if (!settingsOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const first = msg.newMessages[0];
  const n = new Notification(msg.newMessages.length > 1 ? `${msg.newMessages.length} neue Nachrichten` : (first.from || 'Neue Nachricht'), {
    body: first.subject || '',
    tag: `wm-${msg.folderId}`,
  });
  n.onclick = () => { window.focus(); location.hash = `#/mail/${msg.folderId}`; n.close(); };
}

// ====================================================================== Start

async function startApp() {
  $('#login').hidden = true;
  $('#shell').hidden = false;
  await loadAccounts();
  connectPush();
  reminders.start();
  loadContactPhotos();
  route();
}

async function logout() {
  await post('/logout').catch(() => {});
  disconnectPush();
  reminders.stop();
  resetFolderState();
  state.user = null;
  state.accounts = [];
  compose.closeCompose(true);
  location.hash = '';
  renderLogin();
}

function bindGlobal() {
  window.addEventListener('hashchange', route);
  $('#btn-compose').addEventListener('click', () => compose.openCompose({}));
  $('#btn-menu').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#sidebar-backdrop').addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  subscribe((what) => { if (what === 'accounts' && state.user) renderSidebar(); });
  onEvent(handlePush);
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('.modal-overlay')) return;
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey && state.user) { e.preventDefault(); compose.openCompose({}); }
  });
}

async function boot() {
  bindGlobal();
  try { state.config = await get('/config'); } catch { state.config = {}; }
  const resetToken = resetTokenFromHash();
  if (resetToken) { renderReset(resetToken); return; }
  try {
    const r = await get('/me');
    state.user = r.user;
    await startApp();
  } catch {
    renderLogin();
  }
}

boot();
