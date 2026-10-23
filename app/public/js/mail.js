import {
  h, clear, icon, iconButton, toast, modal, confirmDialog, promptDialog, shortDate, fullDate,
  fileSize, formatAddress, avatar, debounce, esc,
} from './ui.js';
import { get, post, patch, del } from './api.js';
import { state, findFolder, folderLabel, loadAccounts, SPECIAL_ICONS } from './state.js';
import * as compose from './compose.js';

const PAGE = 50;

let root = null;
let els = {};
const cur = {
  folderId: null,
  threadId: null,
  threads: [],
  hasMore: false,
  canLoadOlder: false,
  q: '',
  filter: 'all',
  selected: new Set(),
  thread: null,
  loading: false,
};
const bodyCache = new Map();
const expanded = new Set();
let keyHandler = null;

// ====================================================================== Mount / Render

export function unmount() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  root = null;
  cur.folderId = null;
  cur.threadId = null;
}

export async function render(main, route) {
  if (!state.accounts.length) {
    clear(main, h('div', { class: 'empty-state' },
      icon('mail', 48),
      h('h2', {}, 'Willkommen!'),
      h('p', {}, 'Füge dein erstes E-Mail-Konto hinzu, um loszulegen.'),
      h('a', { class: 'btn btn-primary', href: '#/settings/accounts/new' }, 'E-Mail-Konto hinzufügen')));
    root = null;
    return;
  }
  if (!root || !main.contains(root)) mountLayout(main);

  const folderId = Number(route.folderId);
  const threadId = route.threadId ? Number(route.threadId) : null;
  const found = findFolder(folderId);
  if (!found) {
    clear(els.list, h('div', { class: 'empty-list' }, 'Ordner nicht gefunden.'));
    return;
  }
  localStorage.setItem('wm.lastFolder', String(folderId));

  if (cur.folderId !== folderId) {
    cur.folderId = folderId;
    cur.selected.clear();
    cur.q = '';
    els.search.value = '';
    cur.filter = 'all';
    renderListHead();
    await loadThreads(false);
  }
  if (threadId !== cur.threadId) {
    cur.threadId = threadId;
    root.classList.toggle('reading', !!threadId);
    highlightActive();
    if (threadId) await openThread(threadId);
    else renderReaderEmpty();
  }
}

function mountLayout(main) {
  els = {};
  els.title = h('h1', { class: 'list-title' });
  els.count = h('span', { class: 'list-count' });
  els.search = h('input', {
    type: 'search', placeholder: 'Suchen…', class: 'search-input', 'aria-label': 'Nachrichten durchsuchen',
    onInput: debounce(() => { cur.q = els.search.value.trim(); loadThreads(false); }, 300),
  });
  els.filters = h('div', { class: 'seg', role: 'tablist' });
  els.bulk = h('div', { class: 'bulk-bar', hidden: true });
  els.list = h('ul', { class: 'thread-list', role: 'listbox', 'aria-label': 'Konversationen' });
  els.foot = h('div', { class: 'list-foot' });
  els.reader = h('div', { class: 'reader', tabindex: '-1' });

  const listPane = h('section', { class: 'list-pane' },
    h('header', { class: 'list-head' },
      h('div', { class: 'list-head-row' },
        h('div', { class: 'list-title-wrap' }, els.title, els.count),
        h('div', { class: 'list-head-actions' },
          iconButton('refresh', 'Aktualisieren', () => {
            post(`/folders/${cur.folderId}/sync`).catch((e) => toast(e.message, 'error'));
            loadThreads(true);
          }),
          iconButton('more', 'Ordner-Aktionen', (e) => {
            const f = findFolder(cur.folderId);
            if (f) folderMenu(f.folder, f.account, e);
          }))),
      h('div', { class: 'search-wrap' }, icon('search', 16), els.search),
      els.filters),
    els.bulk,
    h('div', { class: 'list-scroll' }, els.list, els.foot));

  root = h('div', { class: 'mail-view' }, listPane, h('section', { class: 'reader-pane' }, els.reader));
  clear(main, root);

  keyHandler = onKey;
  document.addEventListener('keydown', keyHandler);
}

function renderListHead() {
  const found = findFolder(cur.folderId);
  if (!found) return;
  els.title.textContent = folderLabel(found.folder);
  els.title.title = `${found.account.name} – ${found.folder.path}`;
  els.count.textContent = found.folder.unseen ? `${found.folder.unseen} ungelesen` : '';
  const mk = (key, label) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(cur.filter === key), class: cur.filter === key ? 'on' : '',
    onClick: () => { cur.filter = key; renderListHead(); loadThreads(false); },
  }, label);
  clear(els.filters, mk('all', 'Alle'), mk('unread', 'Ungelesen'), mk('flagged', 'Markiert'));
}

// ====================================================================== Thread-Liste

async function loadThreads(keep) {
  const folderId = cur.folderId;
  const limit = keep ? Math.max(PAGE, cur.threads.length) : PAGE;
  if (!keep) {
    clear(els.list, h('li', { class: 'list-loading' }, h('span', { class: 'spinner' })));
  }
  try {
    const r = await get(`/folders/${folderId}/threads`, {
      limit, offset: 0, q: cur.q, unread: cur.filter === 'unread' ? 1 : '', flagged: cur.filter === 'flagged' ? 1 : '',
    });
    if (folderId !== cur.folderId) return;
    cur.threads = r.threads;
    cur.hasMore = r.hasMore;
    cur.canLoadOlder = r.canLoadOlder;
    // Auswahl bereinigen
    const valid = new Set(r.threads.map((t) => t.threadId));
    for (const id of [...cur.selected]) if (!valid.has(id)) cur.selected.delete(id);
    renderThreads();
  } catch (err) {
    clear(els.list, h('li', { class: 'empty-list' }, err.message));
  }
}

async function loadMore() {
  const r = await get(`/folders/${cur.folderId}/threads`, {
    limit: PAGE, offset: cur.threads.length, q: cur.q,
    unread: cur.filter === 'unread' ? 1 : '', flagged: cur.filter === 'flagged' ? 1 : '',
  });
  const known = new Set(cur.threads.map((t) => t.threadId));
  cur.threads.push(...r.threads.filter((t) => !known.has(t.threadId)));
  cur.hasMore = r.hasMore;
  renderThreads();
}

function renderThreads() {
  const found = findFolder(cur.folderId);
  if (found) els.count.textContent = found.folder.unseen ? `${found.folder.unseen} ungelesen` : '';
  if (!cur.threads.length) {
    const syncing = found && !found.folder.lastSync;
    clear(els.list, h('li', { class: 'empty-list' },
      syncing ? [h('span', { class: 'spinner' }), ' Ordner wird synchronisiert…']
        : cur.q ? 'Keine Treffer.' : 'Keine Nachrichten in diesem Ordner.'));
  } else {
    clear(els.list, cur.threads.map(threadItem));
  }
  const btns = [];
  if (cur.hasMore) btns.push(h('button', { class: 'btn btn-small', onClick: () => loadMore().catch((e) => toast(e.message, 'error')) }, 'Weitere anzeigen'));
  else if (cur.canLoadOlder && !cur.q && cur.filter === 'all') {
    btns.push(h('button', {
      class: 'btn btn-small', onClick: async (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'Lade ältere Nachrichten vom Server…';
        try {
          const r = await post(`/folders/${cur.folderId}/load-older`);
          if (!r.loaded) toast('Keine älteren Nachrichten vorhanden');
          await loadThreads(true);
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Ältere Nachrichten vom Server laden'));
  }
  clear(els.foot, btns);
  renderBulk();
}

function threadItem(t) {
  const who = t.participants.join(', ');
  const checked = cur.selected.has(t.threadId);
  const cb = h('input', {
    type: 'checkbox', class: 'sel', 'aria-label': 'Auswählen', checked,
    onClick: (e) => {
      e.stopPropagation();
      if (e.currentTarget.checked) cur.selected.add(t.threadId); else cur.selected.delete(t.threadId);
      li.classList.toggle('selected', e.currentTarget.checked);
      renderBulk();
    },
  });
  const star = h('button', {
    class: `star ${t.flagged ? 'on' : ''}`, type: 'button', title: t.flagged ? 'Markierung entfernen' : 'Markieren',
    onClick: async (e) => {
      e.stopPropagation();
      t.flagged = !t.flagged;
      star.classList.toggle('on', t.flagged);
      await action(t.messageIds, t.flagged ? 'flag' : 'unflag', null, { keepList: true });
    },
  }, icon('star', 16));
  const li = h('li', {
    class: `thread ${t.unread ? 'unread' : ''} ${checked ? 'selected' : ''} ${cur.threadId === t.threadId ? 'active' : ''}`,
    role: 'option', 'aria-selected': String(cur.threadId === t.threadId),
    draggable: 'true', tabindex: '-1',
    dataset: { threadId: t.threadId },
    onClick: (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const on = !cur.selected.has(t.threadId);
        if (on) cur.selected.add(t.threadId); else cur.selected.delete(t.threadId);
        cb.checked = on;
        li.classList.toggle('selected', on);
        renderBulk();
        return;
      }
      location.hash = `#/mail/${cur.folderId}/${t.threadId}`;
    },
    onDragstart: (e) => {
      const ids = cur.selected.has(t.threadId) && cur.selected.size > 1
        ? cur.threads.filter((x) => cur.selected.has(x.threadId)).flatMap((x) => x.messageIds)
        : t.messageIds;
      e.dataTransfer.setData('application/x-wm-ids', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    },
  },
  h('div', { class: 'thread-left' }, avatar(t.fromName, t.fromAddr, 34), cb),
  h('div', { class: 'thread-main' },
    h('div', { class: 'thread-row1' },
      h('span', { class: 'thread-who' }, who || t.fromName || t.fromAddr || '(unbekannt)'),
      t.count > 1 ? h('span', { class: 'thread-count' }, t.count) : null,
      h('span', { class: 'thread-date', title: fullDate(t.date) }, shortDate(t.date))),
    h('div', { class: 'thread-row2' },
      t.answered ? h('span', { class: 'ans', title: 'Beantwortet' }, icon('reply', 13)) : null,
      h('span', { class: 'thread-subject' }, t.subject || '(kein Betreff)'),
      t.hasAttachments ? h('span', { class: 'clip', title: 'Anhang' }, icon('clip', 14)) : null,
      star),
    t.preview ? h('div', { class: 'thread-preview' }, t.preview) : null));
  return li;
}

function highlightActive() {
  if (!els.list) return;
  for (const li of els.list.querySelectorAll('.thread')) {
    const on = Number(li.dataset.threadId) === cur.threadId;
    li.classList.toggle('active', on);
    li.setAttribute('aria-selected', String(on));
  }
}

function renderBulk() {
  const n = cur.selected.size;
  els.bulk.hidden = n === 0;
  if (!n) return;
  const ids = () => cur.threads.filter((t) => cur.selected.has(t.threadId)).flatMap((t) => t.messageIds);
  const done = () => { cur.selected.clear(); };
  clear(els.bulk,
    h('span', { class: 'bulk-n' }, `${n} ausgewählt`),
    iconButton('mailOpen', 'Als gelesen markieren', async () => { await action(ids(), 'seen'); done(); }),
    iconButton('mail', 'Als ungelesen markieren', async () => { await action(ids(), 'unseen'); done(); }),
    iconButton('star', 'Markieren', async () => { await action(ids(), 'flag'); done(); }),
    iconButton('archive', 'Archivieren', async () => { await action(ids(), 'archive'); done(); }),
    iconButton('move', 'Verschieben', () => moveDialog(ids(), done)),
    iconButton('trash', 'Löschen', async () => { await action(ids(), 'delete'); done(); }),
    h('button', { class: 'link-btn', type: 'button', onClick: () => { cur.selected.clear(); renderThreads(); } }, 'Aufheben'));
}

// ====================================================================== Aktionen

async function action(ids, act, target, opts = {}) {
  if (!ids.length) return;
  const removing = ['delete', 'archive', 'move', 'spam', 'notspam'].includes(act);
  let nextHash = null;
  if (removing && !opts.keepList) {
    // Optimistisch aus der Liste nehmen und nächsten Thread öffnen
    const idSet = new Set(ids.map(Number));
    const idx = cur.threads.findIndex((t) => t.threadId === cur.threadId);
    const removed = cur.threads.filter((t) => t.messageIds.every((m) => idSet.has(Number(m))));
    if (cur.threadId && removed.some((t) => t.threadId === cur.threadId)) {
      const rest = cur.threads.filter((t) => !removed.includes(t));
      const next = rest[Math.min(idx, rest.length - 1)];
      nextHash = next && window.matchMedia('(min-width: 900px)').matches ? `#/mail/${cur.folderId}/${next.threadId}` : `#/mail/${cur.folderId}`;
    }
    cur.threads = cur.threads.filter((t) => !removed.includes(t));
    renderThreads();
  }
  try {
    await post('/messages/actions', { ids, action: act, target });
    if (act === 'delete') toast('Gelöscht');
    else if (act === 'archive') toast('Archiviert');
    else if (act === 'move') toast('Verschoben');
    else if (act === 'spam') toast('Als Spam markiert');
  } catch (err) {
    toast(err.message, 'error');
    loadThreads(true);
    return;
  }
  if (nextHash) location.hash = nextHash;
  if (!removing) {
    // Flags lokal spiegeln
    for (const t of cur.threads) {
      if (!t.messageIds.some((m) => ids.includes(m))) continue;
      if (act === 'seen') t.unread = false;
      if (act === 'unseen') t.unread = true;
      if (act === 'flag') t.flagged = true;
      if (act === 'unflag') t.flagged = false;
    }
    if (!opts.keepList) renderThreads();
    if (cur.thread) {
      for (const m of cur.thread.messages) {
        if (!ids.includes(m.id)) continue;
        const set = new Set(m.flags);
        if (act === 'seen') set.add('\\Seen');
        if (act === 'unseen') set.delete('\\Seen');
        if (act === 'flag') set.add('\\Flagged');
        if (act === 'unflag') set.delete('\\Flagged');
        m.flags = [...set];
      }
    }
  }
}

function currentThreadIdsInFolder() {
  const t = cur.threads.find((x) => x.threadId === cur.threadId);
  if (t) return t.messageIds;
  return cur.thread ? cur.thread.messages.filter((m) => m.folderId === cur.folderId).map((m) => m.id) : [];
}

export function moveDialog(ids, after) {
  const list = h('div', { class: 'move-list' });
  let m;
  for (const a of state.accounts) {
    list.appendChild(h('div', { class: 'move-acc' }, h('span', { class: 'acc-dot', style: { background: a.color } }), a.name));
    for (const f of a.folders.filter((x) => x.selectable && x.id !== cur.folderId)
      .sort((x, y) => folderLabel(x).localeCompare(folderLabel(y), 'de'))) {
      list.appendChild(h('button', {
        type: 'button', class: 'move-item',
        onClick: async () => { m.close(); await action(ids, 'move', f.id); if (after) after(); },
      }, icon(SPECIAL_ICONS[f.specialUse] || 'folder', 16), h('span', {}, f.parentPath ? `${f.path}` : folderLabel(f))));
    }
  }
  m = modal({ title: 'Verschieben nach…', body: list });
}

export function makeDropTarget(el, folder) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-wm-ids')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('drop');
    let ids;
    try { ids = JSON.parse(e.dataTransfer.getData('application/x-wm-ids')); } catch { return; }
    if (folder.id === cur.folderId) return;
    cur.selected.clear();
    await action(ids, 'move', folder.id);
  });
}

// ====================================================================== Ordner-Menü

export function popupMenu(e, items) {
  document.querySelectorAll('.popup-menu').forEach((x) => x.remove());
  const menu = h('div', { class: 'popup-menu', role: 'menu' }, items.filter(Boolean).map((it) => h('button', {
    type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
    onClick: () => { menu.remove(); it.onClick(); },
  }, it.label)));
  document.body.appendChild(menu);
  const rect = e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
  let x = e.clientX || (rect ? rect.left : 0);
  let y = e.clientY || (rect ? rect.bottom : 0);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  x = Math.min(x, window.innerWidth - mw - 8);
  y = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  const close = (ev) => {
    if (ev.type === 'keydown' ? ev.key === 'Escape' : !menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', close, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', close, true);
  }, 0);
}

export function folderMenu(folder, account, e) {
  popupMenu(e, [
    { label: 'Alle als gelesen markieren', onClick: async () => { try { await post(`/folders/${folder.id}/read-all`); if (folder.id === cur.folderId) loadThreads(true); } catch (err) { toast(err.message, 'error'); } } },
    { label: 'Jetzt synchronisieren', onClick: () => post(`/folders/${folder.id}/sync`).then(() => toast('Synchronisierung gestartet')).catch((err) => toast(err.message, 'error')) },
    { label: 'Unterordner anlegen…', onClick: () => createFolderDialog(account, folder) },
    !folder.specialUse ? { label: 'Umbenennen…', onClick: async () => {
      const name = await promptDialog('Ordner umbenennen', 'Neuer Name', folder.name);
      if (!name) return;
      try { await patch(`/folders/${folder.id}`, { name }); toast('Ordner wird umbenannt…'); } catch (err) { toast(err.message, 'error'); }
    } } : null,
    ['\\Trash', '\\Junk'].includes(folder.specialUse) ? { label: 'Ordner leeren…', danger: true, onClick: async () => {
      if (!(await confirmDialog('Ordner leeren', `Alle Nachrichten in „${folderLabel(folder)}“ endgültig löschen?`, { confirmLabel: 'Endgültig löschen' }))) return;
      try { await post(`/folders/${folder.id}/empty`); if (folder.id === cur.folderId) loadThreads(false); toast('Ordner geleert'); } catch (err) { toast(err.message, 'error'); }
    } } : null,
    !folder.specialUse ? { label: 'Ordner löschen…', danger: true, onClick: async () => {
      if (!(await confirmDialog('Ordner löschen', `Ordner „${folder.name}“ samt Inhalt auf dem Server löschen?`, { confirmLabel: 'Löschen' }))) return;
      try { await del(`/folders/${folder.id}`); toast('Ordner wird gelöscht…'); } catch (err) { toast(err.message, 'error'); }
    } } : null,
  ]);
}

export async function createFolderDialog(account, parent) {
  const name = await promptDialog(parent ? `Unterordner in „${folderLabel(parent)}“` : `Neuer Ordner in ${account.name}`, 'Ordnername');
  if (!name) return;
  try {
    await post(`/accounts/${account.id}/folders`, { name, parentId: parent ? parent.id : undefined });
    toast('Ordner angelegt');
    setTimeout(() => loadAccounts(), 1500);
  } catch (err) { toast(err.message, 'error'); }
}

// ====================================================================== Leser

function renderReaderEmpty() {
  cur.thread = null;
  clear(els.reader, h('div', { class: 'reader-empty' }, icon('mail', 40), h('p', {}, 'Wähle eine Konversation aus')));
}

async function openThread(threadId, { soft = false } = {}) {
  if (!soft) clear(els.reader, h('div', { class: 'reader-loading' }, h('span', { class: 'spinner' })));
  let t;
  try {
    t = await get(`/threads/${threadId}`, { folder: cur.folderId });
  } catch (err) {
    clear(els.reader, h('div', { class: 'reader-empty' }, err.message));
    return;
  }
  if (threadId !== cur.threadId) return;
  if (!t.messages.length) {
    renderReaderEmpty();
    return;
  }
  const prevIds = cur.thread && cur.thread.threadId === threadId ? cur.thread.messages.map((m) => m.id).join(',') : null;
  cur.thread = t;
  if (soft && prevIds === t.messages.map((m) => m.id).join(',')) return; // nichts Neues
  if (!soft || !prevIds) {
    expanded.clear();
    const last = t.messages[t.messages.length - 1];
    expanded.add(last.id);
    for (const m of t.messages) if (!m.flags.includes('\\Seen')) expanded.add(m.id);
  } else {
    for (const m of t.messages) if (!prevIds.split(',').includes(String(m.id))) expanded.add(m.id);
  }
  renderThread();
  // Liste: Thread als gelesen anzeigen
  const lt = cur.threads.find((x) => x.threadId === threadId);
  if (lt && lt.unread) {
    lt.unread = false;
    const li = els.list.querySelector(`[data-thread-id="${threadId}"]`);
    if (li) li.classList.remove('unread');
  }
}

function renderThread() {
  const t = cur.thread;
  const found = findFolder(cur.folderId);
  const special = found ? found.folder.specialUse : null;
  const anyUnread = t.messages.some((m) => !m.flags.includes('\\Seen'));
  const flagged = t.messages.some((m) => m.flags.includes('\\Flagged'));
  const last = [...t.messages].reverse().find((m) => m.folderSpecial !== '\\Sent' && m.folderSpecial !== '\\Drafts') || t.messages[t.messages.length - 1];

  const toolbar = h('div', { class: 'reader-toolbar' },
    iconButton('back', 'Zurück', () => { location.hash = `#/mail/${cur.folderId}`; }, { class: 'only-mobile' }),
    iconButton('reply', 'Antworten (r)', () => replyTo(last, 'reply')),
    iconButton('replyAll', 'Allen antworten (a)', () => replyTo(last, 'replyAll')),
    iconButton('forward', 'Weiterleiten (f)', () => replyTo(last, 'forward')),
    h('span', { class: 'sep' }),
    special !== '\\Archive' ? iconButton('archive', 'Archivieren (e)', () => action(currentThreadIdsInFolder(), 'archive')) : null,
    iconButton('trash', special === '\\Trash' ? 'Endgültig löschen' : 'Löschen (#)', () => deleteCurrent()),
    iconButton('move', 'Verschieben (v)', () => moveDialog(currentThreadIdsInFolder())),
    iconButton(anyUnread ? 'mailOpen' : 'mail', anyUnread ? 'Als gelesen markieren' : 'Als ungelesen markieren (u)',
      () => action(currentThreadIdsInFolder(), anyUnread ? 'seen' : 'unseen').then(() => renderThread())),
    h('button', {
      class: `icon-btn star ${flagged ? 'on' : ''}`, type: 'button', title: flagged ? 'Markierung entfernen' : 'Markieren (s)',
      onClick: () => action(currentThreadIdsInFolder(), flagged ? 'unflag' : 'flag').then(() => renderThread()),
    }, icon('star')),
    iconButton('more', 'Weitere Aktionen', (e) => popupMenu(e, [
      special === '\\Junk'
        ? { label: 'Kein Spam', onClick: () => action(currentThreadIdsInFolder(), 'notspam') }
        : { label: 'Als Spam markieren', onClick: () => action(currentThreadIdsInFolder(), 'spam') },
      { label: 'Quelltext anzeigen', onClick: () => window.open(`/api/messages/${last.id}/source`, '_blank', 'noopener') },
      { label: 'Als .eml herunterladen', onClick: () => { location.href = `/api/messages/${last.id}/source?download=1`; } },
      { label: 'Als Anhang weiterleiten', onClick: () => compose.openCompose({ mode: 'forwardAttachment', message: last, accountId: last.accountId }) },
    ])));

  const list = h('div', { class: 'messages' }, t.messages.map((m, i) => messageCard(m, i === t.messages.length - 1)));
  clear(els.reader, toolbar, h('div', { class: 'reader-scroll' },
    h('h2', { class: 'thread-subject-big' }, t.subject || '(kein Betreff)',
      t.messages.length > 1 ? h('span', { class: 'thread-count' }, t.messages.length) : null),
    list));
  for (const m of t.messages) if (expanded.has(m.id)) loadBody(m);
}

async function deleteCurrent() {
  await action(currentThreadIdsInFolder(), 'delete');
}

function messageCard(m, isLast) {
  const isOpen = expanded.has(m.id);
  const otherFolder = m.folderId !== cur.folderId;
  const card = h('article', { class: `msg ${isOpen ? 'open' : 'collapsed'} ${m.flags.includes('\\Seen') ? '' : 'unread'}`, dataset: { id: m.id } });
  const head = h('header', {
    class: 'msg-head',
    onClick: (e) => {
      if (e.target.closest('button, a')) return;
      if (expanded.has(m.id) && !isLast) expanded.delete(m.id); else expanded.add(m.id);
      const fresh = messageCard(m, isLast);
      card.replaceWith(fresh);
      if (expanded.has(m.id)) loadBody(m);
    },
  },
  avatar(m.fromName, m.fromAddr, 38),
  h('div', { class: 'msg-meta' },
    h('div', { class: 'msg-from' },
      h('strong', {}, m.fromName || m.fromAddr),
      m.fromName ? h('span', { class: 'addr' }, `<${m.fromAddr}>`) : null,
      otherFolder ? h('span', { class: 'chip' }, m.folderSpecial ? folderLabel({ specialUse: m.folderSpecial, name: m.folderName }) : m.folderName) : null),
    isOpen
      ? h('div', { class: 'msg-to' }, recipientsLine(m))
      : h('div', { class: 'msg-preview' }, m.preview || '')),
  h('div', { class: 'msg-side' },
    m.hasAttachments ? icon('clip', 14) : null,
    h('time', { title: fullDate(m.date) }, shortDate(m.date)),
    isOpen ? iconButton('reply', 'Antworten', () => replyTo(m, 'reply'), { class: 'tiny' }) : null,
    isOpen ? iconButton('more', 'Mehr', (e) => popupMenu(e, [
      { label: 'Allen antworten', onClick: () => replyTo(m, 'replyAll') },
      { label: 'Weiterleiten', onClick: () => replyTo(m, 'forward') },
      m.folderSpecial === '\\Drafts' ? { label: 'Entwurf bearbeiten', onClick: () => editDraft(m) } : null,
      { label: 'Als ungelesen markieren', onClick: () => action([m.id], 'unseen') },
      { label: 'Diese Nachricht löschen', danger: true, onClick: () => action([m.id], 'delete', null, { keepList: true }).then(() => openThread(cur.threadId, { soft: true })) },
      { label: 'Quelltext anzeigen', onClick: () => window.open(`/api/messages/${m.id}/source`, '_blank', 'noopener') },
    ]), { class: 'tiny' }) : null));
  card.appendChild(head);
  if (isOpen) {
    const body = h('div', { class: 'msg-body' });
    const cached = bodyCache.get(m.id);
    if (cached) fillBody(body, m, cached);
    else body.appendChild(h('div', { class: 'body-loading' }, h('span', { class: 'spinner' })));
    card.appendChild(body);
  }
  return card;
}

function recipientsLine(m) {
  const fmt = (list) => (list || []).map((a) => a.name || a.address).join(', ');
  const parts = [];
  if (m.to && m.to.length) parts.push(`an ${fmt(m.to)}`);
  if (m.cc && m.cc.length) parts.push(`Cc ${fmt(m.cc)}`);
  return parts.join(' · ');
}

async function loadBody(m) {
  const card = els.reader.querySelector(`.msg[data-id="${m.id}"]`);
  if (!card) return;
  const body = card.querySelector('.msg-body');
  if (!body) return;
  let payload = bodyCache.get(m.id);
  if (!payload) {
    try {
      payload = await get(`/messages/${m.id}/body`);
      bodyCache.set(m.id, payload);
      if (bodyCache.size > 60) bodyCache.delete(bodyCache.keys().next().value);
      if (!m.flags.includes('\\Seen')) m.flags = [...m.flags, '\\Seen'];
    } catch (err) {
      clear(body, h('div', { class: 'body-error' }, err.message));
      return;
    }
  }
  const liveCard = els.reader.querySelector(`.msg[data-id="${m.id}"] .msg-body`);
  if (liveCard) fillBody(liveCard, m, payload);
}

function trustedSenders() {
  try { return new Set(JSON.parse(localStorage.getItem('wm.trusted') || '[]')); } catch { return new Set(); }
}

function fillBody(container, m, p, forceRemote = false) {
  clear(container);
  const sender = (p.from[0] && p.from[0].address || '').toLowerCase();
  const allowRemote = forceRemote || trustedSenders().has(sender);

  if (p.hasRemote && !allowRemote) {
    container.appendChild(h('div', { class: 'banner' },
      icon('image', 16),
      h('span', {}, 'Externe Bilder wurden zum Schutz deiner Privatsphäre blockiert.'),
      h('button', { class: 'link-btn', type: 'button', onClick: () => fillBody(container, m, p, true) }, 'Anzeigen'),
      sender ? h('button', {
        class: 'link-btn', type: 'button', onClick: () => {
          const s = trustedSenders(); s.add(sender);
          localStorage.setItem('wm.trusted', JSON.stringify([...s]));
          fillBody(container, m, p, true);
        },
      }, `Immer von ${sender}`) : null));
  }

  if (p.calendar && p.calendar.length) {
    container.appendChild(h('div', { class: 'banner banner-cal' },
      icon('calendar', 16),
      h('span', {}, 'Diese Nachricht enthält eine Kalendereinladung.'),
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => importIcs(m, p.calendar[0]) }, 'In Kalender übernehmen')));
  }

  if (p.html) container.appendChild(htmlFrame(p.html, allowRemote));
  else container.appendChild(textBody(p.text));

  const atts = p.attachments || [];
  if (atts.length) {
    container.appendChild(h('div', { class: 'attachments' }, atts.map((a) => h('a', {
      class: 'att', href: `/api/messages/${m.id}/attachments/${a.idx}`, download: a.filename, title: a.filename,
    },
    icon('clip', 15),
    h('span', { class: 'att-name' }, a.filename),
    h('span', { class: 'att-size' }, fileSize(a.size))))));
  }
  if (p.listUnsubscribe) {
    container.appendChild(h('div', { class: 'unsub' },
      h('a', { href: p.listUnsubscribe, target: '_blank', rel: 'noopener noreferrer' }, 'Newsletter abbestellen')));
  }
}

function htmlFrame(html, allowRemote) {
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${allowRemote ? 'https: http:' : ''}; img-src data: blob: ${allowRemote ? 'https: http:' : ''}; font-src data: ${allowRemote ? 'https:' : ''}`;
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
html,body{margin:0;padding:0;background:#fff;color:#1f2328}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:2px 2px 8px;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}
a{color:#2557c7}
</style></head><body>${html}</body></html>`;
  const frame = h('iframe', {
    class: 'mail-frame', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    referrerpolicy: 'no-referrer', title: 'Nachrichteninhalt',
  });
  frame.srcdoc = doc;
  const resize = () => {
    try {
      const d = frame.contentDocument;
      if (!d || !d.documentElement) return;
      frame.style.height = `${Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0) + 4}px`;
    } catch { /* ignore */ }
  };
  frame.addEventListener('load', () => {
    resize();
    try {
      const d = frame.contentDocument;
      for (const img of d.images) img.addEventListener('load', resize);
      new ResizeObserver(resize).observe(d.body);
      // mailto:-Links im eigenen Editor öffnen
      d.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href^="mailto:"]');
        if (a) { e.preventDefault(); compose.openCompose({ to: decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]) }); }
      });
    } catch { /* ignore */ }
  });
  return frame;
}

function textBody(text) {
  const lines = String(text || '').split('\n');
  const htmlLines = lines.map((l) => {
    let s = esc(l).replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    if (/^\s*&gt;/.test(s)) s = `<span class="q">${s}</span>`;
    return s;
  });
  return h('div', { class: 'text-body', html: htmlLines.join('\n') });
}

async function importIcs(m, idx) {
  let cols;
  try {
    cols = (await get('/dav/collections')).collections.filter((c) => c.type === 'calendar');
  } catch (err) { toast(err.message, 'error'); return; }
  if (!cols.length) { toast('Kein Kalender verfügbar', 'error'); return; }
  const sel = h('select', {}, cols.map((c, i) => h('option', { value: String(i) }, `${c.name} (${c.sourceName})`)));
  modal({
    title: 'Termin übernehmen',
    body: h('label', { class: 'field' }, h('span', {}, 'Kalender'), sel),
    actions: [
      { label: 'Abbrechen' },
      { label: 'Übernehmen', primary: true, onClick: async () => {
        const c = cols[Number(sel.value)];
        const r = await post(`/messages/${m.id}/import-ics`, { attachmentIdx: idx, sourceId: c.sourceId, calendar: c.url });
        toast(`„${r.summary || 'Termin'}“ eingetragen`, 'success');
      } },
    ],
  });
}

// ====================================================================== Antworten

async function ensureBody(m) {
  if (bodyCache.has(m.id)) return bodyCache.get(m.id);
  const p = await get(`/messages/${m.id}/body`, { markSeen: 0 });
  bodyCache.set(m.id, p);
  return p;
}

async function replyTo(m, mode) {
  try {
    const p = await ensureBody(m);
    compose.openCompose({ mode, message: m, body: p, accountId: m.accountId });
  } catch (err) { toast(err.message, 'error'); }
}

async function editDraft(m) {
  try {
    const p = await ensureBody(m);
    compose.openCompose({ mode: 'draft', message: m, body: p, accountId: m.accountId });
  } catch (err) { toast(err.message, 'error'); }
}

// ====================================================================== Push

const reloadList = debounce(() => { if (root) loadThreads(true); }, 400);
const reloadThread = debounce(() => { if (root && cur.threadId) openThread(cur.threadId, { soft: true }); }, 600);

export function onFolderEvent(msg) {
  if (!root) return;
  if (msg.folderId === cur.folderId) {
    els.count.textContent = msg.unseen ? `${msg.unseen} ungelesen` : '';
    if (msg.changed) reloadList();
  }
  if (msg.changed && cur.thread && cur.thread.messages.some((m) => m.accountId === msg.accountId)) reloadThread();
}

// ====================================================================== Tastatur

function onKey(e) {
  if (!root) return;
  if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('.modal-overlay, .compose.open:not(.minimized)')) return;
  const idx = cur.threads.findIndex((t) => t.threadId === cur.threadId);
  const go = (i) => {
    const t = cur.threads[i];
    if (!t) return;
    location.hash = `#/mail/${cur.folderId}/${t.threadId}`;
    const li = els.list.querySelector(`[data-thread-id="${t.threadId}"]`);
    if (li) li.scrollIntoView({ block: 'nearest' });
  };
  const last = cur.thread && cur.thread.messages[cur.thread.messages.length - 1];
  switch (e.key) {
    case 'j': case 'ArrowDown': e.preventDefault(); go(idx + 1); break;
    case 'k': case 'ArrowUp': e.preventDefault(); go(Math.max(0, idx - 1)); break;
    case '/': e.preventDefault(); els.search.focus(); break;
    case 'Escape': if (cur.threadId) location.hash = `#/mail/${cur.folderId}`; break;
    default:
      if (!cur.thread) return;
      if (e.key === 'r') { e.preventDefault(); replyTo(last, 'reply'); }
      else if (e.key === 'a') { e.preventDefault(); replyTo(last, 'replyAll'); }
      else if (e.key === 'f') { e.preventDefault(); replyTo(last, 'forward'); }
      else if (e.key === 'e') action(currentThreadIdsInFolder(), 'archive');
      else if (e.key === '#' || e.key === 'Delete') deleteCurrent();
      else if (e.key === 'u') action(currentThreadIdsInFolder(), 'unseen').then(() => { location.hash = `#/mail/${cur.folderId}`; });
      else if (e.key === 's') {
        const flagged = cur.thread.messages.some((m) => m.flags.includes('\\Flagged'));
        action(currentThreadIdsInFolder(), flagged ? 'unflag' : 'flag').then(() => renderThread());
      } else if (e.key === 'v') moveDialog(currentThreadIdsInFolder());
  }
}

export { formatAddress };
