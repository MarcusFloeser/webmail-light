'use strict';

/** Laden + Parsen kompletter Nachrichten (Body, Anhänge) mit kleinem LRU-Cache. */
const { simpleParser } = require('mailparser');
const db = require('../db');
const manager = require('../imap/manager');
const { makePreview, htmlToText } = require('../imap/util');

const CACHE_MAX = 25;
const cache = new Map(); // messageDbId -> parsed

function cacheGet(id) {
  const v = cache.get(id);
  if (v) { cache.delete(id); cache.set(id, v); }
  return v;
}
function cachePut(id, v) {
  cache.set(id, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Holt eine Nachricht inkl. Ordner/Konto und prüft, dass sie dem Benutzer gehört. */
async function getOwned(messageId, userId) {
  const m = await db.one(
    `SELECT m.*, f.path AS folder_path, f.special_use AS folder_special, f.name AS folder_name
       FROM messages m
       JOIN folders f ON f.id = m.folder_id
       JOIN mail_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.user_id = $2`, [messageId, userId]);
  if (!m) {
    const err = new Error('Nachricht nicht gefunden');
    err.status = 404;
    throw err;
  }
  return m;
}

async function loadParsed(msg) {
  const hit = cacheGet(msg.id);
  if (hit) return hit;
  const worker = manager.get(msg.account_id);
  const source = await worker.fetchSource(msg.folder_path, msg.uid);
  const parsed = await simpleParser(source, { skipTextLinks: true });
  parsed.__source = source;
  cachePut(msg.id, parsed);
  if (!msg.preview) {
    const preview = makePreview(parsed.text || htmlToText(parsed.html || ''));
    db.query('UPDATE messages SET preview = $2 WHERE id = $1', [msg.id, preview]).catch(() => {});
  }
  return parsed;
}

function addrs(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.flatMap((x) => x.value || []).map((a) => ({ name: a.name || '', address: a.address || '' }));
}

function sanitizeHtml(html) {
  // Das HTML wird zusätzlich in einem sandboxed iframe ohne Script-Rechte angezeigt.
  return String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|frame|frameset|applet|meta|base|link)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

function unsubscribeLink(v) {
  if (!v) return null;
  if (typeof v === 'object') {
    if (v.url && /^https?:/i.test(v.url)) return v.url;
    if (v.mail) return 'mailto:' + v.mail;
    return null;
  }
  const m = String(v).match(/<(https?:[^>]+)>/i) || String(v).match(/<(mailto:[^>]+)>/i);
  return m ? m[1] : null;
}

function bodyPayload(msg, parsed) {
  const attachments = (parsed.attachments || []).map((a, idx) => ({
    idx,
    filename: a.filename || (a.contentType === 'text/calendar' ? 'einladung.ics' : `anhang-${idx + 1}`),
    contentType: a.contentType,
    size: a.size || (a.content ? a.content.length : 0),
    inline: !!a.related,
  }));
  let html = parsed.html ? sanitizeHtml(parsed.html) : null;
  const hasRemote = !!(html && /(src|background|poster)\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*['"]?\s*(https?:)?\/\//i.test(html));
  const listUnsub = parsed.headers && parsed.headers.get('list-unsubscribe');
  return {
    id: msg.id,
    subject: parsed.subject || msg.subject,
    from: addrs(parsed.from),
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    bcc: addrs(parsed.bcc),
    replyTo: addrs(parsed.replyTo),
    date: parsed.date || msg.date,
    messageId: parsed.messageId || msg.message_id,
    html,
    text: parsed.text || (parsed.html ? htmlToText(parsed.html) : ''),
    hasRemote,
    attachments: attachments.filter((a) => !a.inline || !html),
    calendar: attachments.filter((a) => /^text\/calendar/i.test(a.contentType) || /\.ics$/i.test(a.filename)).map((a) => a.idx),
    listUnsubscribe: unsubscribeLink(listUnsub),
  };
}

module.exports = { getOwned, loadParsed, bodyPayload, cache };
