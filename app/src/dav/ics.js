'use strict';

/** iCalendar-Hilfen auf Basis von ical.js (Wiederholungen, Zeitzonen). */
const crypto = require('crypto');
const ICAL = require('ical.js');

const MAX_OCCURRENCES = 20000;

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

function rruleInfo(vevent) {
  const p = vevent.getFirstProperty('rrule');
  if (!p) return null;
  const r = p.getFirstValue();
  return r ? { freq: r.freq, interval: r.interval || 1, count: r.count || null, until: r.until ? r.until.toString() : null } : null;
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

/**
 * Erzeugt ein neues VCALENDAR bzw. ändert das bestehende.
 * fields: { title, location, description, start, end, allDay, rrule: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY'|null }
 */
function buildEvent(fields, existing) {
  let comp;
  let vevent;
  if (existing) {
    comp = new ICAL.Component(ICAL.parse(existing));
    vevent = comp.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'))
      || comp.getFirstSubcomponent('vevent');
  }
  if (!vevent) {
    comp = new ICAL.Component(['vcalendar', [], []]);
    comp.updatePropertyWithValue('prodid', '-//Webmail//DE');
    comp.updatePropertyWithValue('version', '2.0');
    vevent = new ICAL.Component('vevent');
    vevent.updatePropertyWithValue('uid', crypto.randomUUID());
    comp.addSubcomponent(vevent);
  }
  const isRecurring = vevent.hasProperty('rrule');
  setText(vevent, 'summary', fields.title || '(ohne Titel)');
  setText(vevent, 'location', fields.location);
  setText(vevent, 'description', fields.description);
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  vevent.updatePropertyWithValue('last-modified', ICAL.Time.now());

  const timesChanged = fields.start !== undefined;
  if (timesChanged && !(isRecurring && fields.keepSeriesTimes)) {
    const s = makeTime(fields.start, fields.allDay);
    let e = fields.end ? makeTime(fields.end, fields.allDay) : null;
    if (!e || e.compare(s) <= 0) {
      e = s.clone();
      if (fields.allDay) e.day += 1; else e.hour += 1;
    }
    vevent.removeAllProperties('dtstart');
    vevent.removeAllProperties('dtend');
    vevent.removeAllProperties('duration');
    vevent.addPropertyWithValue('dtstart', s);
    vevent.addPropertyWithValue('dtend', e);
  }

  if (fields.rrule !== undefined) {
    const current = rruleInfo(vevent);
    const wanted = fields.rrule || null;
    if ((current && current.freq) !== wanted) {
      vevent.removeAllProperties('rrule');
      if (wanted) vevent.addPropertyWithValue('rrule', new ICAL.Recur({ freq: wanted }));
    }
  }
  // Erinnerung: Zahl = Minuten vor Beginn, 'none' = keine, null = Standard (keine VALARM)
  if (fields.reminder !== undefined) {
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
  const seq = parseInt(vevent.getFirstPropertyValue('sequence') || '0', 10);
  vevent.updatePropertyWithValue('sequence', seq + 1);

  return { uid: vevent.getFirstPropertyValue('uid'), data: comp.toString() };
}

/** Bereitet eine per Mail empfangene .ics zum Import vor (METHOD entfernen). */
function prepareImport(data) {
  const comp = new ICAL.Component(ICAL.parse(data));
  comp.removeAllProperties('method');
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) throw new Error('Keine Termindaten gefunden');
  let uid = vevent.getFirstPropertyValue('uid');
  if (!uid) {
    uid = crypto.randomUUID();
    for (const v of comp.getAllSubcomponents('vevent')) v.updatePropertyWithValue('uid', uid);
  }
  return { uid, data: comp.toString(), summary: vevent.getFirstPropertyValue('summary') || '' };
}

module.exports = { expand, buildEvent, prepareImport };
