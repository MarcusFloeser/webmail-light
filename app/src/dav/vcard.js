'use strict';

/**
 * Minimaler vCard-3.0/4.0-Parser und -Generator.
 * Unbekannte Eigenschaften (Fotos, Adressen, X-Felder ...) bleiben beim
 * Bearbeiten erhalten.
 */
const crypto = require('crypto');

const MANAGED = new Set(['FN', 'N', 'EMAIL', 'TEL', 'ADR', 'ORG', 'TITLE', 'NOTE', 'BDAY', 'URL', 'REV', 'PRODID']);

function unfold(data) {
  return String(data || '').replace(/\r?\n[ \t]/g, '');
}

function unescapeText(v) {
  return String(v).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function escapeText(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

/** Teilt eine Zeile in Name, Parameter und Wert (Doppelpunkte in "..." beachten). */
function splitLine(line) {
  let inQuote = false;
  let idx = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) { idx = i; break; }
  }
  if (idx < 0) return null;
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = head.split(';');
  let name = parts.shift().toUpperCase();
  const group = name.includes('.') ? name.split('.')[0] : null;
  if (group) name = name.split('.').slice(1).join('.');
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    // vCard 2.1-Kurzform ("TEL;CELL:...") als TYPE behandeln
    const k = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
    const v = (eq < 0 ? p : p.slice(eq + 1)).replace(/^"|"$/g, '');
    params[k] = params[k] ? `${params[k]},${v}` : v; // mehrfaches TYPE= zusammenführen
  }
  return { name, group, params, value };
}

function typeOf(params) {
  const t = (params.TYPE || '').toLowerCase().split(',').filter((x) => x && x !== 'internet' && x !== 'pref' && x !== 'voice');
  return t[0] || '';
}

/** PHOTO (vCard 3: ENCODING=b; vCard 4: data:-URI oder URL) als data:-URI bzw. URL */
function photoValue(l) {
  const v = l.value.replace(/\s+/g, '');
  if (/^data:image\//i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return v;
  const enc = (l.params.ENCODING || '').toLowerCase();
  if (enc === 'b' || enc === 'base64' || /^[A-Za-z0-9+/=]{40,}$/.test(v)) {
    const type = ((l.params.TYPE || l.params.MEDIATYPE || 'jpeg').split(',')[0] || 'jpeg').toLowerCase().replace(/^image\//, '');
    return `data:image/${type === 'jpg' ? 'jpeg' : type};base64,${v}`;
  }
  return null;
}

function parse(data) {
  const lines = unfold(data).split(/\r?\n/).filter(Boolean);
  const c = { uid: '', fn: '', firstName: '', lastName: '', org: '', title: '', note: '', birthday: '', website: '', photo: null, emails: [], phones: [], addresses: [] };
  for (const raw of lines) {
    const l = splitLine(raw);
    if (!l) continue;
    switch (l.name) {
      case 'UID': c.uid = l.value; break;
      case 'FN': c.fn = unescapeText(l.value); break;
      case 'N': {
        const [last = '', first = ''] = l.value.split(/(?<!\\);/);
        c.lastName = unescapeText(last);
        c.firstName = unescapeText(first);
        break;
      }
      case 'EMAIL': c.emails.push({ type: typeOf(l.params), value: unescapeText(l.value).replace(/^mailto:/i, '') }); break;
      case 'TEL': c.phones.push({ type: typeOf(l.params), value: unescapeText(l.value).replace(/^tel:/i, '') }); break;
      case 'ADR': {
        // PO-Box;Erweitert;Strasse;Ort;Region;PLZ;Land
        const p = l.value.split(/(?<!\\);/).map(unescapeText);
        const street = [p[2], p[1]].filter(Boolean).join('\n') || p[0] || '';
        c.addresses.push({
          type: typeOf(l.params),
          street,
          city: p[3] || '',
          region: p[4] || '',
          postalCode: p[5] || '',
          country: p[6] || '',
          label: l.params.LABEL ? unescapeText(l.params.LABEL) : '',
        });
        break;
      }
      case 'ORG': c.org = unescapeText(l.value.split(/(?<!\\);/)[0]); break;
      case 'TITLE': c.title = unescapeText(l.value); break;
      case 'NOTE': c.note = unescapeText(l.value); break;
      case 'BDAY': c.birthday = l.value.replace(/^(\d{4})(\d{2})(\d{2}).*$/, '$1-$2-$3').slice(0, 10); break;
      case 'URL': c.website = l.value; break;
      case 'PHOTO': c.photo = photoValue(l); break;
      default: break;
    }
  }
  if (!c.fn) c.fn = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.org || (c.emails[0] && c.emails[0].value) || '';
  return c;
}

function fold(line) {
  // RFC 6350: Zeilen max. 75 Oktette – vereinfachend nach Zeichen falten
  const out = [];
  let s = line;
  while (s.length > 74) {
    out.push(s.slice(0, 74));
    s = ' ' + s.slice(74);
  }
  out.push(s);
  return out.join('\r\n');
}

/** Erzeugt/aktualisiert eine vCard. existing = Original-Text (optional). */
function build(contact, existing) {
  const uid = contact.uid || crypto.randomUUID();
  const keep = [];
  let version = '3.0';
  if (existing) {
    for (const raw of unfold(existing).split(/\r?\n/)) {
      if (!raw || /^(BEGIN|END):VCARD$/i.test(raw)) continue;
      const l = splitLine(raw);
      if (!l) continue;
      if (l.name === 'VERSION') { version = l.value; continue; }
      if (l.name === 'UID') continue;
      if (MANAGED.has(l.name)) continue;
      if (l.name === 'PHOTO' && contact.photo !== undefined) continue; // Foto wird ersetzt/entfernt
      keep.push(raw);
    }
  }
  const fn = contact.fn || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.org
    || ((contact.emails || [])[0] || {}).value || 'Unbenannt';
  const lines = ['BEGIN:VCARD', `VERSION:${version}`, 'PRODID:-//Webmail//DE', `UID:${uid}`, `FN:${escapeText(fn)}`,
    `N:${escapeText(contact.lastName)};${escapeText(contact.firstName)};;;`];
  for (const e of contact.emails || []) {
    if (!e.value) continue;
    lines.push(`EMAIL;TYPE=${e.type ? 'INTERNET,' + e.type.toUpperCase() : 'INTERNET'}:${e.value.trim()}`);
  }
  for (const p of contact.phones || []) {
    if (!p.value) continue;
    lines.push(`TEL${p.type ? ';TYPE=' + p.type.toUpperCase() : ''}:${escapeText(p.value.trim())}`);
  }
  for (const a of contact.addresses || []) {
    if (!a || !(a.street || a.city || a.postalCode || a.country || a.region)) continue;
    const parts = ['', '', a.street, a.city, a.region, a.postalCode, a.country].map((x) => escapeText(String(x || '').trim()));
    lines.push(`ADR${a.type ? ';TYPE=' + a.type.toUpperCase() : ''}:${parts.join(';')}`);
  }
  if (contact.org) lines.push(`ORG:${escapeText(contact.org)}`);
  if (contact.title) lines.push(`TITLE:${escapeText(contact.title)}`);
  if (contact.birthday) lines.push(`BDAY:${contact.birthday}`);
  if (contact.website) lines.push(`URL:${contact.website}`);
  if (contact.note) lines.push(`NOTE:${escapeText(contact.note)}`);
  if (contact.photo && contact.photo !== undefined) {
    const m = String(contact.photo).match(/^data:image\/([a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (m && version.startsWith('4')) lines.push(`PHOTO:data:image/${m[1]};base64,${m[2]}`);
    else if (m) lines.push(`PHOTO;ENCODING=b;TYPE=${m[1].toUpperCase()}:${m[2]}`);
    else if (/^https?:\/\//i.test(contact.photo)) lines.push(`PHOTO${version.startsWith('4') ? '' : ';VALUE=uri'}:${contact.photo}`);
  }
  lines.push(...keep);
  lines.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  lines.push('END:VCARD');
  return { uid, data: lines.map(fold).join('\r\n') + '\r\n' };
}

module.exports = { parse, build };
