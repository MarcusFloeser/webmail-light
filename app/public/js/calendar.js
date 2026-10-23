import { h, clear, icon, iconButton, toast, modal, confirmDialog, field, timeOnly, dateInput, timeInput, parseTime } from './ui.js';
import { get, post, put, del, patch } from './api.js';
import * as reminders from './reminders.js';

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const monthFmt = new Intl.DateTimeFormat('de-CH', { month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'long', day: 'numeric', month: 'long' });

let root = null;
let els = {};
let cursor = new Date();
let view = localStorage.getItem('wm.calView') || 'month';
let collections = [];
let events = [];
let loadSeq = 0;

function hidden() {
  try { return new Set(JSON.parse(localStorage.getItem('wm.hiddenCals') || '[]')); } catch { return new Set(); }
}
function setHidden(set) { localStorage.setItem('wm.hiddenCals', JSON.stringify([...set])); }

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - wd);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function parseDateOnly(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

/** Start/Ende eines Termins als lokale Date-Objekte (Ende exklusiv). */
function span(ev) {
  if (ev.allDay) return { s: parseDateOnly(ev.start), e: parseDateOnly(ev.end || ev.start) };
  return { s: new Date(ev.start), e: new Date(ev.end || ev.start) };
}

export function unmount() { root = null; }

export async function render(main) {
  if (!root || !main.contains(root)) mount(main);
  await loadCollections();
  await loadEvents();
}

function mount(main) {
  els = {};
  els.title = h('h1', { class: 'cal-title' });
  els.cals = h('div', { class: 'cal-list' });
  els.grid = h('div', { class: 'cal-grid-wrap' });
  els.viewSel = h('div', { class: 'seg' });
  root = h('div', { class: 'cal-view' },
    h('aside', { class: 'cal-side' },
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onClick: () => eventDialog(null, new Date()) }, icon('plus', 16), 'Neuer Termin'),
      h('div', { class: 'side-title' }, h('span', {}, 'Kalender'),
        iconButton('plus', 'Kalender anlegen', newCalendarDialog, { class: 'tiny' }),
        iconButton('refresh', 'Neu laden', async () => { await loadCollections(true); await loadEvents(); }, { class: 'tiny' })),
      els.cals),
    h('section', { class: 'cal-main' },
      h('header', { class: 'cal-head' },
        iconButton('chevronLeft', 'Zurück', () => move(-1)),
        iconButton('chevronRight', 'Weiter', () => move(1)),
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => { cursor = new Date(); loadEvents(); } }, 'Heute'),
        els.title,
        h('span', { class: 'grow' }),
        els.viewSel),
      els.grid));
  clear(main, root);
  renderViewSel();
}

function renderViewSel() {
  const mk = (key, label) => h('button', {
    type: 'button', class: view === key ? 'on' : '',
    onClick: () => { view = key; localStorage.setItem('wm.calView', key); renderViewSel(); loadEvents(); },
  }, label);
  clear(els.viewSel, mk('month', 'Monat'), mk('week', 'Woche'), mk('list', 'Liste'));
}

function move(dir) {
  if (view === 'week') cursor = addDays(cursor, dir * 7);
  else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  loadEvents();
}

async function loadCollections(fresh = false) {
  try {
    const r = await get('/dav/collections', { fresh: fresh ? 1 : '' });
    collections = r.collections.filter((c) => c.type === 'calendar');
    for (const e of r.errors || []) toast(`${e.sourceName}: ${e.message}`, 'error', 6000);
  } catch (err) {
    toast(err.message, 'error');
    collections = [];
  }
  renderCalList();
}

function renderCalList() {
  const hid = hidden();
  const bySource = new Map();
  for (const c of collections) {
    if (!bySource.has(c.sourceName)) bySource.set(c.sourceName, []);
    bySource.get(c.sourceName).push(c);
  }
  clear(els.cals, [...bySource.entries()].map(([src, cals]) => h('div', { class: 'cal-src' },
    h('div', { class: 'cal-src-name' }, src),
    cals.map((c) => h('label', { class: 'cal-item' },
      h('input', {
        type: 'checkbox', checked: !hid.has(c.url),
        onChange: (e) => { const s = hidden(); if (e.target.checked) s.delete(c.url); else s.add(c.url); setHidden(s); loadEvents(); },
      }),
      h('span', { class: 'cal-dot', style: { background: c.color || '#3b6fd8' } }),
      h('span', { class: 'cal-name' }, c.name),
      iconButton('more', 'Kalender bearbeiten', (e) => { e.preventDefault(); calendarDialog(c); }, { class: 'tiny' }))))));
  if (!collections.length) {
    els.cals.appendChild(h('div', { class: 'muted small' },
      h('p', {}, 'Keine Kalender gefunden.'),
      h('a', { class: 'btn btn-small', href: '#/settings/dav' }, 'CalDAV-Server einbinden')));
  }
}

function range() {
  if (view === 'week') {
    const s = startOfWeek(cursor);
    return { start: s, end: addDays(s, 7) };
  }
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const s = startOfWeek(first);
  return { start: s, end: addDays(s, 42) };
}

async function loadEvents() {
  const seq = ++loadSeq;
  const { start, end } = range();
  els.title.textContent = view === 'week'
    ? `${start.toLocaleDateString('de-CH', { day: 'numeric', month: 'short' })} – ${addDays(end, -1).toLocaleDateString('de-CH', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : monthFmt.format(cursor);
  try {
    const r = await get('/events', { start: start.toISOString(), end: end.toISOString(), hidden: [...hidden()].join(',') });
    if (seq !== loadSeq) return;
    events = r.events;
    for (const e of r.errors || []) toast(`${e.sourceName}: ${e.message}`, 'error', 6000);
  } catch (err) {
    toast(err.message, 'error');
    events = [];
  }
  draw();
}

function eventsOn(day) {
  const ds = day;
  const de = addDays(day, 1);
  return events.filter((ev) => {
    const { s, e } = span(ev);
    return s < de && (e > ds || (e.getTime() === s.getTime() && s >= ds));
  }).sort((a, b) => (b.allDay - a.allDay) || (span(a).s - span(b).s));
}

function chip(ev) {
  const { s } = span(ev);
  return h('button', {
    type: 'button', class: `ev ${ev.allDay ? 'allday' : ''}`, style: { '--c': ev.color || '#3b6fd8' },
    title: `${ev.title}${ev.location ? ' · ' + ev.location : ''}`,
    onClick: (e) => { e.stopPropagation(); eventDialog(ev); },
  }, !ev.allDay ? h('span', { class: 'ev-time' }, hm(s)) : null, h('span', { class: 'ev-title' }, ev.title), ev.recurring ? ' ↻' : '');
}

function draw() {
  if (view === 'list') return drawList();
  if (view === 'week') return drawWeek();
  const { start } = range();
  const today = ymd(new Date());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i);
    const list = eventsOn(day);
    const inMonth = day.getMonth() === cursor.getMonth();
    cells.push(h('div', {
      class: `cal-cell ${inMonth ? '' : 'out'} ${ymd(day) === today ? 'today' : ''}`,
      onClick: () => eventDialog(null, day),
    },
    h('span', { class: 'cal-daynum' }, day.getDate()),
    h('div', { class: 'cal-evs' }, list.slice(0, 4).map(chip),
      list.length > 4 ? h('button', {
        type: 'button', class: 'more-ev', onClick: (e) => { e.stopPropagation(); dayDialog(day, list); },
      }, `+${list.length - 4} weitere`) : null)));
  }
  clear(els.grid, h('div', { class: 'cal-month' },
    WEEKDAYS.map((w) => h('div', { class: 'cal-wd' }, w)),
    cells));
}

function drawWeek() {
  const { start } = range();
  const today = ymd(new Date());
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  clear(els.grid, h('div', { class: 'cal-week' }, days.map((d) => {
    const list = eventsOn(d);
    return h('div', { class: `week-day ${ymd(d) === today ? 'today' : ''}`, onClick: () => eventDialog(null, d) },
      h('div', { class: 'week-head' }, `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()}.`),
      h('div', { class: 'week-evs' }, list.map((ev) => {
        const { s, e } = span(ev);
        return h('button', {
          type: 'button', class: 'wev', style: { '--c': ev.color || '#3b6fd8' },
          onClick: (x) => { x.stopPropagation(); eventDialog(ev); },
        },
        h('strong', {}, ev.title),
        h('span', {}, ev.allDay ? 'ganztägig' : `${hm(s)}–${hm(e)}`),
        ev.location ? h('span', { class: 'muted' }, ev.location) : null);
      }), !list.length ? h('span', { class: 'muted small' }, '—') : null));
  })));
}

function drawList() {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  const groups = [];
  for (let d = first; d < last; d = addDays(d, 1)) {
    const list = eventsOn(d);
    if (list.length) groups.push([d, list]);
  }
  clear(els.grid, h('div', { class: 'cal-agenda' },
    groups.length ? groups.map(([d, list]) => h('section', { class: 'ag-day' },
      h('h3', {}, dayFmt.format(d)),
      list.map((ev) => {
        const { s, e } = span(ev);
        return h('button', { type: 'button', class: 'ag-ev', onClick: () => eventDialog(ev) },
          h('span', { class: 'cal-dot', style: { background: ev.color || '#3b6fd8' } }),
          h('span', { class: 'ag-time' }, ev.allDay ? 'ganztägig' : `${hm(s)} – ${hm(e)}`),
          h('span', { class: 'ag-title' }, ev.title),
          ev.location ? h('span', { class: 'muted' }, ev.location) : null);
      }))) : h('p', { class: 'muted pad' }, 'Keine Termine in diesem Monat.')));
}

function dayDialog(day, list) {
  modal({
    title: dayFmt.format(day),
    body: h('div', { class: 'day-list' }, list.map(chip)),
  });
}

// ====================================================================== Termin-Dialog

function eventDialog(ev, day) {
  if (!collections.length) { noServerHint(); return; }
  const isNew = !ev;
  const defStart = day ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0) : new Date();
  if (!day) { defStart.setMinutes(0, 0, 0); defStart.setHours(defStart.getHours() + 1); }
  let s; let e;
  if (ev) ({ s, e } = span(ev));
  else { s = defStart; e = new Date(defStart.getTime() + 3600000); }
  const allDayInit = ev ? ev.allDay : false;
  const endInclusive = allDayInit ? addDays(e, -1) : e;

  const title = h('input', { type: 'text', value: ev ? ev.title : '', placeholder: 'Titel', required: true });
  const calSel = h('select', {}, collections.map((c) => h('option', {
    value: c.url, selected: ev ? ev.calendar === c.url : collections[0] === c,
  }, `${c.name} – ${c.sourceName}`)));
  const allDay = h('input', { type: 'checkbox', checked: allDayInit });
  const sDate = dateInput(ymd(s), { label: 'Beginn-Datum' });
  const sTime = timeInput(hm(s));
  const eDate = dateInput(ymd(endInclusive), { label: 'End-Datum' });
  const eTime = timeInput(hm(e));
  const remCfg = reminders.settings();
  const curAlarm = !ev || ev.alarms === null || ev.alarms === undefined ? 'default' : (ev.alarms.length ? String(ev.alarms[0]) : 'none');
  const knownMinutes = reminders.REMINDER_OPTIONS.map(([m]) => String(m));
  const reminder = h('select', {},
    h('option', { value: 'default', selected: curAlarm === 'default' },
      `Standard (${remCfg.defaultMinutes === null ? 'keine' : reminders.reminderLabel(remCfg.defaultMinutes)})`),
    h('option', { value: 'none', selected: curAlarm === 'none' }, 'Keine Erinnerung'),
    reminders.REMINDER_OPTIONS.map(([m, l]) => h('option', { value: String(m), selected: curAlarm === String(m) }, l)),
    curAlarm !== 'default' && curAlarm !== 'none' && !knownMinutes.includes(curAlarm)
      ? h('option', { value: curAlarm, selected: true }, reminders.reminderLabel(Number(curAlarm))) : null);
  const rrule = h('select', {},
    [['', 'Keine Wiederholung'], ['DAILY', 'Täglich'], ['WEEKLY', 'Wöchentlich'], ['MONTHLY', 'Monatlich'], ['YEARLY', 'Jährlich']]
      .map(([v, l]) => h('option', { value: v, selected: ((ev && ev.rrule && ev.rrule.freq) || '') === v }, l)));
  const loc = h('input', { type: 'text', value: ev ? ev.location : '' });
  const desc = h('textarea', { rows: 4 }, ev ? ev.description : '');
  const syncTime = () => { sTime.hidden = allDay.checked; eTime.hidden = allDay.checked; };
  allDay.addEventListener('change', syncTime);
  syncTime();
  sDate.addEventListener('change', () => { if (sDate.value && eDate.value < sDate.value) eDate.value = sDate.value; });

  const recurring = ev && ev.recurring;
  if (recurring) { [sDate, sTime, eDate, eTime, allDay].forEach((x) => { x.disabled = true; }); }

  const body = h('form', { class: 'form-grid', onSubmit: (x) => x.preventDefault() },
    field('Titel', title),
    field('Kalender', calSel),
    h('label', { class: 'check' }, allDay, ' Ganztägig'),
    h('div', { class: 'row2' }, field('Beginn', h('div', { class: 'dt' }, sDate, sTime)), field('Ende', h('div', { class: 'dt' }, eDate, eTime))),
    recurring ? h('p', { class: 'hint' }, 'Wiederkehrender Termin: Änderungen an Titel, Ort und Beschreibung gelten für die ganze Serie. Zeiten bitte im Ursprungstermin bzw. Kalenderprogramm ändern.') : null,
    h('div', { class: 'row2' }, field('Wiederholung', rrule), field('Erinnerung', reminder)),
    field('Ort', loc),
    field('Beschreibung', desc));

  const save = async () => {
    if (!title.value.trim()) { toast('Bitte einen Titel angeben', 'error'); return true; }
    const cal = collections.find((c) => c.url === calSel.value);
    const payload = {
      sourceId: cal.sourceId,
      calendar: cal.url,
      title: title.value.trim(),
      location: loc.value,
      description: desc.value,
      rrule: rrule.value || null,
      // nur senden, wenn geändert – sonst bleiben z. B. mehrere Alarme aus anderen Programmen erhalten
      reminder: reminder.value === curAlarm ? undefined
        : (reminder.value === 'default' ? null : (reminder.value === 'none' ? 'none' : Number(reminder.value))),
    };
    if (!recurring) {
      if (!sDate.value || !sDate.isValid() || !eDate.isValid()) { toast('Bitte ein gültiges Datum angeben (TT.MM.JJJJ)', 'error'); return true; }
      if (!allDay.checked && ((sTime.value && !parseTime(sTime.value)) || (eTime.value && !parseTime(eTime.value)))) {
        toast('Bitte eine gültige Uhrzeit angeben (HH:MM)', 'error');
        return true;
      }
      payload.allDay = allDay.checked;
      if (allDay.checked) {
        payload.start = sDate.value;
        payload.end = ymd(addDays(parseDateOnly(eDate.value || sDate.value), 1));
      } else {
        const st = new Date(`${sDate.value}T${parseTime(sTime.value) || '09:00'}`);
        let en = new Date(`${eDate.value || sDate.value}T${parseTime(eTime.value) || '10:00'}`);
        if (en <= st) en = new Date(st.getTime() + 3600000);
        payload.start = st.toISOString();
        payload.end = en.toISOString();
      }
    }
    if (isNew) await post('/events', payload);
    else {
      if (ev.sourceId !== cal.sourceId) { toast('Verschieben zwischen verschiedenen Servern ist nicht möglich', 'error'); return true; }
      await put('/events', { ...payload, url: ev.url, etag: ev.etag });
    }
    toast('Termin gespeichert', 'success');
    reminders.reschedule();
    loadEvents();
    return false;
  };

  modal({
    title: isNew ? 'Neuer Termin' : 'Termin bearbeiten',
    body,
    wide: true,
    actions: [
      !isNew ? { label: 'Löschen', danger: true, onClick: async () => {
        if (!(await confirmDialog('Termin löschen', recurring ? 'Die ganze Terminserie löschen?' : `„${ev.title}“ löschen?`, { confirmLabel: 'Löschen' }))) return true;
        await del('/events', { sourceId: ev.sourceId, url: ev.url, etag: ev.etag });
        toast('Termin gelöscht');
        reminders.reschedule();
        loadEvents();
        return false;
      } } : null,
      { label: 'Abbrechen' },
      { label: 'Speichern', primary: true, onClick: save },
    ].filter(Boolean),
  });
}

// ====================================================================== Kalender verwalten

async function newCalendarDialog() {
  const name = h('input', { type: 'text', placeholder: 'z. B. Arbeit' });
  const color = h('input', { type: 'color', value: '#2e9e6b' });
  let sources = [];
  try { sources = (await get('/dav/sources')).sources.map((x) => [String(x.id), x.name]); } catch (err) { toast(err.message, 'error'); return; }
  if (!sources.length) { noServerHint(); return; }
  const src = h('select', {}, sources.map(([id, n]) => h('option', { value: id }, n)));
  modal({
    title: 'Neuer Kalender',
    body: h('div', { class: 'form-grid' }, field('Name', name), field('Farbe', color), field('Speicherort', src)),
    actions: [
      { label: 'Abbrechen' },
      { label: 'Anlegen', primary: true, onClick: async () => {
        await post('/dav/collections', { sourceId: src.value, type: 'calendar', name: name.value || 'Kalender', color: color.value });
        toast('Kalender angelegt', 'success');
        await loadCollections(true);
        await loadEvents();
      } },
    ],
  });
}

function calendarDialog(c) {
  const name = h('input', { type: 'text', value: c.name });
  const color = h('input', { type: 'color', value: (c.color || '#3b6fd8').slice(0, 7) });
  modal({
    title: 'Kalender bearbeiten',
    body: h('div', { class: 'form-grid' }, field('Name', name), field('Farbe', color),
      h('p', { class: 'hint' }, `${c.sourceName} · ${c.url}`)),
    actions: [
      { label: 'Löschen', danger: true, onClick: async () => {
        if (!(await confirmDialog('Kalender löschen', `Kalender „${c.name}“ mit allen Terminen löschen?`, { confirmLabel: 'Löschen' }))) return true;
        await del('/dav/collections', { sourceId: c.sourceId, url: c.url });
        toast('Kalender gelöscht');
        await loadCollections(true);
        await loadEvents();
      } },
      { label: 'Abbrechen' },
      { label: 'Speichern', primary: true, onClick: async () => {
        await patch('/dav/collections', { sourceId: c.sourceId, url: c.url, name: name.value, color: color.value });
        await loadCollections(true);
        await loadEvents();
      } },
    ],
  });
}

export { timeOnly };

function noServerHint() {
  modal({
    title: 'Kein Kalender-/Kontakte-Server',
    body: h('p', {}, 'Webmail speichert Kalender und Kontakte auf deinem vorhandenen CalDAV/CardDAV-Server (z. B. Nextcloud, mailcow/SOGo, mailbox.org). Binde ihn zuerst in den Einstellungen ein.'),
    actions: [{ label: 'Abbrechen' }, { label: 'Zu den Einstellungen', primary: true, onClick: () => { location.hash = '#/settings/dav'; } }],
  });
}
