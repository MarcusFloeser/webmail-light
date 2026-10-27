'use strict';

/**
 * Antworten auf empfangene Einladungen (iMIP, RFC 6047): Zusagen/Vielleicht/Absagen.
 *
 * Die Webmail erstellt selbst keine Einladungen. Die Antwort geht über das SMTP-Konto der
 * eingeladenen Identität an den Organisator. Im eigenen Kalender gespeicherte Einladungen
 * tragen SCHEDULE-AGENT=CLIENT (RFC 6638) – so verschickt der CalDAV-Server (z. B. SOGo)
 * keine zusätzliche Antwort.
 */
const db = require('../db');
const ics = require('./ics');
const svc = require('./service');
const compose = require('../mail/compose');

const lc = (s) => String(s || '').trim().toLowerCase();

/** Alle Absender-Identitäten des Benutzers (für „bin ich Organisator/Teilnehmer?“). */
async function myIdentities(user) {
  return db.many(
    `SELECT i.id, i.name, i.email, i.is_default FROM identities i JOIN mail_accounts a ON a.id = i.account_id
      WHERE a.user_id = $1 ORDER BY i.is_default DESC, a.id, i.sort_order, i.id`, [user.id]);
}

async function myEmails(user) {
  const ids = await myIdentities(user);
  const set = new Set(ids.map((i) => lc(i.email)));
  if (user.email) set.add(lc(user.email));
  return [...set];
}

/** Identität wählen: ausdrücklich per ID, sonst passend zur Adresse, sonst die Standard-Identität. */
async function pickIdentity(user, { identityId, email } = {}) {
  const ids = await myIdentities(user);
  if (!ids.length) {
    const e = new Error('Keine Absender-Identität vorhanden – bitte zuerst ein Mailkonto einrichten');
    e.status = 400;
    throw e;
  }
  let pick = identityId ? ids.find((i) => String(i.id) === String(identityId)) : null;
  if (!pick && email) pick = ids.find((i) => lc(i.email) === lc(email));
  if (!pick) pick = ids[0];
  return compose.loadIdentity(pick.id, user.id);
}

// ------------------------------------------------------------------ Mailtext

function fmtRange(ev, tz) {
  const opts = { timeZone: tz || undefined };
  try { new Intl.DateTimeFormat('de-CH', opts); } catch (_) { delete opts.timeZone; }
  if (!ev.start) return '';
  const s = new Date(ev.allDay ? `${ev.start}T12:00:00Z` : ev.start);
  if (ev.allDay) {
    const df = new Intl.DateTimeFormat('de-CH', { ...opts, timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const endIncl = ev.end ? new Date(new Date(`${ev.end}T12:00:00Z`).getTime() - 86400000) : s;
    return endIncl > s ? `${df.format(s)} – ${df.format(endIncl)} (ganztägig)` : `${df.format(s)} (ganztägig)`;
  }
  const e = ev.end ? new Date(ev.end) : s;
  const df = new Intl.DateTimeFormat('de-CH', { ...opts, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const tf = new Intl.DateTimeFormat('de-CH', { ...opts, hour: '2-digit', minute: '2-digit' });
  const sameDay = df.format(s) === df.format(e);
  return sameDay ? `${df.format(s)}, ${tf.format(s)} – ${tf.format(e)} Uhr`
    : `${df.format(s)}, ${tf.format(s)} Uhr – ${df.format(e)}, ${tf.format(e)} Uhr`;
}

const FREQ = { DAILY: 'täglich', WEEKLY: 'wöchentlich', MONTHLY: 'monatlich', YEARLY: 'jährlich' };
const FREQN = { DAILY: 'Tage', WEEKLY: 'Wochen', MONTHLY: 'Monate', YEARLY: 'Jahre' };
const DAYS = { MO: 'Mo', TU: 'Di', WE: 'Mi', TH: 'Do', FR: 'Fr', SA: 'Sa', SU: 'So' };

function describeRule(r) {
  if (!r) return '';
  let t = r.interval > 1 ? `alle ${r.interval} ${FREQN[r.freq] || ''}` : (FREQ[r.freq] || r.freq);
  if (r.byday && r.byday.length) t += ` (${r.byday.map((d) => DAYS[d] || d).join(', ')})`;
  if (r.count) t += `, ${r.count} Mal`;
  else if (r.until) t += `, bis ${r.until.split('-').reverse().join('.')}`;
  return t;
}

const PARTSTAT_TEXT = { ACCEPTED: 'zugesagt', DECLINED: 'abgesagt', TENTATIVE: 'mit Vorbehalt zugesagt', 'NEEDS-ACTION': 'noch nicht geantwortet', DELEGATED: 'delegiert' };

function mailText(ev, { tz, who, partstat, comment } = {}) {
  const lines = [];
  lines.push(`${who} hat ${PARTSTAT_TEXT[partstat] || partstat}:`, '');
  lines.push(`Termin: ${ev.title}`);
  const when = fmtRange(ev, tz);
  if (when) lines.push(`Wann:   ${when}`);
  const rule = describeRule(ev.rrule);
  if (rule) lines.push(`Wiederholung: ${rule}`);
  if (ev.location) lines.push(`Ort:    ${ev.location}`);
  if (comment) lines.push('', comment);
  return lines.join('\n');
}

const REPLY_SUBJECT = { ACCEPTED: 'Zugesagt', DECLINED: 'Abgelehnt', TENTATIVE: 'Vorläufig zugesagt' };

/** Daten eines gespeicherten Termins für den Mailtext (erstes Vorkommen bzw. Serienbeginn). */
function summaryOf(data) {
  const inv = ics.parseInvitation(data, []);
  return inv;
}

function occurrenceTimes(data) {
  try { const p = ics.parseInvitation(data, []); return { start: p.start, end: p.end, allDay: p.allDay }; } catch (_) { return {}; }
}

/** Eigene Antwort an den Organisator senden. */
async function sendReply(user, data, partstat, { recurrenceId, tz, comment } = {}) {
  const ev = summaryOf(data);
  if (!ev.organizer || !ev.organizer.email) return { sent: false };
  const mine = await myEmails(user);
  const me = ev.attendees.find((a) => mine.includes(a.email));
  if (!me) return { sent: false, notInvited: true };
  if (mine.includes(lc(ev.organizer.email))) return { sent: false };
  const ident = await pickIdentity(user, { email: me.email });
  const rep = ics.itipReply(data, me.email, partstat, { recurrenceId, name: ident.identity_name });
  const who = ident.identity_name ? `${ident.identity_name} <${ident.identity_email}>` : ident.identity_email;
  await compose.sendItip(ident, {
    to: [ev.organizer], method: 'REPLY', ics: rep.data,
    subject: `${REPLY_SUBJECT[partstat] || partstat}: ${ev.title}`,
    text: mailText(ev, { tz, who, partstat, comment }),
  });
  return { sent: true, me: me.email };
}

/** Termin mit dieser UID in allen Kalendern des Benutzers suchen. */
async function findEvent(user, uid) {
  if (!uid) return null;
  const sources = await svc.getSources(user);
  for (const s of sources) {
    let cals;
    try { cals = (await svc.collections(user, s)).filter((c) => c.type === 'calendar'); } catch (_) { continue; }
    for (const c of cals) {
      try {
        const hit = await s.client.findByUid(c.url, uid);
        if (hit) return { ...hit, source: s, calendar: c };
      } catch (_) { /* nächster Kalender */ }
    }
  }
  return null;
}

module.exports = {
  myIdentities, myEmails, pickIdentity, sendReply, findEvent, mailText, describeRule, PARTSTAT_TEXT,
};
