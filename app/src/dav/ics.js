'use strict';

/** iCalendar-Hilfen auf Basis von ical.js (Wiederholungen, Zeitzonen). */
const crypto = require('crypto');
const ICAL = require('ical.js');

const MAX_OCCURRENCES = 20000;

const nowUtc = () => ICAL.Time.fromJSDate(new Date(), true);

function registerTimezones(comp) {
  for (const tz of comp.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(tz);
      if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone.tzid, zone);
    } catch (_) { /* fehlerhafte Zeitzone ignorieren */ }
  }
}

function timeOut(t) {
  // Ganztägig: "YYYY-MM-DD", sonst ISO-UTC
  return t.isDate ? t.toString().slice(0, 10) : t.toJSDate().toISOString();
}

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/**
 * Wiederholungsregel lesen. Zusätzlich zu freq/interval/count/until:
 *  byday   – Wochentage bei WEEKLY (['MO', 'WE'])
 *  ordinal + weekday – „am 2. Mittwoch“ (2, 'WE'); ordinal -1 = „am letzten …“  (MONTHLY/YEARLY)
 *  monthday – „am 15.“ bzw. -1 = „am letzten Tag“ (MONTHLY/YEARLY)
 *  month   – Monat bei YEARLY (1–12)
 *  simple  – mit der Webmail vollständig bearbeitbar (sonst bleibt die Regel beim Speichern unverändert)
 */
function rruleInfo(vevent) {
  const p = vevent.getFirstProperty('rrule');
  if (!p) return null;
  const r = p.getFirstValue();
  if (!r) return null;
  const parts = r.parts || {};
  const list = (k) => (parts[k] || []).filter((x) => x !== null && x !== undefined && x !== '');
  const byday = list('BYDAY').map((d) => String(d).toUpperCase());
  const bymonthday = list('BYMONTHDAY').map(Number);
  const bymonth = list('BYMONTH').map(Number);
  const bysetpos = list('BYSETPOS').map(Number);
  const others = Object.keys(parts).filter((k) => !['BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST'].includes(k) && list(k).length);
  const out = {
    freq: r.freq,
    interval: r.interval || 1,
    byday: [],
    count: r.count || null,
    until: r.until ? r.until.toString().slice(0, 10) : null,
    ordinal: null, weekday: null, monthday: null, month: null,
    simple: false,
  };
  const plainDays = byday.every((d) => WEEKDAYS.includes(d));
  // „2WE“ oder „WE“ + BYSETPOS=2 (Outlook)
  let ord = null;
  if (byday.length === 1) {
    const m = byday[0].match(/^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/);
    if (m && m[1] && !bysetpos.length) ord = { ordinal: Number(m[1]), weekday: m[2] };
    else if (m && !m[1] && bysetpos.length === 1) ord = { ordinal: bysetpos[0], weekday: m[2] };
  }
  const okOrd = ord && ord.ordinal !== 0 && ord.ordinal >= -1 && ord.ordinal <= 5;
  const okDay = bymonthday.length === 1 && (bymonthday[0] === -1 || (bymonthday[0] >= 1 && bymonthday[0] <= 31));
  if (!others.length) {
    if (r.freq === 'DAILY') out.simple = !byday.length && !bymonthday.length && !bymonth.length && !bysetpos.length;
    else if (r.freq === 'WEEKLY') {
      out.simple = plainDays && !bymonthday.length && !bymonth.length && !bysetpos.length;
      out.byday = plainDays ? byday : [];
    } else if (r.freq === 'MONTHLY' && !bymonth.length) {
      if (!byday.length && !bymonthday.length && !bysetpos.length) out.simple = true;
      else if (okOrd && !bymonthday.length) { Object.assign(out, ord); out.simple = true; } else if (okDay && !byday.length && !bysetpos.length) { out.monthday = bymonthday[0]; out.simple = true; }
    } else if (r.freq === 'YEARLY') {
      if (!byday.length && !bymonthday.length && !bymonth.length && !bysetpos.length) out.simple = true;
      else if (bymonth.length === 1) {
        out.month = bymonth[0];
        if (okOrd && !bymonthday.length) { Object.assign(out, ord); out.simple = true; } else if (okDay && !byday.length && !bysetpos.length) { out.monthday = bymonthday[0]; out.simple = true; }
      }
    }
  }
  if (!out.simple && r.freq === 'WEEKLY' && plainDays) out.byday = byday;
  return out;
}

/**
 * Wiederholungsregel aus den Formularangaben.
 * rule: 'WEEKLY' oder { freq, interval, byday[], count, until, ordinal, weekday, monthday, month }
 */
function makeRecur(rule, dtstart) {
  const r = typeof rule === 'string' ? { freq: rule } : rule;
  const freq = String(r.freq || '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const data = { freq };
  const interval = parseInt(r.interval, 10);
  if (interval > 1) data.interval = Math.min(interval, 999);
  const byday = (Array.isArray(r.byday) ? r.byday : []).map((d) => String(d).toUpperCase()).filter((d) => WEEKDAYS.includes(d));
  if (freq === 'WEEKLY' && byday.length) data.byday = WEEKDAYS.filter((d) => byday.includes(d));
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const ordinal = parseInt(r.ordinal, 10);
    const weekday = String(r.weekday || '').toUpperCase();
    const monthday = parseInt(r.monthday, 10);
    const month = parseInt(r.month, 10);
    if (freq === 'YEARLY' && month >= 1 && month <= 12) data.bymonth = [month];
    if (ordinal && ordinal >= -1 && ordinal <= 5 && WEEKDAYS.includes(weekday)) data.byday = [`${ordinal}${weekday}`];
    else if (monthday === -1 || (monthday >= 1 && monthday <= 31)) data.bymonthday = [monthday];
    // Jährlich ohne Tag: Monat allein ergibt keinen Sinn → Tag vom Beginn
    if (data.bymonth && !data.byday && !data.bymonthday && dtstart) data.bymonthday = [dtstart.day];
  }
  const count = parseInt(r.count, 10);
  if (count > 0) data.count = Math.min(count, 5000);
  else if (r.until && /^\d{4}-\d{2}-\d{2}/.test(r.until)) {
    // UNTIL muss zum Typ von DTSTART passen: ganztägig = Datum, sonst Zeitpunkt (UTC, Tagesende)
    const u = ICAL.Time.fromDateString(String(r.until).slice(0, 10));
    if (dtstart && !dtstart.isDate) {
      const t = ICAL.Time.fromJSDate(new Date(`${String(r.until).slice(0, 10)}T23:59:59`), true);
      data.until = t;
    } else data.until = u;
  }
  return new ICAL.Recur(data);
}

// ------------------------------------------------------------------ Teilnehmer

const mailto = (v) => String(v || '').replace(/^mailto:/i, '').trim().toLowerCase();

function organizerOf(vevent) {
  const p = vevent.getFirstProperty('organizer');
  if (!p) return null;
  return { email: mailto(p.getFirstValue()), name: p.getParameter('cn') || '' };
}

function attendeesOf(vevent) {
  return vevent.getAllProperties('attendee').map((p) => ({
    email: mailto(p.getFirstValue()),
    name: p.getParameter('cn') || '',
    partstat: String(p.getParameter('partstat') || 'NEEDS-ACTION').toUpperCase(),
    role: String(p.getParameter('role') || 'REQ-PARTICIPANT').toUpperCase(),
  })).filter((a) => a.email);
}

/**
 * Organisator und Teilnehmer setzen (eigene Einladung).
 * attendees: [{ email, name }] – ohne den Organisator. Bisherige Antworten (PARTSTAT) bleiben erhalten,
 * ausser reset=true (wesentliche Änderung: Zeit, Ort, Wiederholung → alle neu um Antwort bitten).
 * Keine Teilnehmer → normaler Termin ohne Organisator.
 * SCHEDULE-AGENT=CLIENT: die Webmail verschickt die Einladungen selbst, der CalDAV-Server (SOGo, Nextcloud) nicht.
 */
function setParticipants(vevent, organizer, attendees, { reset = false } = {}) {
  const old = new Map(vevent.getAllProperties('attendee').map((p) => [mailto(p.getFirstValue()), p]));
  const org = organizer ? mailto(organizer.email) : '';
  const seen = new Set([org]);
  const list = [];
  for (const a of attendees || []) {
    const email = mailto(a && a.email);
    if (!email || seen.has(email) || !/^[^\s@]+@[^\s@]+$/.test(email)) continue;
    seen.add(email);
    list.push({ email, name: String((a && a.name) || '').trim() });
  }
  vevent.removeAllProperties('attendee');
  vevent.removeAllProperties('organizer');
  if (!list.length || !org) return;
  const op = new ICAL.Property('organizer');
  op.setValue(`mailto:${org}`);
  if (organizer.name) op.setParameter('cn', organizer.name);
  op.setParameter('schedule-agent', 'CLIENT');
  vevent.addProperty(op);
  const add = (email, name, partstat, role, rsvp) => {
    const p = new ICAL.Property('attendee');
    p.setValue(`mailto:${email}`);
    if (name) p.setParameter('cn', name);
    p.setParameter('role', role);
    p.setParameter('partstat', partstat);
    p.setParameter('cutype', 'INDIVIDUAL');
    if (rsvp) p.setParameter('rsvp', 'TRUE');
    p.setParameter('schedule-agent', 'CLIENT');
    vevent.addProperty(p);
  };
  add(org, organizer.name, 'ACCEPTED', 'CHAIR', false);
  for (const a of list) {
    const prev = old.get(a.email);
    const ps = !reset && prev ? String(prev.getParameter('partstat') || 'NEEDS-ACTION').toUpperCase() : 'NEEDS-ACTION';
    const role = prev ? String(prev.getParameter('role') || 'REQ-PARTICIPANT').toUpperCase() : 'REQ-PARTICIPANT';
    add(a.email, a.name || (prev && prev.getParameter('cn')) || '', ps, role === 'CHAIR' ? 'REQ-PARTICIPANT' : role, ps === 'NEEDS-ACTION');
  }
}

/** Merkmale, deren Änderung eine erneute Zusage erfordert */
function significant(vevent) {
  const g = (n) => { const v = vevent.getFirstPropertyValue(n); return v ? v.toString() : ''; };
  return [g('dtstart'), g('dtend'), g('duration'), g('rrule'), g('location'), vevent.getAllProperties('exdate').map((p) => p.getFirstValue().toString()).join(',')].join('|');
}

/**
 * Erinnerungen (VALARM) als "Minuten vor Beginn".
 * null = keine VALARM vorhanden (-> Standard-Erinnerung des Benutzers greift),
 * []   = ausdrücklich keine Erinnerung.
 */
function alarmsOf(vevent) {
  if (vevent.getFirstPropertyValue('x-webmail-noalarm')) return [];
  const list = vevent.getAllSubcomponents('valarm');
  if (!list.length) return null;
  let durSec = 0;
  try {
    const st = vevent.getFirstPropertyValue('dtstart');
    const en = vevent.getFirstPropertyValue('dtend');
    if (st && en) durSec = en.subtractDate(st).toSeconds();
  } catch (_) { /* ignore */ }
  const out = [];
  for (const a of list) {
    const p = a.getFirstProperty('trigger');
    if (!p) continue;
    const v = p.getFirstValue();
    if (v instanceof ICAL.Duration) {
      let sec = v.toSeconds();
      if (String(p.getParameter('related') || '').toUpperCase() === 'END') sec += durSec;
      out.push(Math.round(-sec / 60));
    } else if (v instanceof ICAL.Time) {
      const st = vevent.getFirstPropertyValue('dtstart');
      if (st) out.push(Math.round((st.toJSDate() - v.toJSDate()) / 60000));
    }
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

function baseFields(vevent) {
  return {
    alarms: alarmsOf(vevent),
    title: vevent.getFirstPropertyValue('summary') || '(ohne Titel)',
    location: vevent.getFirstPropertyValue('location') || '',
    description: vevent.getFirstPropertyValue('description') || '',
    uid: vevent.getFirstPropertyValue('uid') || '',
    organizer: organizerOf(vevent),
    attendees: attendeesOf(vevent),
    status: String(vevent.getFirstPropertyValue('status') || '').toUpperCase(),
  };
}

/** Expandiert ein Kalenderobjekt in Termine innerhalb [start, end). */
function expand(data, rangeStart, rangeEnd) {
  const comp = new ICAL.Component(ICAL.parse(data));
  registerTimezones(comp);
  const vevents = comp.getAllSubcomponents('vevent');
  if (!vevents.length) return [];
  const master = vevents.find((v) => !v.hasProperty('recurrence-id'));
  const exceptions = vevents.filter((v) => v.hasProperty('recurrence-id'));
  const out = [];

  if (!master) {
    for (const ex of exceptions) {
      const ev = new ICAL.Event(ex);
      out.push({ ...baseFields(ex), start: timeOut(ev.startDate), end: timeOut(ev.endDate || ev.startDate), allDay: ev.startDate.isDate, recurring: false });
    }
    return out;
  }

  const ev = new ICAL.Event(master);
  for (const ex of exceptions) {
    try { ev.relateException(ex); } catch (_) { /* ignore */ }
  }

  if (!ev.isRecurring()) {
    const s = ev.startDate;
    let e = ev.endDate;
    if (!e) { e = s.clone(); if (s.isDate) e.day += 1; }
    if (s.toJSDate() < rangeEnd && e.toJSDate() > rangeStart) {
      out.push({ ...baseFields(master), start: timeOut(s), end: timeOut(e), allDay: s.isDate, recurring: false, rrule: null });
    }
    return out;
  }

  const rrule = rruleInfo(master);
  const it = ev.iterator();
  let next;
  let n = 0;
  while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
    const d = ev.getOccurrenceDetails(next);
    const isEx = d.item.component !== master;
    if (isEx && String(d.item.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') continue;
    const s = d.startDate.toJSDate();
    if (s >= rangeEnd) break;
    const e = d.endDate ? d.endDate.toJSDate() : s;
    if (e <= rangeStart && !(e.getTime() === s.getTime() && s >= rangeStart)) continue;
    out.push({
      ...baseFields(d.item.component),
      start: timeOut(d.startDate),
      end: timeOut(d.endDate || d.startDate),
      allDay: d.startDate.isDate,
      recurring: true,
      rrule,
      recurrenceId: next.toString(),
      exception: isEx,
    });
  }
  return out;
}

function makeTime(value, allDay) {
  if (allDay) return ICAL.Time.fromDateString(String(value).slice(0, 10));
  return ICAL.Time.fromJSDate(new Date(value), true);
}

function setText(vevent, name, value) {
  vevent.removeAllProperties(name);
  if (value) vevent.addPropertyWithValue(name, String(value));
}

/** Zeit-Eigenschaft mit passender TZID hinzufügen (wie ICAL.Event#_setTime, aber für mehrfache Eigenschaften). */
function addTimeProp(comp, name, time) {
  const prop = new ICAL.Property(name);
  if (!time.isDate && time.zone && time.zone !== ICAL.Timezone.utcTimezone && time.zone !== ICAL.Timezone.localTimezone && time.zone.tzid) {
    prop.setParameter('tzid', time.zone.tzid);
  }
  prop.setValue(time);
  comp.addProperty(prop);
  return prop;
}

function setTimeProp(comp, name, time) {
  comp.removeAllProperties(name);
  return addTimeProp(comp, name, time);
}

function parseCal(data) {
  const comp = new ICAL.Component(ICAL.parse(data));
  registerTimezones(comp);
  return comp;
}

const masterOf = (comp) => comp.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'))
  || comp.getFirstSubcomponent('vevent');

/** RECURRENCE-ID-Text (aus expand) → ICAL.Time in der Zeitzone des Serienbeginns */
function ridTime(master, rid) {
  const t = ICAL.Time.fromString(String(rid));
  const st = master && master.getFirstPropertyValue('dtstart');
  if (!t.isDate && st && !st.isDate && t.zone !== ICAL.Timezone.utcTimezone) t.zone = st.zone;
  if (st && st.isDate && !t.isDate) t.isDate = true;
  return t;
}

const sameTime = (a, b) => a && b && a.isDate === b.isDate && (a.isDate ? a.toString() === b.toString() : a.toUnixTime() === b.toUnixTime());

function findException(comp, master, rid) {
  return comp.getAllSubcomponents('vevent').find((v) => v.hasProperty('recurrence-id')
    && sameTime(v.getFirstPropertyValue('recurrence-id'), rid));
}

function bumpSequence(vevent) {
  const seq = parseInt(vevent.getFirstPropertyValue('sequence') || '0', 10);
  vevent.updatePropertyWithValue('sequence', seq + 1);
}

function touch(vevent) {
  vevent.updatePropertyWithValue('dtstamp', nowUtc());
  vevent.updatePropertyWithValue('last-modified', nowUtc());
}

function applyReminder(vevent, fields) {
  if (fields.reminder === undefined) return;
  for (const a of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(a);
  vevent.removeAllProperties('x-webmail-noalarm');
  if (fields.reminder === 'none') {
    vevent.addPropertyWithValue('x-webmail-noalarm', 'TRUE');
  } else if (fields.reminder !== null && fields.reminder !== '' && !Number.isNaN(Number(fields.reminder))) {
    const alarm = new ICAL.Component('valarm');
    alarm.addPropertyWithValue('action', 'DISPLAY');
    alarm.addPropertyWithValue('description', fields.title || 'Erinnerung');
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-Number(fields.reminder) * 60));
    vevent.addSubcomponent(alarm);
  }
}

function applyText(vevent, fields) {
  if (fields.title !== undefined) setText(vevent, 'summary', fields.title || '(ohne Titel)');
  if (fields.location !== undefined) setText(vevent, 'location', fields.location);
  if (fields.description !== undefined) setText(vevent, 'description', fields.description);
}

/** Beginn/Ende aus dem Formular → { s, e } (Ende mindestens nach Beginn) */
function formTimes(fields) {
  const s = makeTime(fields.start, fields.allDay);
  let e = fields.end ? makeTime(fields.end, fields.allDay) : null;
  if (!e || e.compare(s) <= 0) {
    e = s.clone();
    if (fields.allDay) e.day += 1; else e.hour += 1;
  }
  return { s, e };
}

function setTimes(vevent, s, e) {
  vevent.removeAllProperties('duration');
  setTimeProp(vevent, 'dtstart', s);
  setTimeProp(vevent, 'dtend', e);
}

/** Alle Ausnahmen und EXDATEs der Serie entfernen (nach Verschieben der ganzen Serie). */
function dropExceptions(comp, master) {
  for (const v of comp.getAllSubcomponents('vevent')) if (v !== master && v.hasProperty('recurrence-id')) comp.removeSubcomponent(v);
  master.removeAllProperties('exdate');
}

/**
 * Erzeugt ein neues VCALENDAR bzw. ändert das bestehende.
 * fields: {
 *   title, location, description, start, end, allDay, reminder,
 *   rrule: null | 'WEEKLY' | { freq, interval, byday[], count, until },
 *   scope: 'all' (Standard) | 'this'   – bei Serien: nur dieses Vorkommen ändern
 *   recurrenceId: Vorkommen der Serie (aus expand), nötig für scope 'this' und zum Verschieben der Serie
 * }
 */
function buildEvent(fields, existing) {
  let comp;
  let vevent;
  if (existing) {
    comp = parseCal(existing);
    vevent = masterOf(comp);
  }
  if (!vevent) {
    comp = new ICAL.Component(['vcalendar', [], []]);
    comp.updatePropertyWithValue('prodid', '-//Webmail//DE');
    comp.updatePropertyWithValue('version', '2.0');
    vevent = new ICAL.Component('vevent');
    vevent.updatePropertyWithValue('uid', crypto.randomUUID());
    comp.addSubcomponent(vevent);
  }
  const master = vevent;
  const isRecurring = master.hasProperty('rrule');
  const uid = master.getFirstPropertyValue('uid');

  // ---- nur dieses Vorkommen einer Serie
  if (isRecurring && fields.scope === 'this' && fields.recurrenceId) {
    const rid = ridTime(master, fields.recurrenceId);
    let ex = findException(comp, master, rid);
    if (!ex) {
      ex = new ICAL.Component('vevent');
      ex.updatePropertyWithValue('uid', uid);
      for (const name of ['summary', 'location', 'description', 'organizer', 'attendee', 'class', 'transp', 'categories', 'x-webmail-noalarm']) {
        for (const p of master.getAllProperties(name)) ex.addProperty(ICAL.Property.fromString(p.toICALString()));
      }
      for (const a of master.getAllSubcomponents('valarm')) ex.addSubcomponent(new ICAL.Component(a.toJSON()));
      setTimeProp(ex, 'recurrence-id', rid);
      // Dauer der Serie übernehmen
      const st = master.getFirstPropertyValue('dtstart');
      const en = master.getFirstPropertyValue('dtend');
      const dur = en && st ? en.subtractDate(st) : (master.getFirstPropertyValue('duration') || ICAL.Duration.fromSeconds(st && st.isDate ? 86400 : 3600));
      const e = rid.clone(); e.addDuration(dur);
      setTimes(ex, rid.clone(), e);
      ex.updatePropertyWithValue('sequence', parseInt(master.getFirstPropertyValue('sequence') || '0', 10));
      comp.addSubcomponent(ex);
    }
    const sigBefore = significant(ex);
    applyText(ex, fields);
    if (fields.start !== undefined) { const { s, e } = formTimes(fields); setTimes(ex, s, e); }
    if (fields.attendees !== undefined) setParticipants(ex, fields.organizer, fields.attendees, { reset: significant(ex) !== sigBefore });
    applyReminder(ex, fields);
    touch(ex);
    bumpSequence(ex);
    return { uid, data: comp.toString(), recurrenceId: rid.toString() };
  }

  // ---- ganze Serie bzw. Einzeltermin
  const sigBefore = existing ? significant(master) : null;
  applyText(master, fields);
  touch(master);

  if (fields.start !== undefined) {
    const { s, e } = formTimes(fields);
    const removingRule = isRecurring && fields.rrule === null;
    if (isRecurring && fields.recurrenceId && !removingRule) {
      // Serie verschieben: das bearbeitete Vorkommen bestimmt die Verschiebung
      const rid = ridTime(master, fields.recurrenceId);
      const oldStart = master.getFirstPropertyValue('dtstart');
      const shift = s.isDate === rid.isDate ? s.subtractDate(rid) : null;
      const dur = e.subtractDate(s);
      const curEnd = master.getFirstPropertyValue('dtend');
      const curDur = curEnd ? curEnd.subtractDate(oldStart) : master.getFirstPropertyValue('duration');
      const moved = !shift || shift.toSeconds() !== 0 || !curDur || curDur.toSeconds() !== dur.toSeconds() || s.isDate !== oldStart.isDate;
      if (moved) {
        let ns;
        if (shift && s.isDate === oldStart.isDate) { ns = oldStart.clone(); ns.addDuration(shift); } else {
          // Wechsel ganztägig ↔ mit Uhrzeit: Serienbeginn am selben Tag neu setzen
          ns = s.clone(); ns.year = oldStart.year; ns.month = oldStart.month; ns.day = oldStart.day;
        }
        const ne = ns.clone(); ne.addDuration(dur);
        setTimes(master, ns, ne);
        dropExceptions(comp, master);
      }
    } else if (!(isRecurring && fields.keepSeriesTimes) || removingRule) {
      setTimes(master, s, e);
    }
  }

  if (fields.rrule !== undefined) {
    const current = rruleInfo(master);
    const wanted = fields.rrule || null;
    if (!wanted) {
      if (current) { master.removeAllProperties('rrule'); dropExceptions(comp, master); }
    } else {
      const recur = makeRecur(wanted, master.getFirstPropertyValue('dtstart'));
      const keepComplex = current && !current.simple && typeof wanted === 'object' && wanted.keep;
      if (recur && !keepComplex) {
        const before = master.getFirstPropertyValue('rrule');
        if (!before || before.toString() !== recur.toString()) {
          master.removeAllProperties('rrule');
          master.addPropertyWithValue('rrule', recur);
        }
      }
    }
  }
  if (fields.attendees !== undefined) {
    const reset = sigBefore !== null && significant(master) !== sigBefore;
    setParticipants(master, fields.organizer, fields.attendees, { reset });
    // Ausnahmen einer Serie: gleiche Teilnehmerliste (eigene Antworten je Vorkommen bleiben)
    for (const v of comp.getAllSubcomponents('vevent')) {
      if (v !== master && v.hasProperty('recurrence-id')) setParticipants(v, fields.organizer, fields.attendees, { reset });
    }
  }
  applyReminder(master, fields);
  bumpSequence(master);
  return { uid, data: comp.toString() };
}

/** Ein Vorkommen einer Serie löschen (EXDATE). Liefert die neuen Daten. */
function deleteOccurrence(existing, recurrenceId) {
  const comp = parseCal(existing);
  const master = masterOf(comp);
  if (!master || !master.hasProperty('rrule')) throw new Error('Kein Serientermin');
  const rid = ridTime(master, recurrenceId);
  const ex = findException(comp, master, rid);
  if (ex) comp.removeSubcomponent(ex);
  addTimeProp(master, 'exdate', rid);
  touch(master);
  bumpSequence(master);
  return { uid: master.getFirstPropertyValue('uid'), data: comp.toString(), recurrenceId: rid.toString() };
}

// ------------------------------------------------------------------ iTIP / iMIP (Einladungen per Mail)

function stripScheduleParams(vevent) {
  for (const name of ['organizer', 'attendee']) {
    for (const p of vevent.getAllProperties(name)) {
      for (const k of ['schedule-agent', 'schedule-status', 'schedule-force-send']) p.removeParameter(k);
    }
  }
}

/**
 * iTIP-Nachricht des Organisators (RFC 5546): REQUEST (Einladung/Aktualisierung) oder CANCEL (Absage).
 * opts.recurrenceId: nur dieses Vorkommen (Ausnahme bzw. – bei CANCEL – ein gelöschtes Vorkommen)
 * opts.only: nur diese Teilnehmer aufführen (z. B. Absage an entfernte Teilnehmer)
 */
function itipMessage(data, method, opts = {}) {
  const comp = parseCal(data);
  const master = masterOf(comp);
  const out = new ICAL.Component(['vcalendar', [], []]);
  out.updatePropertyWithValue('prodid', '-//Webmail//DE');
  out.updatePropertyWithValue('version', '2.0');
  out.updatePropertyWithValue('method', method);
  for (const tz of comp.getAllSubcomponents('vtimezone')) out.addSubcomponent(new ICAL.Component(tz.toJSON()));
  let vevents = comp.getAllSubcomponents('vevent');
  let rid = null;
  if (opts.recurrenceId && master) {
    rid = ridTime(master, opts.recurrenceId);
    const ex = findException(comp, master, rid);
    if (ex) vevents = [ex];
    else {
      // gelöschtes Vorkommen (EXDATE): Absage nur für dieses Datum
      const v = new ICAL.Component('vevent');
      for (const name of ['uid', 'summary', 'location', 'organizer', 'attendee', 'sequence']) {
        for (const p of master.getAllProperties(name)) v.addProperty(ICAL.Property.fromString(p.toICALString()));
      }
      setTimeProp(v, 'recurrence-id', rid);
      const st = master.getFirstPropertyValue('dtstart');
      const en = master.getFirstPropertyValue('dtend');
      const dur = en && st ? en.subtractDate(st) : ICAL.Duration.fromSeconds(st && st.isDate ? 86400 : 3600);
      const e = rid.clone(); e.addDuration(dur);
      setTimes(v, rid.clone(), e);
      vevents = [v];
    }
  }
  const only = opts.only ? new Set(opts.only.map(mailto)) : null;
  const orgMail = master && master.getFirstProperty('organizer') ? mailto(master.getFirstPropertyValue('organizer')) : '';
  for (const src of vevents) {
    const v = new ICAL.Component(src.toJSON());
    for (const a of v.getAllSubcomponents('valarm')) v.removeSubcomponent(a);
    for (const p of [...v.getAllProperties()]) if (/^x-webmail/i.test(p.name)) v.removeProperty(p);
    if (only) for (const p of v.getAllProperties('attendee')) { const m = mailto(p.getFirstValue()); if (!only.has(m) && m !== orgMail) v.removeProperty(p); }
    if (method === 'CANCEL') {
      v.updatePropertyWithValue('status', 'CANCELLED');
      // Absage braucht eine höhere SEQUENCE als die letzte Einladung
      if (opts.bump) bumpSequence(v);
    }
    v.updatePropertyWithValue('dtstamp', nowUtc());
    stripScheduleParams(v);
    out.addSubcomponent(v);
  }
  return { method, data: out.toString(), summary: (vevents[0] && vevents[0].getFirstPropertyValue('summary')) || '' };
}

/** iTIP-Antwort (REPLY) eines Teilnehmers erzeugen. */
function itipReply(data, email, partstat, opts = {}) {
  const comp = parseCal(data);
  const out = new ICAL.Component(['vcalendar', [], []]);
  out.updatePropertyWithValue('prodid', '-//Webmail//DE');
  out.updatePropertyWithValue('version', '2.0');
  out.updatePropertyWithValue('method', 'REPLY');
  const me = mailto(email);
  let vevents = comp.getAllSubcomponents('vevent');
  if (opts.recurrenceId) {
    const master = masterOf(comp);
    const rid = master ? ridTime(master, opts.recurrenceId) : null;
    vevents = vevents.filter((v) => rid && v.hasProperty('recurrence-id') && sameTime(v.getFirstPropertyValue('recurrence-id'), rid));
  } else {
    vevents = vevents.filter((v) => !v.hasProperty('recurrence-id')).slice(0, 1);
    if (!vevents.length) vevents = comp.getAllSubcomponents('vevent');
  }
  for (const v of vevents) {
    const r = new ICAL.Component('vevent');
    for (const name of ['uid', 'recurrence-id', 'dtstart', 'dtend', 'duration', 'summary', 'sequence', 'organizer']) {
      for (const p of v.getAllProperties(name)) r.addProperty(ICAL.Property.fromString(p.toICALString()));
    }
    r.updatePropertyWithValue('dtstamp', nowUtc());
    const mine = v.getAllProperties('attendee').find((p) => mailto(p.getFirstValue()) === me);
    const att = mine ? ICAL.Property.fromString(mine.toICALString()) : new ICAL.Property('attendee');
    if (!mine) att.setValue(`mailto:${me}`);
    if (opts.name && !att.getParameter('cn')) att.setParameter('cn', opts.name);
    att.setParameter('partstat', partstat);
    for (const k of ['rsvp', 'schedule-agent', 'schedule-status']) att.removeParameter(k);
    r.addProperty(att);
    stripScheduleParams(r);
    out.addSubcomponent(r);
  }
  return { method: 'REPLY', summary: (vevents[0] && vevents[0].getFirstPropertyValue('summary')) || '', data: out.toString() };
}

/**
 * Empfangene Einladung lesen.
 * myEmails: eigene Adressen (für den eigenen Teilnehmerstatus)
 */
function parseInvitation(data, myEmails = []) {
  const comp = parseCal(data);
  const method = String(comp.getFirstPropertyValue('method') || 'PUBLISH').toUpperCase();
  const vevents = comp.getAllSubcomponents('vevent');
  if (!vevents.length) throw new Error('Keine Termindaten gefunden');
  const v = vevents.find((x) => !x.hasProperty('recurrence-id')) || vevents[0];
  const ev = new ICAL.Event(v);
  const mine = new Set(myEmails.map(mailto));
  const attendees = attendeesOf(v);
  const me = attendees.find((a) => mine.has(a.email)) || null;
  const s = ev.startDate;
  let e = ev.endDate;
  if (s && !e) { e = s.clone(); if (s.isDate) e.day += 1; }
  const rid = v.getFirstPropertyValue('recurrence-id');
  return {
    method,
    uid: v.getFirstPropertyValue('uid') || '',
    sequence: parseInt(v.getFirstPropertyValue('sequence') || '0', 10),
    title: v.getFirstPropertyValue('summary') || '(ohne Titel)',
    location: v.getFirstPropertyValue('location') || '',
    description: v.getFirstPropertyValue('description') || '',
    start: s ? timeOut(s) : null,
    end: e ? timeOut(e) : null,
    allDay: !!(s && s.isDate),
    rrule: rruleInfo(v),
    recurrenceId: rid ? rid.toString() : null,
    organizer: organizerOf(v),
    attendees,
    me: me ? me.email : null,
    myStatus: me ? me.partstat : null,
    status: String(v.getFirstPropertyValue('status') || '').toUpperCase(),
    // Bei REPLY: wer hat wie geantwortet
    replies: method === 'REPLY' ? vevents.flatMap((x) => attendeesOf(x).map((a) => ({ ...a, recurrenceId: x.getFirstPropertyValue('recurrence-id') ? x.getFirstPropertyValue('recurrence-id').toString() : null }))) : [],
  };
}

/**
 * Antwort eines Teilnehmers (REPLY) in den gespeicherten Termin des Organisators übernehmen.
 * Liefert { data, changed: [{ email, partstat }] } oder null, wenn nichts passt.
 */
function applyReply(existing, replyData) {
  const comp = parseCal(existing);
  const reply = parseCal(replyData);
  const master = masterOf(comp);
  if (!master) return null;
  const changed = [];
  for (const rv of reply.getAllSubcomponents('vevent')) {
    const rrid = rv.getFirstPropertyValue('recurrence-id');
    let targets;
    if (rrid) {
      const ex = findException(comp, master, ridTime(master, rrid.toString()));
      targets = ex ? [ex] : []; // Antwort nur für ein Vorkommen ohne Ausnahme: ignorieren
    } else targets = comp.getAllSubcomponents('vevent');
    for (const ra of rv.getAllProperties('attendee')) {
      const email = mailto(ra.getFirstValue());
      const ps = String(ra.getParameter('partstat') || '').toUpperCase();
      if (!email || !ps) continue;
      for (const t of targets) {
        const p = t.getAllProperties('attendee').find((x) => mailto(x.getFirstValue()) === email);
        if (p && String(p.getParameter('partstat') || '').toUpperCase() !== ps) {
          p.setParameter('partstat', ps);
          p.removeParameter('rsvp');
          if (!changed.find((c) => c.email === email)) changed.push({ email, partstat: ps });
        }
      }
    }
  }
  if (!changed.length) return null;
  touch(master);
  return { data: comp.toString(), changed };
}

/**
 * Eigene Antwort im eigenen Kalender festhalten (Teilnehmer-Kopie).
 * SCHEDULE-AGENT=CLIENT, damit SOGo nicht selbst Antworten verschickt.
 */
function setMyPartstat(data, email, partstat) {
  const comp = parseCal(data);
  comp.removeAllProperties('method');
  const me = mailto(email);
  for (const v of comp.getAllSubcomponents('vevent')) {
    for (const p of v.getAllProperties('attendee')) {
      if (mailto(p.getFirstValue()) === me) { p.setParameter('partstat', partstat); p.removeParameter('rsvp'); }
      p.setParameter('schedule-agent', 'CLIENT');
    }
    const o = v.getFirstProperty('organizer');
    if (o) o.setParameter('schedule-agent', 'CLIENT');
  }
  return comp.toString();
}

/** Ausnahmen (RECURRENCE-ID) aus occData in die gespeicherte Serie übernehmen (ersetzt gleiche Vorkommen). */
function mergeOccurrence(seriesData, occData) {
  const comp = parseCal(seriesData);
  const occ = parseCal(occData);
  const master = masterOf(comp);
  for (const v of occ.getAllSubcomponents('vevent')) {
    const rid = v.getFirstPropertyValue('recurrence-id');
    if (!rid || !master) continue;
    const old = findException(comp, master, rid);
    if (old) comp.removeSubcomponent(old);
    comp.addSubcomponent(new ICAL.Component(v.toJSON()));
  }
  for (const tz of occ.getAllSubcomponents('vtimezone')) {
    const id = tz.getFirstPropertyValue('tzid');
    if (!comp.getAllSubcomponents('vtimezone').some((x) => x.getFirstPropertyValue('tzid') === id)) comp.addSubcomponent(new ICAL.Component(tz.toJSON()));
  }
  return comp.toString();
}

/** Bereitet eine per Mail empfangene .ics zum Import vor (METHOD entfernen). */
function prepareImport(data) {
  const comp = new ICAL.Component(ICAL.parse(data));
  comp.removeAllProperties('method');
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) throw new Error('Keine Termindaten gefunden');
  // importierte Einladung: der CalDAV-Server soll keine eigenen Einladungen/Antworten verschicken
  for (const v of comp.getAllSubcomponents('vevent')) {
    for (const p of [...v.getAllProperties('attendee'), ...v.getAllProperties('organizer')]) p.setParameter('schedule-agent', 'CLIENT');
  }
  let uid = vevent.getFirstPropertyValue('uid');
  if (!uid) {
    uid = crypto.randomUUID();
    for (const v of comp.getAllSubcomponents('vevent')) v.updatePropertyWithValue('uid', uid);
  }
  return { uid, data: comp.toString(), summary: vevent.getFirstPropertyValue('summary') || '' };
}

module.exports = {
  expand, buildEvent, deleteOccurrence, prepareImport,
  itipReply, parseInvitation, mergeOccurrence, applyReply, setMyPartstat, itipMessage, setParticipants,
};
