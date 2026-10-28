'use strict';

/**
 * Lokale Adressbücher: in der Webmail-Datenbank statt auf einem CardDAV-Server.
 * LocalClient bietet dieselben Methoden wie DavClient (soweit für Adressbücher nötig),
 * damit Kontaktliste, Vorschläge, Fotos usw. ohne Sonderfälle funktionieren.
 * Adressen: local://book/<id>/ (Adressbuch) und local://book/<id>/<name>.vcf (Kontakt)
 */
const crypto = require('crypto');
const db = require('../db');
const { DavError } = require('./client');

const LOCAL_ID = 'local';
const LOCAL_NAME = 'Lokal (Webmail)';
const BOOK_RE = /^local:\/\/book\/(\d+)\/$/;
const OBJ_RE = /^local:\/\/book\/(\d+)\/([^/]+)$/;

const etagOf = (data) => `"${crypto.createHash('sha1').update(data).digest('hex').slice(0, 20)}"`;
const bookUrl = (id) => `local://book/${id}/`;

class LocalClient {
  constructor(user) {
    this.userId = user.id;
  }

  assertOwnUrl(url) {
    const u = String(url || '');
    if (!BOOK_RE.test(u) && !OBJ_RE.test(u)) throw new DavError(400, 'Ungültige Adresse');
    return u;
  }

  async ownBook(url) {
    const m = String(url).match(BOOK_RE) || String(url).match(OBJ_RE);
    const id = m ? parseInt(m[1], 10) : 0;
    const b = await db.one('SELECT * FROM local_books WHERE id = $1 AND user_id = $2', [id, this.userId]);
    if (!b) throw new DavError(404, 'Adressbuch nicht gefunden');
    return b;
  }

  async discover() {
    const rows = await db.many(
      `SELECT b.id, b.name, (SELECT max(updated_at) FROM local_contacts c WHERE c.book_id = b.id) AS changed,
              (SELECT count(*)::int FROM local_contacts c WHERE c.book_id = b.id) AS n
         FROM local_books b WHERE b.user_id = $1 ORDER BY b.name, b.id`, [this.userId]);
    return rows.map((r) => ({
      type: 'addressbook', url: bookUrl(r.id), href: `/local/${r.id}/`, name: r.name, color: null,
      ctag: `${r.n}-${r.changed ? new Date(r.changed).getTime() : 0}`, local: true,
    }));
  }

  async createBook(name) {
    const r = await db.one('INSERT INTO local_books (user_id, name) VALUES ($1, $2) RETURNING id',
      [this.userId, String(name || 'Adressbuch').trim().slice(0, 200) || 'Adressbuch']);
    return bookUrl(r.id);
  }

  async rename(url, name) {
    const b = await this.ownBook(url);
    await db.query('UPDATE local_books SET name = $2 WHERE id = $1', [b.id, String(name).trim().slice(0, 200) || b.name]);
  }

  async deleteCollection(url) {
    const b = await this.ownBook(url);
    await db.query('DELETE FROM local_books WHERE id = $1', [b.id]);
  }

  async addressbookQuery(url) {
    const b = await this.ownBook(url);
    const rows = await db.many('SELECT name, data, etag FROM local_contacts WHERE book_id = $1', [b.id]);
    return rows.map((r) => ({ href: `/local/${b.id}/${r.name}`, url: `${bookUrl(b.id)}${r.name}`, etag: r.etag, data: r.data }));
  }

  async getObject(url) {
    const b = await this.ownBook(url);
    const name = String(url).match(OBJ_RE)[2];
    const r = await db.one('SELECT data, etag FROM local_contacts WHERE book_id = $1 AND name = $2', [b.id, name]);
    if (!r) throw new DavError(404, 'Objekt nicht gefunden (HTTP 404)');
    return { data: r.data, etag: r.etag };
  }

  /** wie HTTP PUT: ohne ETag nur neu anlegen (If-None-Match: *), mit ETag nur, wenn unverändert (If-Match) */
  async putObject(url, data, contentType, etag) {
    const b = await this.ownBook(url);
    const m = String(url).match(OBJ_RE);
    if (!m) throw new DavError(400, 'Ungültige Adresse');
    const name = m[2];
    const cur = await db.one('SELECT etag FROM local_contacts WHERE book_id = $1 AND name = $2', [b.id, name]);
    if (etag && (!cur || cur.etag !== etag)) throw new DavError(412, 'Der Eintrag wurde inzwischen geändert – bitte neu laden');
    if (!etag && cur) throw new DavError(412, 'Der Eintrag existiert bereits');
    const tag = etagOf(data);
    await db.query(
      `INSERT INTO local_contacts (book_id, name, data, etag) VALUES ($1,$2,$3,$4)
       ON CONFLICT (book_id, name) DO UPDATE SET data = EXCLUDED.data, etag = EXCLUDED.etag, updated_at = now()`,
      [b.id, name, data, tag]);
    return tag;
  }

  async deleteObject(url, etag) {
    const b = await this.ownBook(url);
    const name = String(url).match(OBJ_RE)[2];
    if (etag) {
      const cur = await db.one('SELECT etag FROM local_contacts WHERE book_id = $1 AND name = $2', [b.id, name]);
      if (cur && cur.etag !== etag) throw new DavError(412, 'Der Eintrag wurde inzwischen geändert – bitte neu laden');
    }
    await db.query('DELETE FROM local_contacts WHERE book_id = $1 AND name = $2', [b.id, name]);
  }

  // Kalender gibt es lokal nicht
  async calendarQuery() { return []; }
  async findByUid() { return null; }
  async homeSet() { return null; }
}

function localSource(user) {
  return { id: LOCAL_ID, name: LOCAL_NAME, url: 'local:', username: '', local: true, client: new LocalClient(user) };
}

module.exports = { LocalClient, localSource, LOCAL_ID, LOCAL_NAME };
