'use strict';

/**
 * Verwaltet die CalDAV/CardDAV-Server eines Benutzers (Tabelle dav_sources).
 * Webmail bringt keinen eigenen DAV-Server mit – Kalender und Kontakte
 * liegen auf einem vorhandenen Server (Nextcloud, mailcow/SOGo, mailbox.org …).
 */
const db = require('../db');
const { decrypt } = require('../crypto');
const { DavClient, DavError } = require('./client');
const vcard = require('./vcard');

const collectionCache = new Map(); // `${userId}:${sourceId}` -> { until, list }
const contactCache = new Map();    // userId -> { until, contacts }

function externalClient(row) {
  return new DavClient({ baseUrl: row.url, username: row.username, password: decrypt(row.password) });
}

function toSource(r) {
  return { id: String(r.id), name: r.name, url: r.url, username: r.username, client: externalClient(r) };
}

async function getSources(user) {
  const rows = await db.many('SELECT * FROM dav_sources WHERE user_id = $1 ORDER BY id', [user.id]);
  return rows.map(toSource);
}

async function getSource(user, sourceId) {
  const row = await db.one('SELECT * FROM dav_sources WHERE id = $1 AND user_id = $2', [parseInt(sourceId, 10) || 0, user.id]);
  if (!row) throw new DavError(404, 'Kalender-/Kontakte-Server nicht gefunden');
  return toSource(row);
}

async function collections(user, source, { fresh = false } = {}) {
  const key = `${user.id}:${source.id}`;
  const cached = collectionCache.get(key);
  if (!fresh && cached && cached.until > Date.now()) return cached.list;
  let list = await source.client.discover();
  list = list.map((c) => ({ ...c, sourceId: source.id, sourceName: source.name }));
  collectionCache.set(key, { until: Date.now() + 5 * 60000, list });
  return list;
}

function invalidate(user, sourceId) {
  for (const k of collectionCache.keys()) {
    if (k === `${user.id}:${sourceId}` || (sourceId === undefined && k.startsWith(`${user.id}:`))) collectionCache.delete(k);
  }
  contactCache.delete(user.id);
}

/** Alle Kalender/Adressbücher aller Server; Fehler einzelner Server werden gemeldet, nicht geworfen. */
async function allCollections(user, opts) {
  const sources = await getSources(user);
  const results = await Promise.all(sources.map(async (s) => {
    try {
      return { items: await collections(user, s, opts) };
    } catch (err) {
      return { items: [], error: { sourceId: s.id, sourceName: s.name, message: err.message } };
    }
  }));
  return {
    collections: results.flatMap((r) => r.items),
    errors: results.filter((r) => r.error).map((r) => r.error),
    hasSources: sources.length > 0,
  };
}

/** Alle Kontakte (für Autovervollständigung), kurz gecacht. */
async function allContacts(user) {
  const c = contactCache.get(user.id);
  if (c && c.until > Date.now()) return c.contacts;
  const sources = await getSources(user);
  const out = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const books = (await collections(user, s)).filter((x) => x.type === 'addressbook');
      for (const b of books) {
        const items = await s.client.addressbookQuery(b.url);
        for (const it of items) {
          const p = vcard.parse(it.data);
          out.push({ ...p, href: it.url, etag: it.etag, book: b.url, sourceId: s.id });
        }
      }
    } catch (err) {
      console.log(`[dav] Kontakte aus Quelle ${s.name}:`, err.message);
    }
  }));
  contactCache.set(user.id, { until: Date.now() + 5 * 60000, contacts: out });
  return out;
}

module.exports = { getSources, getSource, collections, allCollections, allContacts, invalidate, externalClient };
