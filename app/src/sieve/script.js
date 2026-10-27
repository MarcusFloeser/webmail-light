'use strict';

/**
 * Sieve-Script der Webmail erzeugen und wieder einlesen.
 *
 * Die Formulardaten stehen als Base64-JSON im Kommentar „# webmail-data:“ – so lässt sich das
 * Script ohne Sieve-Parser wieder bearbeiten. Das Script heisst „webmail“.
 *
 * data = {
 *   vacation: { enabled, subject, text, days, start: 'YYYY-MM-DD'|'', end: 'YYYY-MM-DD'|'', addresses: [] },
 *   rules: [{ id, name, enabled, match: 'all'|'any',
 *             conditions: [{ field: from|to|cc|tocc|subject|header, header, op: contains|not_contains|is|not_is, value }],
 *             actions: [{ type: fileinto|seen|flag|redirect|discard, folder, address, copy }], stop }],
 *   includeOther: 'sogo' | null   – bisher aktives Script (z. B. SOGo-Filter) weiter ausführen
 * }
 */
const SCRIPT_NAME = 'webmail';
const MARK = '# webmail-data: ';

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const list = (a) => (a.length === 1 ? q(a[0]) : `[${a.map(q).join(', ')}]`);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,76}$/;

function httpError(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

const FIELDS = ['from', 'to', 'cc', 'tocc', 'subject', 'header'];
const OPS = ['contains', 'not_contains', 'is', 'not_is'];
const ACTIONS = ['fileinto', 'seen', 'flag', 'redirect', 'discard'];

/** Eingaben prüfen und vereinheitlichen. */
function normalize(input) {
  const d = input || {};
  const v = d.vacation || {};
  const vacation = {
    enabled: !!v.enabled,
    subject: String(v.subject || '').trim().slice(0, 200),
    text: String(v.text || '').replace(/\r\n/g, '\n').slice(0, 10000),
    days: Math.min(30, Math.max(1, parseInt(v.days, 10) || 1)),
    start: DATE_RE.test(v.start || '') ? v.start : '',
    end: DATE_RE.test(v.end || '') ? v.end : '',
    addresses: (Array.isArray(v.addresses) ? v.addresses : []).map((a) => String(a).trim().toLowerCase()).filter((a) => EMAIL_RE.test(a)).slice(0, 50),
  };
  if (vacation.enabled && !vacation.text.trim()) throw httpError('Bitte einen Text für die Abwesenheitsnotiz eingeben');
  if (vacation.start && vacation.end && vacation.end < vacation.start) throw httpError('Das Ende der Abwesenheit liegt vor dem Beginn');

  const rules = (Array.isArray(d.rules) ? d.rules : []).slice(0, 200).map((r, i) => {
    const conditions = (Array.isArray(r.conditions) ? r.conditions : []).map((c) => ({
      field: FIELDS.includes(c.field) ? c.field : 'from',
      header: String(c.header || '').trim(),
      op: OPS.includes(c.op) ? c.op : 'contains',
      value: String(c.value ?? '').slice(0, 500),
    })).filter((c) => c.value.trim() !== '');
    const name = String(r.name || '').trim().slice(0, 100) || `Regel ${i + 1}`;
    for (const c of conditions) {
      if (c.field === 'header' && !HEADER_RE.test(c.header)) throw httpError(`„${name}“: ungültiger Kopfzeilen-Name „${c.header}“`);
    }
    const actions = (Array.isArray(r.actions) ? r.actions : []).map((a) => ({
      type: ACTIONS.includes(a.type) ? a.type : null,
      folder: String(a.folder || '').trim(),
      address: String(a.address || '').trim(),
      copy: !!a.copy,
    })).filter((a) => a.type);
    for (const a of actions) {
      if (a.type === 'fileinto' && !a.folder) throw httpError(`„${name}“: Bitte einen Ordner wählen`);
      if (a.type === 'redirect' && !EMAIL_RE.test(a.address)) throw httpError(`„${name}“: ungültige Weiterleitungsadresse`);
    }
    if (r.enabled !== false && !actions.length) throw httpError(`„${name}“: Bitte mindestens eine Aktion wählen`);
    return {
      id: String(r.id || `r${Date.now().toString(36)}${i}`).slice(0, 40),
      name,
      enabled: r.enabled !== false,
      match: r.match === 'any' ? 'any' : 'all',
      conditions,
      actions,
      stop: r.stop !== false,
    };
  });
  const includeOther = typeof d.includeOther === 'string' && d.includeOther && d.includeOther !== SCRIPT_NAME
    ? d.includeOther.slice(0, 100) : null;
  return { vacation, rules, includeOther };
}

/**
 * Eine Bedingung als Sieve-Test.
 * Platzhalter wie in Mailprogrammen üblich: * = beliebige Zeichen, ? = genau ein Zeichen
 * (dann :matches statt :contains/:is). Nur „*“ bedeutet „jede Nachricht“.
 */
function test(c) {
  let val = c.value;
  const neg = c.op === 'not_contains' || c.op === 'not_is';
  if (/^\*+$/.test(val.trim())) return neg ? 'false' : 'true';
  let match = c.op === 'is' || c.op === 'not_is' ? ':is' : ':contains';
  if (/[*?]/.test(val)) {
    if (match === ':contains') val = `${val.startsWith('*') ? '' : '*'}${val}${val.endsWith('*') ? '' : '*'}`;
    match = ':matches';
  }
  let t;
  if (c.field === 'subject') t = `header ${match} "subject" ${q(val)}`;
  else if (c.field === 'header') t = `header ${match} ${q(c.header)} ${q(val)}`;
  else if (c.field === 'tocc') t = `address ${match} ["to", "cc"] ${q(val)}`;
  else t = `address ${match} ${q(c.field)} ${q(val)}`;
  return neg ? `not ${t}` : t;
}

/** Sieve-Script aus den Daten erzeugen. → { script, active: bool (gibt es etwas auszuführen?) } */
function generate(input) {
  const d = normalize(input);
  const req = new Set();
  const body = [];
  const enabledRules = d.rules.filter((r) => r.enabled);

  if (d.includeOther) {
    req.add('include');
    body.push(`# Bisherige Filter (z. B. aus SOGo) weiter ausführen`, `include :personal :optional ${q(d.includeOther)};`, '');
  }

  // Abwesenheit zuerst: auch Mails, die ein Filter verschiebt, bekommen eine Antwort
  const v = d.vacation;
  if (v.enabled) {
    req.add('vacation');
    const conds = ['not header :contains "X-Spam-Flag" "YES"', 'not header :contains "X-Spam" "Yes"'];
    if (v.start || v.end) {
      req.add('date');
      req.add('relational');
      if (v.start) conds.push(`currentdate :value "ge" "date" ${q(v.start)}`);
      if (v.end) conds.push(`currentdate :value "le" "date" ${q(v.end)}`);
    }
    const args = [`:days ${v.days}`];
    if (v.subject) args.push(`:subject ${q(v.subject)}`);
    if (v.addresses.length) args.push(`:addresses ${list(v.addresses)}`);
    body.push('# Abwesenheitsnotiz', `if allof (${conds.join(', ')}) {`, `  vacation ${args.join(' ')} ${q(v.text)};`, '}', '');
  }

  for (const r of enabledRules) {
    const acts = [];
    // Flags vor dem Ablegen setzen, damit sie mit abgelegt werden
    if (r.actions.some((a) => a.type === 'seen')) { req.add('imap4flags'); acts.push('addflag "\\\\Seen";'); }
    if (r.actions.some((a) => a.type === 'flag')) { req.add('imap4flags'); acts.push('addflag "\\\\Flagged";'); }
    for (const a of r.actions) {
      if (a.type === 'fileinto') { req.add('fileinto'); acts.push(`fileinto ${q(a.folder)};`); }
      if (a.type === 'redirect') {
        if (a.copy) { req.add('copy'); acts.push(`redirect :copy ${q(a.address)};`); } else acts.push(`redirect ${q(a.address)};`);
      }
    }
    if (r.actions.some((a) => a.type === 'discard')) acts.push('discard;');
    if (r.stop) acts.push('stop;');
    if (!acts.length) continue;
    const tests = r.conditions.map(test);
    const cond = !tests.length ? 'true' : tests.length === 1 ? tests[0] : `${r.match === 'any' ? 'anyof' : 'allof'} (${tests.join(', ')})`;
    body.push(`# ${r.name.replace(/[\r\n]+/g, ' ')}`, `if ${cond} {`, ...acts.map((x) => `  ${x}`), '}', '');
  }

  const data = Buffer.from(JSON.stringify(d), 'utf8').toString('base64');
  const head = [
    '# Erstellt von der Webmail (Einstellungen → Filter & Abwesenheit).',
    '# Bitte nicht von Hand bearbeiten – Änderungen werden beim nächsten Speichern überschrieben.',
    `${MARK}${data}`,
  ];
  if (req.size) head.push(`require [${[...req].sort().map(q).join(', ')}];`);
  return {
    script: `${[...head, '', ...body].join('\r\n').replace(/(\r\n)+$/, '')}\r\n`,
    active: v.enabled || enabledRules.length > 0 || !!d.includeOther,
    data: d,
  };
}

/** Daten aus einem Webmail-Script lesen (null, wenn kein Webmail-Script). */
function parse(script) {
  const line = String(script || '').split(/\r?\n/).find((l) => l.startsWith(MARK));
  if (!line) return null;
  try {
    return normalize(JSON.parse(Buffer.from(line.slice(MARK.length).trim(), 'base64').toString('utf8')));
  } catch (_) { return null; }
}

/** Enthält ein (fremdes) Script eine Abwesenheitsnotiz? (grobe Prüfung, für einen Hinweis) */
const hasVacation = (script) => /(^|[\s;{])vacation\s/m.test(String(script || '').replace(/#.*$/gm, ''));

function empty() {
  return { vacation: { enabled: false, subject: '', text: '', days: 1, start: '', end: '', addresses: [] }, rules: [], includeOther: null };
}

module.exports = { SCRIPT_NAME, generate, parse, normalize, hasVacation, empty };
