'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { encrypt } = require('../crypto');
const svc = require('./service');
const ics = require('./ics');
const scheduling = require('./scheduling');
const vcard = require('./vcard');
const { DavClient } = require('./client');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function collUrl(source, url) {
  const u = source.client.assertOwnUrl(url);
  return u.endsWith('/') ? u : u + '/';
}

function router() {
  const r = express.Router();

  // ------------------------------------------------------------ Quellen
  r.get('/dav/sources', wrap(async (req, res) => {
    const rows = await db.many('SELECT id, name, url, username, allow_insecure_tls FROM dav_sources WHERE user_id = $1 ORDER BY id', [req.user.id]);
    res.json({ sources: rows });
  }));

  r.post('/dav/sources', wrap(async (req, res) => {
    const { name, url, username, password } = req.body;
    if (!/^https?:\/\//i.test(String(url || ''))) return res.status(400).json({ error: 'Bitte eine gültige http(s)-URL angeben' });
    // Erst testen
    const test = new DavClient({ baseUrl: url, username, password });
    let found;
    try {
      found = await test.discover();
    } catch (err) {
      return res.status(400).json({ error: `Verbindung fehlgeschlagen: ${err.message}` });
    }
    if (!found.length) return res.status(400).json({ error: 'Keine Kalender oder Adressbücher unter dieser URL gefunden' });
    const row = await db.one(
      'INSERT INTO dav_sources (user_id, name, url, username, password) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.user.id, String(name || new URL(url).hostname), url, String(username || ''), encrypt(password)]);
    svc.invalidate(req.user);
    res.json({ id: row.id, found: found.length });
  }));

  r.delete('/dav/sources/:id', wrap(async (req, res) => {
    await db.query('DELETE FROM dav_sources WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10), req.user.id]);
    svc.invalidate(req.user);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ Collections
  r.get('/dav/collections', wrap(async (req, res) => {
    const out = await svc.allCollections(req.user, { fresh: req.query.fresh === '1' });
    res.json(out);
  }));

  r.post('/dav/collections', wrap(async (req, res) => {
    const { sourceId, type, name, color } = req.body;
    const source = await svc.getSource(req.user, sourceId);
    const label = String(name || '').trim() || (type === 'addressbook' ? 'Adressbuch' : 'Kalender');
    if (source.local) {
      if (type !== 'addressbook') return res.status(400).json({ error: 'Lokal können nur Adressbücher angelegt werden' });
      const url = await source.client.createBook(label);
      svc.invalidate(req.user, source.id);
      return res.json({ url });
    }
    let home = await source.client.homeSet(type === 'addressbook' ? 'addressbook' : 'calendar').catch(() => null);
    if (!home) {
      // Fallback: neben einer vorhandenen Sammlung gleichen Typs anlegen
      const existing = (await svc.collections(req.user, source)).find((c) => c.type === type);
      if (!existing) return res.status(400).json({ error: 'Auf diesem Server kann kein Speicherort ermittelt werden' });
      home = existing.url.replace(/[^/]+\/?$/, '');
    }
    // Lesbarer Pfad aus dem Namen (z. B. „familie/“); ist er schon vergeben, eine eindeutige Kennung
    const slug = label.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const create = (u) => (type === 'addressbook' ? source.client.mkaddressbook(u, label) : source.client.mkcalendar(u, label, color || '#3b6fd8'));
    let url = slug ? `${home}${slug}/` : `${home}${crypto.randomUUID()}/`;
    try {
      await create(url);
    } catch (err) {
      if (!slug || ![405, 409, 403].includes(err.status)) throw err;
      url = `${home}${slug}-${crypto.randomUUID().slice(0, 8)}/`;
      await create(url);
    }
    // Manche Server (z. B. SOGo) übernehmen den Namen beim Anlegen nicht – zusätzlich setzen
    try {
      await source.client.proppatch(url, `<d:displayname>${require('./client').xmlEscape(label)}</d:displayname>`
        + (type !== 'addressbook' && color ? `<ic:calendar-color>${require('./client').xmlEscape(color)}</ic:calendar-color>` : ''));
    } catch (_) { /* Name bleibt dann wie vom Server vergeben */ }
    svc.invalidate(req.user, source.id);
    res.json({ url });
  }));

  r.patch('/dav/collections', wrap(async (req, res) => {
    const { sourceId, url, name, color } = req.body;
    const source = await svc.getSource(req.user, sourceId);
    const target = collUrl(source, url);
    if (source.local) {
      if (name) await source.client.rename(target, name);
      svc.invalidate(req.user, source.id);
      return res.json({ ok: true });
    }
    let props = '';
    if (name) props += `<d:displayname>${require('./client').xmlEscape(name)}</d:displayname>`;
    if (color) props += `<ic:calendar-color>${require('./client').xmlEscape(color)}</ic:calendar-color>`;
    if (props) await source.client.proppatch(target, props);
    svc.invalidate(req.user, source.id);
    res.json({ ok: true });
  }));

  r.delete('/dav/collections', wrap(async (req, res) => {
    const source = await svc.getSource(req.user, req.query.sourceId);
    await source.client.deleteCollection(collUrl(source, req.query.url));
    svc.invalidate(req.user, source.id);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ Termine
  r.get('/events', wrap(async (req, res) => {
    const start = new Date(req.query.start);
    const end = new Date(req.query.end);
    if (isNaN(start) || isNaN(end) || end <= start) return res.status(400).json({ error: 'Ungültiger Zeitraum' });
    if (end - start > 400 * 86400000) return res.status(400).json({ error: 'Zeitraum zu groß' });
    const hidden = new Set(String(req.query.hidden || '').split(',').filter(Boolean));
    const sources = await svc.getSources(req.user);
    const mine = new Set(await scheduling.myEmails(req.user));
    const events = [];
    const errors = [];
    await Promise.all(sources.map(async (s) => {
      let cals;
      try {
        cals = (await svc.collections(req.user, s)).filter((c) => c.type === 'calendar' && !hidden.has(c.url));
      } catch (err) {
        errors.push({ sourceId: s.id, sourceName: s.name, message: err.message });
        return;
      }
      await Promise.all(cals.map(async (cal) => {
        try {
          const objects = await s.client.calendarQuery(cal.url, start, end);
          for (const o of objects) {
            let occ = [];
            try { occ = ics.expand(o.data, start, end); } catch (err) { continue; }
            for (const e of occ) {
              let role = null;
              let myStatus = null;
              if (e.organizer && e.attendees && e.attendees.length) {
                const me = e.attendees.find((a) => mine.has(a.email));
                role = mine.has(e.organizer.email) ? 'organizer' : (me ? 'attendee' : null);
                myStatus = me ? me.partstat : null;
              }
              events.push({
                ...e,
                role,
                myStatus,
                id: `${o.url}#${e.recurrenceId || ''}`,
                url: o.url,
                etag: o.etag,
                calendar: cal.url,
                color: cal.color,
                sourceId: s.id,
              });
            }
          }
        } catch (err) {
          errors.push({ sourceId: s.id, sourceName: `${s.name} / ${cal.name}`, message: err.message });
        }
      }));
    }));
    events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    res.json({ events, errors });
  }));

  /** Teilnehmer/Organisator werden in der Webmail nicht bearbeitet (keine eigenen Einladungen) – unverändert lassen. */
  const stripScheduling = (fields) => {
    for (const k of ['attendees', 'organizer', 'notify', 'identityId', 'tz']) delete fields[k];
    return fields;
  };

  r.post('/events', wrap(async (req, res) => {
    const { sourceId, calendar, ...fields } = req.body;
    const source = await svc.getSource(req.user, sourceId);
    const cal = collUrl(source, calendar);
    const { uid, data } = ics.buildEvent(stripScheduling(fields));
    const url = `${cal}${encodeURIComponent(uid)}.ics`;
    const etag = await source.client.putObject(url, data, 'text/calendar');
    res.json({ url, etag });
  }));

  r.put('/events', wrap(async (req, res) => {
    const { sourceId, url, etag, calendar, ...fields } = req.body;
    const source = await svc.getSource(req.user, sourceId);
    const target = source.client.assertOwnUrl(url);
    const current = await source.client.getObject(target);
    const { data } = ics.buildEvent(stripScheduling(fields), current.data);
    const useEtag = etag || current.etag;
    // In anderen Kalender verschieben?
    if (calendar && !target.startsWith(collUrl(source, calendar))) {
      const newUrl = `${collUrl(source, calendar)}${target.split('/').pop()}`;
      await source.client.putObject(newUrl, data, 'text/calendar');
      await source.client.deleteObject(target, useEtag);
      return res.json({ url: newUrl });
    }
    const newEtag = await source.client.putObject(target, data, 'text/calendar', useEtag);
    res.json({ url: target, etag: newEtag });
  }));

  /**
   * Löschen. scope=this&recurrenceId=…: nur dieses Vorkommen einer Serie.
   * notify=1: bei einer Einladung Absage (DECLINED) an den Organisator senden.
   */
  r.delete('/events', wrap(async (req, res) => {
    const source = await svc.getSource(req.user, req.query.sourceId);
    const target = source.client.assertOwnUrl(req.query.url);
    const notify = req.query.notify === '1';
    const tz = req.query.tz;
    let current = null;
    if (notify || req.query.scope === 'this') current = await source.client.getObject(target);
    let notified = null;
    if (req.query.scope === 'this' && req.query.recurrenceId) {
      const upd = ics.deleteOccurrence(current.data, req.query.recurrenceId);
      if (notify) notified = await notifyDelete(req, current.data, upd.recurrenceId, tz);
      await source.client.putObject(target, upd.data, 'text/calendar', current.etag || undefined);
      return res.json({ ok: true, notified });
    }
    if (notify) notified = await notifyDelete(req, current.data, null, tz);
    await source.client.deleteObject(target, req.query.etag || undefined);
    res.json({ ok: true, notified });
  }));

  async function notifyDelete(req, data, recurrenceId, tz) {
    try {
      const r2 = await scheduling.sendReply(req.user, data, 'DECLINED', { recurrenceId, tz });
      return { replied: r2.sent };
    } catch (err) {
      return { error: err.message };
    }
  }

  /** Eigene Antwort auf eine Einladung ändern (aus dem Kalender). body: { sourceId, url, partstat, notify, tz, comment } */
  r.post('/events/respond', wrap(async (req, res) => {
    const partstat = String(req.body.partstat || '').toUpperCase();
    if (!['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(partstat)) return res.status(400).json({ error: 'Ungültige Antwort' });
    const source = await svc.getSource(req.user, req.body.sourceId);
    const target = source.client.assertOwnUrl(req.body.url);
    const current = await source.client.getObject(target);
    const inv = ics.parseInvitation(current.data, await scheduling.myEmails(req.user));
    if (!inv.me) return res.status(400).json({ error: 'Du bist bei diesem Termin nicht als Teilnehmer eingetragen' });
    const data = ics.setMyPartstat(current.data, inv.me, partstat);
    const etag = await source.client.putObject(target, data, 'text/calendar', current.etag || undefined);
    let notified = null;
    if (req.body.notify !== false) {
      try { notified = await scheduling.sendReply(req.user, data, partstat, { tz: req.body.tz, comment: req.body.comment }); } catch (err) { notified = { error: err.message }; }
    }
    res.json({ ok: true, etag, partstat, notified });
  }));

  // ------------------------------------------------------------ Kontakte
  r.get('/contacts', wrap(async (req, res) => {
    const source = await svc.getSource(req.user, req.query.sourceId);
    const book = collUrl(source, req.query.book);
    const items = await source.client.addressbookQuery(book);
    const contacts = items.map((it) => {
      const { photo, ...c } = vcard.parse(it.data);
      return { ...c, hasPhoto: !!photo, url: it.url, etag: it.etag };
    });
    contacts.sort((a, b) => (a.fn || '').localeCompare(b.fn || '', 'de', { sensitivity: 'base' }));
    res.json({ contacts });
  }));

  r.post('/contacts', wrap(async (req, res) => {
    const { sourceId, book, contact } = req.body;
    const source = await svc.getSource(req.user, sourceId);
    const b = collUrl(source, book);
    const { uid, data } = vcard.build(contact || {});
    const url = `${b}${encodeURIComponent(uid)}.vcf`;
    const etag = await source.client.putObject(url, data, 'text/vcard');
    svc.invalidate(req.user, '__contacts__');
    res.json({ url, etag });
  }));

  r.put('/contacts', wrap(async (req, res) => {
    const { sourceId, url, etag, contact } = req.body;
    const source = await svc.getSource(req.user, sourceId);
    const target = source.client.assertOwnUrl(url);
    const current = await source.client.getObject(target);
    const prev = vcard.parse(current.data);
    const { data } = vcard.build({ ...contact, uid: prev.uid || contact.uid }, current.data);
    const newEtag = await source.client.putObject(target, data, 'text/vcard', etag || current.etag);
    svc.invalidate(req.user, '__contacts__');
    res.json({ url: target, etag: newEtag });
  }));

  /** Adressbuch als .vcf herunterladen */
  r.get('/contacts/export', wrap(async (req, res) => {
    const source = await svc.getSource(req.user, req.query.sourceId);
    const book = collUrl(source, req.query.book);
    const items = await source.client.addressbookQuery(book);
    const body = items.map((it) => String(it.data).trim().replace(/\r?\n/g, '\r\n')).join('\r\n') + '\r\n';
    const name = String(req.query.name || 'kontakte').replace(/[^\w\-äöüÄÖÜ ]+/g, '_').trim() || 'kontakte';
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}.vcf`);
    res.end(body);
  }));

  /** .vcf-Datei (eine oder viele vCards) in ein Adressbuch importieren. body: { sourceId, book, data } */
  r.post('/contacts/import', wrap(async (req, res) => {
    const source = await svc.getSource(req.user, req.body.sourceId);
    const book = collUrl(source, req.body.book);
    const cards = String(req.body.data || '').replace(/\r\n?/g, '\n').match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || [];
    if (!cards.length) return res.status(400).json({ error: 'Die Datei enthält keine Kontakte (vCard)' });
    if (cards.length > 5000) return res.status(400).json({ error: 'Zu viele Kontakte auf einmal (höchstens 5000)' });
    let imported = 0;
    const failed = [];
    for (const raw of cards) {
      let text = raw.replace(/\n/g, '\r\n');
      let uid = (text.match(/^UID:(.+)$/mi) || [])[1];
      uid = uid ? uid.trim() : crypto.randomUUID();
      if (!/^UID:/mi.test(text)) text = text.replace(/\r\nEND:VCARD/i, `\r\nUID:${uid}\r\nEND:VCARD`);
      const url = `${book}${encodeURIComponent(uid.replace(/[\/\\]/g, '_'))}.vcf`;
      try {
        try {
          await source.client.putObject(url, `${text}\r\n`, 'text/vcard');
        } catch (err) {
          if (err.status !== 412) throw err;
          // gleicher Kontakt schon vorhanden (gleiche UID) → aktualisieren
          const cur = await source.client.getObject(url);
          await source.client.putObject(url, `${text}\r\n`, 'text/vcard', cur.etag || undefined);
        }
        imported++;
      } catch (err) {
        failed.push(`${(vcard.parse(text).fn || uid)}: ${err.message}`);
      }
    }
    svc.invalidate(req.user, '__contacts__');
    res.json({ imported, failed: failed.slice(0, 20), total: cards.length });
  }));

  r.delete('/contacts', wrap(async (req, res) => {
    const source = await svc.getSource(req.user, req.query.sourceId);
    await source.client.deleteObject(source.client.assertOwnUrl(req.query.url), req.query.etag || undefined);
    svc.invalidate(req.user, '__contacts__');
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ Kontaktfotos
  /**
   * E-Mail-Adressen aus den Adressbüchern: `emails` = mit Kontaktfoto (Avatare),
   * `known` = alle Kontaktadressen (z. B. Bilder in Mails dieser Absender automatisch anzeigen).
   */
  r.get('/contact-photos', wrap(async (req, res) => {
    const contacts = await svc.allContacts(req.user);
    const emails = new Set();
    const known = new Set();
    for (const c of contacts) {
      for (const e of c.emails || []) {
        const v = String(e.value || '').trim().toLowerCase();
        if (!v) continue;
        known.add(v);
        if (c.photo) emails.add(v);
      }
    }
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json({ emails: [...emails], known: [...known] });
  }));

  /** Foto ausliefern: ?email=… (Mail-Ansicht) oder ?sourceId=…&url=… (Kontaktliste) */
  r.get('/contact-photo', wrap(async (req, res) => {
    let photo = null;
    if (req.query.email) {
      const email = String(req.query.email).toLowerCase();
      const contacts = await svc.allContacts(req.user);
      const hit = contacts.find((c) => c.photo && c.emails.some((e) => e.value.toLowerCase() === email));
      photo = hit && hit.photo;
    } else if (req.query.url) {
      const source = await svc.getSource(req.user, req.query.sourceId);
      const obj = await source.client.getObject(source.client.assertOwnUrl(req.query.url));
      photo = vcard.parse(obj.data).photo;
    }
    const m = photo && String(photo).match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/i);
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1].toLowerCase());
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(Buffer.from(m[2], 'base64'));
  }));

  return r;
}

module.exports = { router };
