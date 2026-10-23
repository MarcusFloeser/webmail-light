'use strict';

/** Reine Hilfsfunktionen ohne externe Abhängigkeiten (gut testbar). */

const MSGID_RE = /<[^<>\s]+>/g;

function extractMessageIds(value) {
  if (!value) return [];
  const s = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  return [...new Set((s.match(MSGID_RE) || []).map((x) => x.trim()))];
}

/** Liest einen Header-Wert aus einem Header-Block (mit Folding). */
function headerValue(headerBlock, name) {
  if (!headerBlock) return '';
  const s = (Buffer.isBuffer(headerBlock) ? headerBlock.toString('utf8') : String(headerBlock)).replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp('^' + name.replace(/[-]/g, '\\-') + ':\\s*(.*)$', 'im');
  const m = s.match(re);
  return m ? m[1].trim() : '';
}

function normalizeMessageId(id) {
  if (!id) return null;
  const ids = extractMessageIds(id);
  if (ids.length) return ids[0];
  const t = String(id).trim();
  return t ? `<${t.replace(/^<|>$/g, '')}>` : null;
}

/** Prüft rekursiv eine IMAP-BODYSTRUCTURE auf Anhänge. */
function hasAttachments(node) {
  if (!node) return false;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    return node.childNodes.some(hasAttachments);
  }
  const type = String(node.type || '').toLowerCase();
  const disp = String(node.disposition || '').toLowerCase();
  const filename = (node.dispositionParameters && node.dispositionParameters.filename)
    || (node.parameters && node.parameters.name);
  if (disp === 'attachment') return true;
  if (type === 'text/calendar') return true;
  if (filename && !type.startsWith('text/') && disp !== 'inline') return true;
  if (filename && type.startsWith('application/')) return true;
  return false;
}

const SPECIAL_NAMES = {
  '\\Sent': ['sent', 'sent items', 'sent mail', 'sent messages', 'gesendet', 'gesendete elemente', 'gesendete objekte', 'envoyés', 'inviata'],
  '\\Trash': ['trash', 'deleted', 'deleted items', 'deleted messages', 'papierkorb', 'gelöschte elemente', 'gelöschte objekte', 'corbeille', 'bin'],
  '\\Drafts': ['drafts', 'draft', 'entwürfe', 'entwurf', 'brouillons'],
  '\\Junk': ['junk', 'spam', 'junk e-mail', 'junk-e-mail', 'bulk mail', 'spamverdacht'],
  '\\Archive': ['archive', 'archiv', 'archives'],
};

function guessSpecialUse(entry) {
  if (entry.specialUse) return entry.specialUse;
  if (String(entry.path).toUpperCase() === 'INBOX') return '\\Inbox';
  const name = String(entry.name || '').toLowerCase();
  for (const [use, names] of Object.entries(SPECIAL_NAMES)) {
    if (names.includes(name)) return use;
  }
  return null;
}

function normalizeSubject(subject) {
  return String(subject || '')
    .replace(/^\s*((re|aw|fw|fwd|wg|sv|antw|vs|r|rif|tr)(\[\d+\])?\s*:\s*)+/i, '')
    .trim();
}

function addrList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && (a.address || a.name))
    .map((a) => ({ name: a.name || '', address: (a.address || '').toLowerCase() }));
}

/** Komprimiert eine sortierte UID-Liste zu einer IMAP-Sequenz "1:5,7,9:12". */
function uidRange(uids) {
  const sorted = [...new Set(uids.map(Number))].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const u of sorted) {
    if (start === null) { start = prev = u; continue; }
    if (u === prev + 1) { prev = u; continue; }
    parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = prev = u;
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}:${prev}`);
  return parts.join(',');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makePreview(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

module.exports = {
  extractMessageIds, headerValue, normalizeMessageId, hasAttachments, guessSpecialUse,
  normalizeSubject, addrList, uidRange, chunk, htmlToText, makePreview,
};
