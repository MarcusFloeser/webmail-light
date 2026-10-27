'use strict';

/**
 * Schlanker CalDAV/CardDAV-Client (RFC 4791 / 6352 / 6764).
 * Anmeldung per Basic Auth (Nextcloud, mailcow/SOGo, Radicale, Baïkal,
 * mailbox.org, iCloud, Fastmail …).
 */
const { XMLParser } = require('fast-xml-parser');

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" '
  + 'xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true, // &#246; / &#xF6; -> ö (Radicale u. a. kodieren Nicht-ASCII so)
  isArray: (name) => ['response', 'propstat', 'href', 'comp'].includes(name),
});

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Numerische XML-Zeichenreferenzen auflösen (Fallback, falls der Parser sie stehen lässt). */
function decodeCharRefs(s) {
  return s.replace(/&#(x[0-9a-f]+|\d+);/gi, (m, n) => {
    const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    try { return String.fromCodePoint(cp); } catch { return m; }
  });
}

function text(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return v['#text'] !== undefined ? decodeCharRefs(String(v['#text'])) : '';
  return decodeCharRefs(String(v));
}

function firstHref(v) {
  if (!v) return null;
  const h = Array.isArray(v.href) ? v.href[0] : v.href;
  return h ? text(h) : null;
}

class DavError extends Error {
  constructor(status, message) {
    super(message || `DAV-Fehler ${status}`);
    this.status = status;
  }
}

class DavClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   Start-URL (bei Radicale: http://radicale:5232/<user>/)
   * @param {string} [o.username]
   * @param {string} [o.password]
   * @param {string} [o.remoteUser]  setzt X-Remote-User statt Basic Auth
   */
  constructor(o) {
    this.baseUrl = o.baseUrl.endsWith('/') ? o.baseUrl : o.baseUrl + '/';
    this.username = o.username || '';
    this.password = o.password || '';
    this.remoteUser = o.remoteUser || null;
    this.origin = new URL(this.baseUrl).origin;
  }

  resolve(href) {
    return new URL(href, this.baseUrl).toString();
  }

  /** Verhindert, dass der Browser beliebige URLs über uns abfragt (SSRF/fremde Daten). */
  assertOwnUrl(url) {
    const u = new URL(url, this.baseUrl);
    const base = new URL(this.baseUrl);
    const site = (h) => h.split('.').slice(-2).join('.');
    const sameOrigin = u.origin === this.origin;
    // iCloud & Co. liefern Kalender auf Unter-Hosts derselben Domain aus
    const sameSite = !this.remoteUser && u.protocol === base.protocol && site(u.hostname) === site(base.hostname);
    if (!sameOrigin && !sameSite) throw new DavError(400, 'URL gehört nicht zu dieser Quelle');
    if (this.remoteUser && !u.pathname.startsWith(new URL(this.baseUrl).pathname)) {
      throw new DavError(403, 'Zugriff verweigert');
    }
    return u.toString();
  }

  headers(extra = {}) {
    const h = { ...extra };
    if (this.remoteUser) h['X-Remote-User'] = this.remoteUser;
    else if (this.username) h.Authorization = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return h;
  }

  async request(method, url, { body, headers = {}, depth } = {}) {
    const h = this.headers(headers);
    if (depth !== undefined) h.Depth = String(depth);
    if (body && !h['Content-Type']) h['Content-Type'] = 'application/xml; charset=utf-8';
    let res;
    try {
      res = await fetch(this.resolve(url), { method, headers: h, body, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new DavError(502, `Server nicht erreichbar: ${err.cause ? err.cause.message : err.message}`);
    }
    return res;
  }

  async multistatus(method, url, body, depth) {
    const res = await this.request(method, url, { body, depth });
    if (res.status === 401) throw new DavError(401, 'Anmeldung am DAV-Server fehlgeschlagen');
    if (res.status !== 207) throw new DavError(res.status, `${method} ${url}: HTTP ${res.status}`);
    const xml = await res.text();
    const doc = parser.parse(xml);
    const responses = (doc.multistatus && doc.multistatus.response) || [];
    return responses.map((r) => {
      const href = text(Array.isArray(r.href) ? r.href[0] : r.href);
      const props = {};
      for (const ps of r.propstat || []) {
        if (!/\s2\d\d\s/.test(' ' + text(ps.status) + ' ')) continue;
        Object.assign(props, ps.prop || {});
      }
      return { href, url: this.resolve(href), props, status: text(r.status) };
    });
  }

  propfind(url, propsXml, depth = 0) {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop>${propsXml}</d:prop></d:propfind>`;
    return this.multistatus('PROPFIND', url, body, depth);
  }

  // ------------------------------------------------------------------ Discovery

  async findPrincipal() {
    const candidates = [this.baseUrl, `${this.origin}/.well-known/caldav`, `${this.origin}/.well-known/carddav`, `${this.origin}/`];
    for (const u of candidates) {
      try {
        const r = await this.propfind(u, '<d:current-user-principal/>', 0);
        const href = r[0] && firstHref(r[0].props['current-user-principal']);
        if (href) return this.resolve(href);
      } catch (err) {
        if (err.status === 401) throw err;
      }
    }
    return null;
  }

  async listCollections(homeUrl) {
    const items = await this.propfind(homeUrl,
      '<d:resourcetype/><d:displayname/><ic:calendar-color/><cs:getctag/><d:sync-token/>'
      + '<c:supported-calendar-component-set/><c:calendar-description/><card:addressbook-description/>', 1);
    const out = [];
    for (const it of items) {
      const rt = it.props.resourcetype || {};
      const isCal = typeof rt === 'object' && 'calendar' in rt;
      const isBook = typeof rt === 'object' && 'addressbook' in rt;
      if (!isCal && !isBook) continue;
      let comps = [];
      const scs = it.props['supported-calendar-component-set'];
      if (scs && scs.comp) comps = scs.comp.map((c) => c['@_name']).filter(Boolean);
      if (isCal && comps.length && !comps.includes('VEVENT')) continue; // reine Aufgabenlisten ausblenden
      let color = text(it.props['calendar-color']);
      if (/^#[0-9a-f]{8}$/i.test(color)) color = color.slice(0, 7);
      out.push({
        type: isCal ? 'calendar' : 'addressbook',
        href: new URL(it.url).pathname,
        url: it.url,
        name: text(it.props.displayname) || decodeURIComponent(new URL(it.url).pathname.split('/').filter(Boolean).pop() || ''),
        color: color || null,
        ctag: text(it.props.getctag) || text(it.props['sync-token']) || null,
      });
    }
    return out;
  }

  /** Basis-URL, unter der neue Kalender (type='calendar') bzw. Adressbücher angelegt werden. */
  async homeSet(type) {
    const principal = await this.findPrincipal();
    if (principal) {
      const key = type === 'addressbook' ? 'addressbook-home-set' : 'calendar-home-set';
      const prop = type === 'addressbook' ? '<card:addressbook-home-set/>' : '<c:calendar-home-set/>';
      const r = await this.propfind(principal, prop, 0);
      const v = r[0] && r[0].props[key];
      const href = v && firstHref(v);
      if (href) {
        const u = this.resolve(href);
        return u.endsWith('/') ? u : u + '/';
      }
    }
    return null;
  }

  async discover() {
    const homes = new Set();
    const principal = await this.findPrincipal();
    if (principal) {
      const r = await this.propfind(principal, '<c:calendar-home-set/><card:addressbook-home-set/>', 0);
      const p = (r[0] && r[0].props) || {};
      for (const key of ['calendar-home-set', 'addressbook-home-set']) {
        const v = p[key];
        if (v && v.href) for (const h of v.href) homes.add(this.resolve(text(h)));
      }
    }
    if (!homes.size) homes.add(this.baseUrl);
    const seen = new Set();
    const result = [];
    for (const h of homes) {
      let cols = [];
      try { cols = await this.listCollections(h); } catch (err) { if (err.status === 401) throw err; }
      for (const c of cols) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        result.push(c);
      }
    }
    // Falls die Start-URL selbst schon ein Kalender/Adressbuch ist
    if (!result.length) {
      try {
        const self = await this.propfind(this.baseUrl, '<d:resourcetype/><d:displayname/><ic:calendar-color/>', 0);
        const rt = (self[0] && self[0].props.resourcetype) || {};
        if (typeof rt === 'object' && ('calendar' in rt || 'addressbook' in rt)) {
          result.push({
            type: 'calendar' in rt ? 'calendar' : 'addressbook',
            href: new URL(this.baseUrl).pathname,
            url: this.baseUrl,
            name: text(self[0].props.displayname) || 'Kalender',
            color: text(self[0].props['calendar-color']) || null,
          });
        }
      } catch (_) { /* ignore */ }
    }
    return result;
  }

  // ------------------------------------------------------------------ Collections anlegen

  async mkcalendar(url, name, color) {
    const body = `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar ${NS}><d:set><d:prop>`
      + `<d:displayname>${xmlEscape(name)}</d:displayname>`
      + (color ? `<ic:calendar-color>${xmlEscape(color)}</ic:calendar-color>` : '')
      + '<c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>'
      + '</d:prop></d:set></c:mkcalendar>';
    const res = await this.request('MKCALENDAR', url, { body });
    if (res.status >= 300) throw new DavError(res.status, `Kalender konnte nicht angelegt werden (HTTP ${res.status})`);
  }

  async mkaddressbook(url, name) {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:mkcol ${NS}><d:set><d:prop>`
      + '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'
      + `<d:displayname>${xmlEscape(name)}</d:displayname>`
      + '</d:prop></d:set></d:mkcol>';
    const res = await this.request('MKCOL', url, { body });
    if (res.status >= 300) throw new DavError(res.status, `Adressbuch konnte nicht angelegt werden (HTTP ${res.status})`);
  }

  async proppatch(url, propsXml) {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propertyupdate ${NS}><d:set><d:prop>${propsXml}</d:prop></d:set></d:propertyupdate>`;
    const res = await this.request('PROPPATCH', url, { body });
    if (res.status >= 300) throw new DavError(res.status, `Änderung fehlgeschlagen (HTTP ${res.status})`);
  }

  async deleteCollection(url) {
    const res = await this.request('DELETE', url);
    if (res.status >= 300 && res.status !== 404) throw new DavError(res.status, `Löschen fehlgeschlagen (HTTP ${res.status})`);
  }

  // ------------------------------------------------------------------ Objekte

  async calendarQuery(url, start, end) {
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}>`
      + '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
      + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
      + `<c:time-range start="${fmt(start)}" end="${fmt(end)}"/>`
      + '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
    const items = await this.multistatus('REPORT', url, body, 1);
    return items
      .filter((i) => i.props['calendar-data'])
      .map((i) => ({ href: new URL(i.url).pathname, url: i.url, etag: text(i.props.getetag), data: text(i.props['calendar-data']) }));
  }

  async addressbookQuery(url) {
    const body = `<?xml version="1.0" encoding="utf-8"?><card:addressbook-query ${NS}>`
      + '<d:prop><d:getetag/><card:address-data/></d:prop>'
      + '</card:addressbook-query>';
    let items;
    try {
      items = await this.multistatus('REPORT', url, body, 1);
    } catch (err) {
      // Manche Server verlangen einen Filter
      if (err.status !== 400 && err.status !== 403 && err.status !== 501) throw err;
      const body2 = body.replace('</card:addressbook-query>',
        '<card:filter><card:prop-filter name="FN"/></card:filter></card:addressbook-query>');
      items = await this.multistatus('REPORT', url, body2, 1);
    }
    return items
      .filter((i) => i.props['address-data'])
      .map((i) => ({ href: new URL(i.url).pathname, url: i.url, etag: text(i.props.getetag), data: text(i.props['address-data']) }));
  }

  /** Termin anhand der UID in einem Kalender suchen (zuerst <uid>.ics, dann per REPORT). */
  async findByUid(calUrl, uid) {
    const base = calUrl.endsWith('/') ? calUrl : `${calUrl}/`;
    const direct = `${base}${encodeURIComponent(uid)}.ics`;
    try {
      const o = await this.getObject(direct);
      if (o.data && o.data.includes(uid)) return { url: direct, etag: o.etag, data: o.data };
    } catch (err) {
      if (err.status && err.status !== 404 && err.status !== 410) throw err;
    }
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}>`
      + '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
      + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
      + `<c:prop-filter name="UID"><c:text-match collation="i;octet">${xmlEscape(uid)}</c:text-match></c:prop-filter>`
      + '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
    let items = [];
    try { items = await this.multistatus('REPORT', base, body, 1); } catch (_) { return null; }
    const hit = items.find((i) => i.props['calendar-data'] && text(i.props['calendar-data']).includes(uid));
    return hit ? { url: hit.url, etag: text(hit.props.getetag), data: text(hit.props['calendar-data']) } : null;
  }

  async getObject(url) {
    const res = await this.request('GET', url);
    if (!res.ok) throw new DavError(res.status, `Objekt nicht gefunden (HTTP ${res.status})`);
    return { data: await res.text(), etag: res.headers.get('etag') };
  }

  async putObject(url, data, contentType, etag) {
    const headers = { 'Content-Type': `${contentType}; charset=utf-8` };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    const res = await this.request('PUT', url, { body: data, headers });
    if (res.status === 412) throw new DavError(412, 'Der Eintrag wurde inzwischen von jemand anderem geändert – bitte neu laden');
    if (res.status >= 300) throw new DavError(res.status, `Speichern fehlgeschlagen (HTTP ${res.status})`);
    return res.headers.get('etag');
  }

  async deleteObject(url, etag) {
    const headers = {};
    if (etag) headers['If-Match'] = etag;
    const res = await this.request('DELETE', url, { headers });
    if (res.status === 412) throw new DavError(412, 'Der Eintrag wurde inzwischen geändert – bitte neu laden');
    if (res.status >= 300 && res.status !== 404) throw new DavError(res.status, `Löschen fehlgeschlagen (HTTP ${res.status})`);
  }
}

module.exports = { DavClient, DavError, xmlEscape };
