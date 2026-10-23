'use strict';

/**
 * Ein AccountWorker pro E-Mail-Konto:
 *  - "cmd"-Verbindung: Sync + Benutzeraktionen (Flags, Verschieben, Body laden ...)
 *  - "idle"-Verbindung: hält INBOX offen, imapflow nutzt IMAP IDLE -> Push
 *  - Polling (STATUS über LIST) für alle anderen Ordner
 */
const { ImapFlow } = require('imapflow');
const db = require('../db');
const config = require('../config');
const hub = require('../hub');
const { decrypt } = require('../crypto');
const { imapConnectOptions, friendlyError } = require('../tls');
const store = require('./store');
const { guessSpecialUse, uidRange, chunk } = require('./util');

const FETCH_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  size: true,
  internalDate: true,
  headers: ['references'],
};

const FOLDER_ORDER = { '\\Inbox': 0, '\\Sent': 1, '\\Drafts': 2, '\\Archive': 3, null: 4, '\\All': 6, '\\Junk': 7, '\\Trash': 8 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function imapOptions(acc) {
  return {
    host: acc.imap_host,
    ...imapConnectOptions(acc.imap_port, acc.imap_security, acc.allow_insecure_tls),
    auth: { user: acc.imap_user, pass: decrypt(acc.imap_pass) },
    logger: false,
    emitLogs: false,
    connectionTimeout: 30000,
    greetingTimeout: 20000,
    socketTimeout: 5 * 60000,
    maxIdleTime: 4 * 60000,
  };
}

class AccountWorker {
  constructor(account) {
    this.account = account;
    this.id = account.id;
    this.userId = account.user_id;
    this.stopped = true;
    this.cmd = null;
    this.cmdConnecting = null;
    this.idle = null;
    this.syncChain = Promise.resolve();
    this.pendingFolders = new Set();
    this.fullSyncPending = false;
    this.debounce = new Map();
    this.pollTimer = null;
    this.initialDone = false;
  }

  log(...args) { console.log(`[imap:${this.id}]`, ...args); }

  // ------------------------------------------------------------------ Lifecycle

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleFullSync();
    this.idleLoop();
    this.pollTimer = setInterval(() => this.scheduleFullSync(), config.pollIntervalMs);
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    const conns = [this.cmd, this.idle].filter(Boolean);
    this.cmd = null;
    this.idle = null;
    await Promise.all(conns.map((c) => c.logout().catch(() => c.close())));
  }

  async setStatus(status, error) {
    this.status = status;
    await db.query(
      `UPDATE mail_accounts SET status = $2, last_error = $3, last_sync = CASE WHEN $2 = 'ok' THEN now() ELSE last_sync END
        WHERE id = $1`, [this.id, status, error || null]).catch(() => {});
    hub.send(this.userId, { t: 'account', accountId: this.id, status, error: error || null });
  }

  // ------------------------------------------------------------------ Connections

  makeClient() {
    const c = new ImapFlow(imapOptions(this.account));
    c.on('error', (err) => this.log('Verbindungsfehler:', err.message));
    return c;
  }

  async client() {
    if (this.stopped) throw new Error('Konto ist deaktiviert');
    if (this.cmd && this.cmd.usable) return this.cmd;
    if (this.cmdConnecting) return this.cmdConnecting;
    this.cmdConnecting = (async () => {
      const c = this.makeClient();
      c.on('close', () => { if (this.cmd === c) this.cmd = null; });
      await c.connect();
      this.cmd = c;
      return c;
    })().finally(() => { this.cmdConnecting = null; });
    return this.cmdConnecting;
  }

  /** Hält INBOX per IDLE offen und triggert bei Änderungen einen Ordner-Sync. */
  async idleLoop() {
    let backoff = 5000;
    while (!this.stopped) {
      const c = this.makeClient();
      try {
        await c.connect();
        if (this.stopped) { await c.logout().catch(() => {}); break; }
        this.idle = c;
        await c.mailboxOpen('INBOX', { readOnly: true });
        backoff = 5000;
        const trigger = () => this.scheduleFolderSync('INBOX', 300);
        c.on('exists', trigger);
        c.on('expunge', trigger);
        c.on('flags', trigger);
        // imapflow geht nach kurzer Inaktivität automatisch in IDLE.
        await new Promise((resolve) => c.once('close', resolve));
      } catch (err) {
        this.log('IDLE-Verbindung:', err.message);
        try { c.close(); } catch (_) { /* ignore */ }
      }
      if (this.idle === c) this.idle = null;
      if (this.stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10 * 60000);
    }
  }

  // ------------------------------------------------------------------ Scheduling

  enqueue(fn) {
    const p = this.syncChain.then(() => (this.stopped ? null : fn()));
    this.syncChain = p.catch(() => {});
    return p;
  }

  scheduleFullSync() {
    if (this.fullSyncPending || this.stopped) return;
    this.fullSyncPending = true;
    this.enqueue(async () => {
      this.fullSyncPending = false;
      await this.fullSync();
    }).catch(() => {});
  }

  scheduleFolderSync(path, delay = 0) {
    if (this.stopped) return;
    clearTimeout(this.debounce.get(path));
    this.debounce.set(path, setTimeout(() => {
      this.debounce.delete(path);
      if (this.pendingFolders.has(path)) return;
      this.pendingFolders.add(path);
      this.enqueue(async () => {
        this.pendingFolders.delete(path);
        try {
          await this.syncFolder(path);
        } catch (err) {
          this.log(`Sync ${path}:`, err.message);
        }
      }).catch(() => {});
    }, delay));
  }

  // ------------------------------------------------------------------ Sync

  async fullSync() {
    const first = !this.initialDone;
    if (first) await this.setStatus('syncing');
    try {
      const c = await this.client();
      const { folders, statuses } = await this.syncFolderList(c);
      const ordered = folders
        .filter((f) => f.selectable)
        .sort((a, b) => (FOLDER_ORDER[a.special_use] ?? 4) - (FOLDER_ORDER[b.special_use] ?? 4));
      for (const f of ordered) {
        if (this.stopped) return;
        const st = statuses.get(f.path);
        const needs = !f.last_sync || !st
          || Number(st.messages) !== f.total
          || Number(st.unseen) !== f.unseen
          || (st.uidNext && Number(st.uidNext) !== Number(f.uidnext))
          || (st.highestModseq && String(st.highestModseq) !== String(f.highestmodseq));
        if (needs) {
          try {
            await this.syncFolder(f.path);
          } catch (err) {
            this.log(`Sync ${f.path}:`, err.message);
          }
        }
      }
      this.initialDone = true;
      if (first || this.status !== 'ok') await this.setStatus('ok');
      else db.query('UPDATE mail_accounts SET last_sync = now() WHERE id = $1', [this.id]).catch(() => {});
    } catch (err) {
      this.log('Sync fehlgeschlagen:', err.message);
      const msg = friendlyError(err, { kind: 'imap', port: this.account.imap_port, security: this.account.imap_security });
      await this.setStatus('error', msg);
    }
  }

  async syncFolderList(c) {
    const list = await c.list({
      statusQuery: { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: true },
    });
    const statuses = new Map();
    const paths = [];
    let structural = false;
    for (const e of list) {
      const flags = e.flags instanceof Set ? e.flags : new Set(e.flags || []);
      const selectable = !flags.has('\\Noselect') && !flags.has('\\NonExistent');
      const r = await db.one(
        `INSERT INTO folders (account_id, path, name, delimiter, parent_path, special_use, selectable, subscribed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (account_id, path) DO UPDATE
           SET name = EXCLUDED.name, delimiter = EXCLUDED.delimiter, parent_path = EXCLUDED.parent_path,
               special_use = EXCLUDED.special_use, selectable = EXCLUDED.selectable, subscribed = EXCLUDED.subscribed
         RETURNING (xmax = 0) AS inserted`,
        [this.id, e.path, e.name, e.delimiter || null, e.parentPath || null, guessSpecialUse(e), selectable,
          e.subscribed !== false]);
      if (r.inserted) structural = true;
      paths.push(e.path);
      if (e.status) statuses.set(e.path, e.status);
    }
    const del = await db.query('DELETE FROM folders WHERE account_id = $1 AND NOT (path = ANY($2::text[]))', [this.id, paths]);
    if (del.rowCount) structural = true;
    if (structural) hub.send(this.userId, { t: 'folders', accountId: this.id });
    const folders = await db.many('SELECT * FROM folders WHERE account_id = $1', [this.id]);
    return { folders, statuses };
  }

  async syncFolder(path) {
    const c = await this.client();
    const folder = await db.one('SELECT * FROM folders WHERE account_id = $1 AND path = $2', [this.id, path]);
    if (!folder || !folder.selectable) return;
    const isInbox = folder.special_use === '\\Inbox';
    const prevUidNext = folder.uidnext ? Number(folder.uidnext) : null;

    let changed = false;
    let toFetch = [];
    let minUid = folder.min_synced_uid;
    let mbInfo;

    let lock = await c.getMailboxLock(path);
    try {
      const mb = c.mailbox;
      const uidValidity = mb.uidValidity != null ? String(mb.uidValidity) : null;
      if (folder.uidvalidity != null && uidValidity && String(folder.uidvalidity) !== uidValidity) {
        await db.query('DELETE FROM messages WHERE folder_id = $1', [folder.id]);
        minUid = null;
        folder.highestmodseq = null;
        changed = true;
      }
      const serverUids = mb.exists ? ((await c.search({ all: true }, { uid: true })) || []) : [];
      serverUids.sort((a, b) => a - b);
      const serverSet = new Set(serverUids);
      const localRows = await db.many('SELECT uid FROM messages WHERE folder_id = $1', [folder.id]);
      const localSet = new Set(localRows.map((r) => Number(r.uid)));

      // 1) Gelöschte Nachrichten entfernen
      const gone = [...localSet].filter((u) => !serverSet.has(u));
      if (gone.length) {
        await db.query('DELETE FROM messages WHERE folder_id = $1 AND uid = ANY($2::bigint[])', [folder.id, gone]);
        gone.forEach((u) => localSet.delete(u));
        changed = true;
      }

      // 2) Neue Nachrichten bestimmen
      if (minUid == null) {
        const windowUids = serverUids.slice(-config.syncInitialMessages);
        minUid = windowUids.length ? windowUids[0] : (mb.uidNext || 1);
        toFetch = windowUids.filter((u) => !localSet.has(u));
      } else {
        toFetch = serverUids.filter((u) => u >= minUid && !localSet.has(u));
      }

      // 3) Flag-Änderungen bestehender Nachrichten (CONDSTORE wenn möglich)
      if (localSet.size) {
        const modseq = mb.highestModseq ? String(mb.highestModseq) : null;
        const unchanged = modseq && folder.highestmodseq && String(folder.highestmodseq) === modseq;
        if (!unchanged) {
          const opts = { uid: true };
          if (modseq && folder.highestmodseq) opts.changedSince = BigInt(folder.highestmodseq);
          const updates = [];
          for await (const m of c.fetch(`${minUid}:*`, { uid: true, flags: true }, opts)) {
            if (localSet.has(m.uid)) updates.push({ uid: m.uid, flags: [...(m.flags || [])] });
          }
          if (await store.replaceFlags(folder.id, updates)) changed = true;
        }
      }

      const unseenUids = mb.exists ? ((await c.search({ seen: false }, { uid: true })) || []) : [];
      mbInfo = {
        uidValidity,
        uidNext: mb.uidNext || null,
        highestModseq: mb.highestModseq ? String(mb.highestModseq) : null,
        total: mb.exists || 0,
        unseen: unseenUids.length,
      };
    } finally {
      lock.release();
    }

    await db.query(
      `UPDATE folders SET uidvalidity = $2, uidnext = $3, highestmodseq = $4, total = $5, unseen = $6,
                          min_synced_uid = $7, last_sync = now() WHERE id = $1`,
      [folder.id, mbInfo.uidValidity, mbInfo.uidNext, mbInfo.highestModseq, mbInfo.total, mbInfo.unseen, minUid]);

    // 4) Neue Nachrichten laden – neueste zuerst, Lock pro Paket freigeben
    const newForNotify = [];
    const batches = chunk(toFetch.slice().reverse(), 100);
    for (const batch of batches) {
      if (this.stopped) return;
      const fetched = [];
      lock = await c.getMailboxLock(path);
      try {
        for await (const m of c.fetch(uidRange(batch), FETCH_QUERY, { uid: true })) fetched.push(m);
      } finally {
        lock.release();
      }
      await store.insertMessages(this.id, folder.id, fetched);
      changed = true;
      if (isInbox && prevUidNext) {
        for (const m of fetched) {
          if (m.uid >= prevUidNext && !(m.flags && m.flags.has && m.flags.has('\\Seen'))) {
            const from = (m.envelope && m.envelope.from && m.envelope.from[0]) || {};
            newForNotify.push({ subject: (m.envelope && m.envelope.subject) || '', from: from.name || from.address || '' });
          }
        }
      }
      if (batches.length > 1) this.emitFolder(folder.id, mbInfo, true, []);
    }

    if (changed || folder.unseen !== mbInfo.unseen || folder.total !== mbInfo.total) {
      this.emitFolder(folder.id, mbInfo, changed, newForNotify);
    }
  }

  emitFolder(folderId, info, changed, newMessages) {
    hub.send(this.userId, {
      t: 'folder', accountId: this.id, folderId, total: info.total, unseen: info.unseen, changed, newMessages,
    });
  }

  /** Lädt ältere Nachrichten (vor dem bisherigen Sync-Fenster) nach. */
  loadOlder(path, count = 500) {
    return this.enqueue(async () => {
      const c = await this.client();
      const folder = await db.one('SELECT * FROM folders WHERE account_id = $1 AND path = $2', [this.id, path]);
      if (!folder || folder.min_synced_uid == null) return 0;
      let uids;
      let lock = await c.getMailboxLock(path);
      try {
        uids = (await c.search({ uid: `1:${Math.max(1, folder.min_synced_uid - 1)}` }, { uid: true })) || [];
      } finally { lock.release(); }
      uids = uids.filter((u) => u < folder.min_synced_uid).sort((a, b) => a - b).slice(-count);
      if (!uids.length) {
        await db.query('UPDATE folders SET min_synced_uid = 1 WHERE id = $1', [folder.id]);
        return 0;
      }
      for (const batch of chunk(uids.slice().reverse(), 100)) {
        const fetched = [];
        lock = await c.getMailboxLock(path);
        try {
          for await (const m of c.fetch(uidRange(batch), FETCH_QUERY, { uid: true })) fetched.push(m);
        } finally { lock.release(); }
        await store.insertMessages(this.id, folder.id, fetched);
      }
      await db.query('UPDATE folders SET min_synced_uid = $2 WHERE id = $1', [folder.id, uids[0]]);
      hub.send(this.userId, { t: 'folder', accountId: this.id, folderId: folder.id, total: folder.total, unseen: folder.unseen, changed: true, newMessages: [] });
      return uids.length;
    });
  }

  // ------------------------------------------------------------------ Aktionen

  async withMailbox(path, fn) {
    const c = await this.client();
    const lock = await c.getMailboxLock(path);
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  }

  async fetchSource(path, uid) {
    return this.withMailbox(path, async (c) => {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m || !m.source) {
        const err = new Error('Nachricht nicht mehr auf dem Server vorhanden');
        err.status = 404;
        throw err;
      }
      return m.source;
    });
  }

  async setFlags(path, uids, flags, add) {
    if (!uids.length) return;
    await this.withMailbox(path, (c) => (add
      ? c.messageFlagsAdd(uidRange(uids), flags, { uid: true })
      : c.messageFlagsRemove(uidRange(uids), flags, { uid: true })));
    this.scheduleFolderSync(path, 1500);
  }

  async move(path, uids, dest) {
    if (!uids.length) return;
    await this.withMailbox(path, (c) => c.messageMove(uidRange(uids), dest, { uid: true }));
    this.scheduleFolderSync(path, 200);
    this.scheduleFolderSync(dest, 500);
  }

  async copy(path, uids, dest) {
    if (!uids.length) return;
    await this.withMailbox(path, (c) => c.messageCopy(uidRange(uids), dest, { uid: true }));
    this.scheduleFolderSync(dest, 500);
  }

  async expunge(path, uids) {
    if (!uids.length) return;
    await this.withMailbox(path, (c) => c.messageDelete(uidRange(uids), { uid: true }));
    this.scheduleFolderSync(path, 200);
  }

  async append(path, raw, flags) {
    const c = await this.client();
    const res = await c.append(path, raw, flags, new Date());
    this.scheduleFolderSync(path, 300);
    return res || {};
  }

  async createFolder(path) {
    const c = await this.client();
    await c.mailboxCreate(path);
    await c.mailboxSubscribe(path).catch(() => {});
    this.scheduleFullSync();
  }

  async renameFolder(path, newPath) {
    const c = await this.client();
    await c.mailboxRename(path, newPath);
    this.scheduleFullSync();
  }

  async deleteFolder(path) {
    const c = await this.client();
    await c.mailboxDelete(path);
    this.scheduleFullSync();
  }
}

/** Verbindungstest ohne Worker (für das Konto-Formular). */
async function testImap(account) {
  const c = new ImapFlow({ ...imapOptions(account), connectionTimeout: 15000 });
  c.on('error', () => {});
  try {
    await c.connect();
    const list = await c.list();
    await c.logout();
    return { ok: true, folders: list.length };
  } catch (err) {
    try { c.close(); } catch (_) { /* ignore */ }
    return { ok: false, error: friendlyError(err, { kind: 'imap', port: account.imap_port, security: account.imap_security }) };
  }
}

module.exports = { AccountWorker, testImap };
