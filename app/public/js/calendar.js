import { h, clear, icon, iconButton, toast, modal, confirmDialog, choiceDialog, field, timeOnly, dateInput, timeInput, parseTime } from './ui.js';
import { get, post, put, del, patch } from './api.js';
import * as reminders from './reminders.js';
import { notify } from './state.js';
import { recipientInput, parseAddresses } from './compose.js';

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
/** Kalenderwoche nach ISO 8601 (Woche mit dem ersten Donnerstag des Jahres = KW 1) */
export function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day); // Donnerstag derselben Woche
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return Math.ceil(((x - y0) / 86400000 + 1) / 7);
}

function setView(key) {
  view = key;
  try { localStorage.setItem('wm.calView', key); } catch { /* egal */ }
  renderViewSel();
  loadEvents();
}

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

export async function render(main, r) {
  // #/calendar/JJJJ-MM-TT: zu diesem Datum springen (z. B. aus der Terminspalte)
  const target = r && r.parts && /^\d{4}-\d{2}-\d{2}$/.test(r.parts[1] || '') ? parseDateOnly(r.parts[1]) : null;
  if (target) cursor = target;
  if (!root || !main.contains(root)) mount(main);
  await loadCollections();
  await loadEvents();
  openRequestedEvent();
}

/** Termin öffnen, der aus der Terminspalte angeklickt wurde. */
function openRequestedEvent() {
  let req = null;
  try { req = JSON.parse(sessionStorage.getItem('wm.openEvent') || 'null'); sessionStorage.removeItem('wm.openEvent'); } catch { /* egal */ }
  if (!req) return;
  const ev = events.find((e) => e.id === req.id && e.start === req.start) || events.find((e) => e.id === req.id);
  if (ev) eventDialog(ev);
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
    onClick: () => setView(key),
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
        onChange: (e) => { const s = hidden(); if (e.target.checked) s.delete(c.url); else s.add(c.url); setHidden(s); loadEvents(); notify('events'); },
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
    ? `KW ${isoWeek(start)} · ${start.toLocaleDateString('de-CH', { day: 'numeric', month: 'short' })} – ${addDays(end, -1).toLocaleDateString('de-CH', { day: 'numeric', month: 'short', year: 'numeric' })}`
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

function evStatusClass(ev) {
  if (ev.role !== 'attendee') return '';
  return { 'NEEDS-ACTION': 'ev-open', TENTATIVE: 'ev-maybe', DECLINED: 'ev-no' }[ev.myStatus] || '';
}

function chip(ev) {
  const { s } = span(ev);
  return h('button', {
    type: 'button', class: `ev ${ev.allDay ? 'allday' : ''} ${evStatusClass(ev)}`, style: { '--c': ev.color || '#3b6fd8' },
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
    if (i % 7 === 0) {
      const kw = isoWeek(day);
      cells.push(h('button', {
        type: 'button', class: 'cal-kw', title: `Kalenderwoche ${kw} – Wochenansicht öffnen`,
        onClick: () => { cursor = day; setView('week'); },
      }, kw));
    }
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
    h('div', { class: 'cal-wd cal-kw-head', title: 'Kalenderwoche' }, 'KW'),
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
          type: 'button', class: `wev ${evStatusClass(ev)}`, style: { '--c': ev.color || '#3b6fd8' },
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
    groups.length ? groups.map(([d, list], i) => h('section', { class: `ag-day ${ymd(d) === ymd(new Date()) ? 'today' : ''}` },
      i === 0 || isoWeek(groups[i - 1][0]) !== isoWeek(d) ? h('div', { class: 'ag-kw' }, `KW ${isoWeek(d)}`) : null,
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

const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
const RR_DAYS = [['MO', 'Mo'], ['TU', 'Di'], ['WE', 'Mi'], ['TH', 'Do'], ['FR', 'Fr'], ['SA', 'Sa'], ['SU', 'So']];
const JS_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const RR_UNIT = { DAILY: ['Tag', 'Tage'], WEEKLY: ['Woche', 'Wochen'], MONTHLY: ['Monat', 'Monate'], YEARLY: ['Jahr', 'Jahre'] };
export const PARTSTAT = {
  ACCEPTED: ['Zugesagt', '✓', 'ok'],
  TENTATIVE: ['Vielleicht', '?', 'maybe'],
  DECLINED: ['Abgesagt', '✕', 'no'],
  'NEEDS-ACTION': ['Keine Antwort', '…', 'open'],
  DELEGATED: ['Delegiert', '→', 'open'],
};

function partstatBadge(ps) {
  const [label, sym, cls] = PARTSTAT[ps] || PARTSTAT['NEEDS-ACTION'];
  return h('span', { class: `ps ps-${cls}`, title: label, 'aria-label': label }, sym);
}

/** Wiederholung: Häufigkeit, Intervall, Wochentage, Ende */
const WD_LONG = { MO: 'Montag', TU: 'Dienstag', WE: 'Mittwoch', TH: 'Donnerstag', FR: 'Freitag', SA: 'Samstag', SU: 'Sonntag' };
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const ORDINALS = [[1, '1.'], [2, '2.'], [3, '3.'], [4, '4.'], [5, '5.'], [-1, 'letzten']];

/** n-ter Wochentag eines Monats (ordinal -1 = letzter) → Date oder null (z. B. kein 5. Montag) */
export function nthWeekday(year, month, ordinal, weekday) {
  const wd = JS_DAY.indexOf(weekday);
  if (wd < 0) return null;
  if (ordinal === -1) {
    const last = new Date(year, month + 1, 0);
    return new Date(year, month, last.getDate() - ((last.getDay() - wd + 7) % 7));
  }
  const first = new Date(year, month, 1);
  const day = 1 + ((wd - first.getDay() + 7) % 7) + (ordinal - 1) * 7;
  const d = new Date(year, month, day);
  return d.getMonth() === month ? d : null;
}

/** Erstes Datum ab start, das zur Regel „ordinal weekday (im Monat month)“ passt */
export function firstMatch(start, ordinal, weekday, month = null) {
  const s0 = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < 400; i++) {
    const y = start.getFullYear() + Math.floor((start.getMonth() + i) / 12);
    const m = (start.getMonth() + i) % 12;
    if (month && m !== month - 1) continue;
    const d = nthWeekday(y, m, ordinal, weekday);
    if (d && d >= s0) return d;
  }
  return null;
}

/** Vorgaben „n-ter Wochentag“ aus einem Datum: 11.11.2026 → 2. Mittwoch; ab dem 29. → letzter */
function ordinalOf(d) {
  const n = Math.ceil(d.getDate() / 7);
  const last = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return { ordinal: n >= 5 || (n === 4 && last) ? -1 : n, weekday: JS_DAY[d.getDay()] };
}

/** Lesbare Beschreibung einer Regel (für Hinweise) */
export function describeRule(r) {
  if (!r || !r.freq) return '';
  const n = r.interval || 1;
  const unit = RR_UNIT[r.freq] ? RR_UNIT[r.freq][n === 1 ? 0 : 1] : '';
  let t = n > 1 ? `Alle ${n} ${unit}` : ({ DAILY: 'Täglich', WEEKLY: 'Wöchentlich', MONTHLY: 'Monatlich', YEARLY: 'Jährlich' }[r.freq] || r.freq);
  if (r.freq === 'WEEKLY' && r.byday && r.byday.length) t += ` am ${r.byday.map((d) => WD_LONG[d]).join(', ')}`;
  const ordTxt = r.ordinal ? `${r.ordinal === -1 ? 'letzten' : `${r.ordinal}.`} ${WD_LONG[r.weekday] || r.weekday}` : null;
  const dayTxt = r.monthday ? (r.monthday === -1 ? 'letzten Tag' : `${r.monthday}.`) : null;
  if (r.freq === 'MONTHLY' && (ordTxt || dayTxt)) t += ` am ${ordTxt || dayTxt}`;
  if (r.freq === 'YEARLY' && r.month && (ordTxt || dayTxt)) t += ordTxt ? ` am ${ordTxt} im ${MONTHS[r.month - 1]}` : ` am ${dayTxt === 'letzten Tag' ? 'letzten Tag im' : dayTxt} ${MONTHS[r.month - 1]}`;
  if (r.count) t += `, ${r.count} Mal`;
  else if (r.until) t += `, bis ${r.until.split('-').reverse().join('.')}`;
  return t;
}

function recurrenceEditor(rule, startDay, { onAdjustStart } = {}) {
  const r = rule || {};
  const freq = h('select', { 'aria-label': 'Wiederholung' },
    [['', 'Keine Wiederholung'], ['DAILY', 'Täglich'], ['WEEKLY', 'Wöchentlich'], ['MONTHLY', 'Monatlich'], ['YEARLY', 'Jährlich']]
      .map(([v, l]) => h('option', { value: v, selected: (r.freq || '') === v }, l)));
  const interval = h('input', { type: 'number', min: '1', max: '999', value: String(r.interval || 1), class: 'rr-int', 'aria-label': 'Intervall' });
  const unit = h('span', { class: 'rr-unit' });
  const dayBtns = RR_DAYS.map(([code, label]) => {
    const on = r.byday && r.byday.length ? r.byday.includes(code) : false;
    return h('button', { type: 'button', class: `rr-day${on ? ' on' : ''}`, dataset: { day: code }, 'aria-pressed': String(on),
      onClick: (e) => { const b = e.currentTarget; b.classList.toggle('on'); b.setAttribute('aria-pressed', String(b.classList.contains('on'))); } }, label);
  });
  const days = h('div', { class: 'rr-days', role: 'group', 'aria-label': 'Wochentage' }, dayBtns);

  // ---- Monatlich/Jährlich: „am 15.“ oder „am 2. Mittwoch“ (jährlich zusätzlich: im Monat …)
  const st0 = startDay();
  const def = ordinalOf(st0);
  const initMode = r.ordinal ? 'nth' : 'day';
  const modeDay = h('input', { type: 'radio', name: 'rr-mode', value: 'day', checked: initMode === 'day', 'aria-label': 'Am Tag' });
  const modeNth = h('input', { type: 'radio', name: 'rr-mode', value: 'nth', checked: initMode === 'nth', 'aria-label': 'Am Wochentag' });
  const mday = h('select', { class: 'rr-mday', 'aria-label': 'Tag im Monat' },
    [...Array(31)].map((_, i) => h('option', { value: String(i + 1) }, `${i + 1}.`)), h('option', { value: '-1' }, 'letzten Tag'));
  mday.value = String(r.monthday || st0.getDate());
  const ord = h('select', { class: 'rr-ord', 'aria-label': 'Welcher' }, ORDINALS.map(([v, l]) => h('option', { value: String(v) }, l)));
  ord.value = String(r.ordinal || def.ordinal);
  const wday = h('select', { class: 'rr-wday', 'aria-label': 'Wochentag' }, RR_DAYS.map(([c]) => h('option', { value: c }, WD_LONG[c])));
  wday.value = r.weekday || def.weekday;
  const monthSel = () => h('select', { class: 'rr-month', 'aria-label': 'Monat' }, MONTHS.map((m, i) => h('option', { value: String(i + 1) }, m)));
  const month1 = monthSel();
  const month2 = monthSel();
  month1.value = month2.value = String(r.month || st0.getMonth() + 1);
  month1.addEventListener('change', () => { month2.value = month1.value; });
  month2.addEventListener('change', () => { month1.value = month2.value; });
  const inMonth1 = h('span', { class: 'rr-unit rr-y' }, '');
  const inMonth2 = h('span', { class: 'rr-unit rr-y' }, 'im');
  const monthly = h('div', { class: 'rr-monthly', role: 'radiogroup', 'aria-label': 'Tag der Wiederholung' },
    h('label', { class: 'rr-line' }, modeDay, h('span', {}, 'am'), mday, inMonth1, month1),
    h('label', { class: 'rr-line' }, modeNth, h('span', {}, 'am'), ord, wday, inMonth2, month2));
  const adjustNote = h('p', { class: 'hint rr-adjust', hidden: true });

  const endMode = h('select', { 'aria-label': 'Ende der Wiederholung' },
    h('option', { value: 'never', selected: !r.count && !r.until }, 'Endet nie'),
    h('option', { value: 'until', selected: !!r.until }, 'Endet am'),
    h('option', { value: 'count', selected: !!r.count }, 'Endet nach'));
  const until = dateInput(r.until || '', { label: 'Ende der Wiederholung' });
  const count = h('input', { type: 'number', min: '1', max: '5000', value: String(r.count || 10), class: 'rr-int', 'aria-label': 'Anzahl Termine' });
  const countLbl = h('span', { class: 'rr-unit' }, 'Terminen');
  const summary = h('p', { class: 'hint rr-summary' });
  const more = h('div', { class: 'rr-more' },
    h('div', { class: 'rr-line' }, h('span', {}, 'Alle'), interval, unit),
    days,
    monthly,
    adjustNote,
    h('div', { class: 'rr-line' }, endMode, until, count, countLbl),
    summary);
  const complexNote = r.freq && r.simple === false
    ? h('p', { class: 'hint' }, 'Diese Serie hat eine erweiterte Regel aus einem anderen Kalenderprogramm. Sie bleibt erhalten, solange du die Wiederholung hier nicht änderst.') : null;
  let touched = false;
  // Beginn, wie ihn der Benutzer gesetzt hat – automatische Anpassungen rechnen immer von hier aus
  let base = null;
  const from = () => base || startDay();

  const api = {
    el: h('div', { class: 'rr' }, freq, more, complexNote),
    get changed() { return touched; },
    value() {
      if (!freq.value) return null;
      const f = freq.value;
      const out = { freq: f, interval: Math.max(1, parseInt(interval.value, 10) || 1) };
      if (f === 'WEEKLY') out.byday = dayBtns.filter((b) => b.classList.contains('on')).map((b) => b.dataset.day);
      if (f === 'MONTHLY' || f === 'YEARLY') {
        const st = startDay();
        const month = Number(month1.value);
        if (modeNth.checked) {
          out.ordinal = Number(ord.value);
          out.weekday = wday.value;
          if (f === 'YEARLY') out.month = month;
        } else {
          const md = Number(mday.value);
          // gleicher Tag (und Monat) wie der Beginn: keine feste Angabe – die Serie folgt dann dem Beginn
          const sameAsStart = md === st.getDate() && (f === 'MONTHLY' || month === st.getMonth() + 1);
          if (!sameAsStart) { out.monthday = md; if (f === 'YEARLY') out.month = month; }
        }
      }
      if (endMode.value === 'count') out.count = Math.max(1, parseInt(count.value, 10) || 1);
      if (endMode.value === 'until' && until.value) out.until = until.value;
      return out;
    },
    /** Passt der Beginn nicht zu „n-ter Wochentag“, auf das erste passende Datum verschieben → neues Datum oder null */
    alignStart() {
      const f = freq.value;
      if (!(f === 'MONTHLY' || f === 'YEARLY') || !modeNth.checked) return null;
      const target = firstMatch(from(), Number(ord.value), wday.value, f === 'YEARLY' ? Number(month1.value) : null);
      const st = startDay();
      if (!target || target.getTime() === new Date(st.getFullYear(), st.getMonth(), st.getDate()).getTime()) return null;
      return target;
    },
    validate() {
      if (freq.value && endMode.value === 'until' && (!until.value || !until.isValid())) return 'Bitte ein gültiges Enddatum für die Wiederholung angeben';
      if ((freq.value === 'MONTHLY' || freq.value === 'YEARLY') && modeNth.checked && !firstMatch(from(), Number(ord.value), wday.value, freq.value === 'YEARLY' ? Number(month1.value) : null)) {
        return 'Diesen Wochentag gibt es in keinem passenden Monat';
      }
      return null;
    },
  };

  const sync = () => {
    const f = freq.value;
    more.hidden = !f;
    days.hidden = f !== 'WEEKLY';
    monthly.hidden = !(f === 'MONTHLY' || f === 'YEARLY');
    for (const x of [month1, month2, inMonth2]) x.hidden = f !== 'YEARLY';
    const n = Math.max(1, parseInt(interval.value, 10) || 1);
    unit.textContent = f ? RR_UNIT[f][n === 1 ? 0 : 1] : '';
    until.hidden = endMode.value !== 'until';
    count.hidden = endMode.value !== 'count';
    countLbl.hidden = endMode.value !== 'count';
    if (f === 'WEEKLY' && !dayBtns.some((b) => b.classList.contains('on'))) {
      const d = startDay();
      const b = dayBtns.find((x) => x.dataset.day === JS_DAY[d.getDay()]);
      if (b) { b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); }
    }
    mday.disabled = !modeDay.checked;
    for (const x of [ord, wday, month2]) x.disabled = !modeNth.checked;
    month1.disabled = !modeDay.checked;
    summary.textContent = f ? describeRule(api.value()) || '' : '';
  };
  // „am 2. Mittwoch“ gewählt: Beginn gleich auf das erste passende Datum legen
  const align = () => {
    if (!base) base = startDay();
    const t = api.alignStart();
    if (t && onAdjustStart) {
      onAdjustStart(t);
      mday.value = String(t.getDate());
      adjustNote.textContent = `Beginn auf ${t.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })} gelegt – den ersten passenden Termin.`;
      adjustNote.hidden = false;
    }
  };
  for (const x of [freq, interval, endMode, count, modeDay, modeNth, mday, ord, wday, month1, month2]) {
    x.addEventListener('change', () => { touched = true; sync(); if ([modeNth, ord, wday, month2, freq].includes(x)) align(); });
    x.addEventListener('input', () => { touched = true; sync(); });
  }
  until.addEventListener('change', () => { touched = true; sync(); });
  days.addEventListener('click', () => { touched = true; sync(); });
  api.refresh = () => {
    base = null; // vom Benutzer geändert
    adjustNote.hidden = true;
    // Beginn geändert: Vorgaben für noch nicht berührte Auswahl nachführen
    if (!touched) {
      const d = startDay();
      const o = ordinalOf(d);
      mday.value = String(d.getDate()); ord.value = String(o.ordinal); wday.value = o.weekday;
      month1.value = month2.value = String(d.getMonth() + 1);
    }
    sync();
  };
  sync();
  return api;
}

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
  const role = ev ? ev.role : null; // 'organizer' | 'attendee' | null
  const invited = role === 'attendee';

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
  const reminder = h('select', { 'aria-label': 'Erinnerung' },
    h('option', { value: 'default', selected: curAlarm === 'default' },
      `Standard (${remCfg.defaultMinutes === null ? 'keine' : reminders.reminderLabel(remCfg.defaultMinutes)})`),
    h('option', { value: 'none', selected: curAlarm === 'none' }, 'Keine Erinnerung'),
    reminders.REMINDER_OPTIONS.map(([m, l]) => h('option', { value: String(m), selected: curAlarm === String(m) }, l)),
    curAlarm !== 'default' && curAlarm !== 'none' && !knownMinutes.includes(curAlarm)
      ? h('option', { value: curAlarm, selected: true }, reminders.reminderLabel(Number(curAlarm))) : null);
  const rr = recurrenceEditor(ev && ev.rrule, () => (sDate.value ? parseDateOnly(sDate.value) : s), {
    onAdjustStart: (t) => {
      // Beginn verschieben, Dauer beibehalten
      const old = sDate.value ? parseDateOnly(sDate.value) : s;
      const diff = Math.round((t - new Date(old.getFullYear(), old.getMonth(), old.getDate())) / 86400000);
      sDate.value = ymd(t);
      if (eDate.value) eDate.value = ymd(addDays(parseDateOnly(eDate.value), diff));
    },
  });
  const loc = h('input', { type: 'text', value: ev ? ev.location : '' });
  const desc = h('textarea', { rows: 4 }, ev ? ev.description : '');
  const syncTime = () => { sTime.hidden = allDay.checked; eTime.hidden = allDay.checked; };
  allDay.addEventListener('change', syncTime);
  syncTime();
  sDate.addEventListener('change', () => { if (sDate.value && eDate.value < sDate.value) eDate.value = sDate.value; rr.refresh(); });

  const recurring = !!(ev && ev.recurring);

  // ---- Teilnehmer: nur Anzeige; bei Einladungen Antwort möglich (eigene Einladungen werden nicht erstellt)
  let attSection = null;
  let myAnswer = ev ? ev.myStatus : null;
  const attList = () => h('ul', { class: 'att-list' }, ev.attendees.map((a) => h('li', {}, partstatBadge(a.partstat), ' ', a.name || a.email, a.name ? h('span', { class: 'muted' }, ` <${a.email}>`) : null)));
  if (invited) {
    const org = ev.organizer || {};
    const answerBtns = ['ACCEPTED', 'TENTATIVE', 'DECLINED'].map((ps) => h('button', {
      type: 'button', class: `btn btn-small ans ans-${PARTSTAT[ps][2]}${myAnswer === ps ? ' on' : ''}`, dataset: { ps },
      onClick: async (x) => {
        const b = x.currentTarget;
        try {
          b.disabled = true;
          const r = await post('/events/respond', { sourceId: ev.sourceId, url: ev.url, partstat: ps, tz: TZ });
          myAnswer = ps;
          answerBtns.forEach((y) => y.classList.toggle('on', y.dataset.ps === ps));
          const sent = r.notified && r.notified.sent;
          toast(`Antwort „${PARTSTAT[ps][0]}“ gespeichert${sent ? ` und an ${org.name || org.email} gesendet` : ''}`, 'success');
          if (r.notified && r.notified.error) toast(r.notified.error, 'error');
          loadEvents();
        } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
      },
    }, ps === 'ACCEPTED' ? 'Zusagen' : ps === 'TENTATIVE' ? 'Vielleicht' : 'Absagen'));
    attSection = h('fieldset', { class: 'ev-people' },
      h('legend', {}, 'Einladung'),
      h('p', { class: 'small' }, 'Organisiert von ', h('strong', {}, org.name || org.email), org.name ? ` <${org.email}>` : ''),
      h('div', { class: 'ans-row' }, h('span', { class: 'small muted' }, 'Deine Antwort:'), answerBtns),
      attList());
  }
  // Eigener Termin (oder neu): Teilnehmer einladen und bearbeiten
  const own = !invited && (!ev || !(ev.attendees && ev.attendees.length) || role === 'organizer');
  let people = null;
  if (own) {
    const orgMail = ev && ev.organizer ? ev.organizer.email : null;
    const initial = ev && ev.attendees ? ev.attendees.filter((a) => a.email !== orgMail) : [];
    const quote = (n) => (/[",;<>@]/.test(n) ? `"${n.replace(/"/g, '')}"` : n);
    const rcpt = recipientInput('attendees', initial.map((a) => (a.name ? `${quote(a.name)} <${a.email}>` : a.email)).join(', '), 'Teilnehmer einladen (Name oder Adresse) …');
    const identSel = h('select', { class: 'ev-ident', 'aria-label': 'Einladen als' });
    const identRow = field('Einladen als', identSel);
    identRow.hidden = true;
    if (!orgMail) {
      get('/events/identities').then((r) => {
        const ids = r.identities || [];
        clear(identSel, ids.map((i) => h('option', { value: String(i.id), selected: i.isDefault }, i.name ? `${i.name} <${i.email}>` : i.email)));
        identRow.hidden = ids.length < 2;
      }).catch(() => {});
    }
    const notifyCb = h('input', { type: 'checkbox', class: 'ev-notify', checked: true });
    const notifyRow = h('label', { class: 'check' }, notifyCb, ' Teilnehmer per Mail benachrichtigen');
    const syncPeople = () => { notifyRow.hidden = rcpt.rcptEmpty() && !initial.length; };
    rcpt.addEventListener('rcpt-change', syncPeople);
    rcpt.addEventListener('input', syncPeople);
    syncPeople();
    attSection = h('fieldset', { class: 'ev-people' },
      h('legend', {}, 'Teilnehmer'),
      rcpt,
      initial.length ? attList() : null,
      identRow,
      notifyRow,
      orgMail ? h('p', { class: 'hint' }, `Organisiert von dir (${orgMail}). Bei geänderter Zeit, Ort oder Wiederholung werden alle erneut um Antwort gebeten.`) : null);
    people = {
      values: () => parseAddresses(rcpt.rcptValue()).map((a) => ({ email: a.address.trim(), name: a.name })),
      identityId: () => (identSel.value ? Number(identSel.value) : undefined),
      notify: () => notifyCb.checked,
      had: initial.length > 0,
    };
  } else if (ev && ev.attendees && ev.attendees.length && !invited) {
    attSection = h('fieldset', { class: 'ev-people' }, h('legend', {}, 'Teilnehmer'), attList());
  }

  const body = h('form', { class: 'form-grid ev-form', onSubmit: (x) => x.preventDefault() },
    field('Titel', title),
    field('Kalender', calSel),
    h('label', { class: 'check' }, allDay, ' Ganztägig'),
    h('div', { class: 'row2' }, field('Beginn', h('div', { class: 'dt' }, sDate, sTime)), field('Ende', h('div', { class: 'dt' }, eDate, eTime))),
    h('div', { class: 'row2' }, field('Wiederholung', rr.el), field('Erinnerung', reminder)),
    field('Ort', loc),
    field('Beschreibung', desc),
    attSection);

  const formTimes = () => {
    if (!sDate.value || !sDate.isValid() || !eDate.isValid()) throw new Error('Bitte ein gültiges Datum angeben (TT.MM.JJJJ)');
    if (!allDay.checked && ((sTime.value && !parseTime(sTime.value)) || (eTime.value && !parseTime(eTime.value)))) {
      throw new Error('Bitte eine gültige Uhrzeit angeben (HH:MM)');
    }
    if (allDay.checked) return { allDay: true, start: sDate.value, end: ymd(addDays(parseDateOnly(eDate.value || sDate.value), 1)) };
    const st = new Date(`${sDate.value}T${parseTime(sTime.value) || '09:00'}`);
    let en = new Date(`${eDate.value || sDate.value}T${parseTime(eTime.value) || '10:00'}`);
    if (en <= st) en = new Date(st.getTime() + 3600000);
    return { allDay: false, start: st.toISOString(), end: en.toISOString() };
  };

  const save = async () => {
    if (!title.value.trim()) { toast('Bitte einen Titel angeben', 'error'); return true; }
    const rrErr = rr.validate();
    if (rrErr) { toast(rrErr, 'error'); return true; }
    if (isNew || rr.changed) {
      const t = rr.alignStart();
      if (t) {
        const old = parseDateOnly(sDate.value);
        const diff = Math.round((t - old) / 86400000);
        sDate.value = ymd(t);
        if (eDate.value) eDate.value = ymd(addDays(parseDateOnly(eDate.value), diff));
        toast(`Beginn auf den ersten passenden Termin gelegt: ${t.toLocaleDateString('de-CH')}`);
      }
    }
    let times;
    try { times = formTimes(); } catch (err) { toast(err.message, 'error'); return true; }
    const cal = collections.find((c) => c.url === calSel.value);
    const payload = {
      sourceId: cal.sourceId,
      calendar: cal.url,
      title: title.value.trim(),
      location: loc.value,
      description: desc.value,
      ...times,
      // nur senden, wenn geändert – sonst bleiben z. B. mehrere Alarme aus anderen Programmen erhalten
      reminder: reminder.value === curAlarm ? undefined
        : (reminder.value === 'default' ? null : (reminder.value === 'none' ? 'none' : Number(reminder.value))),
      tz: TZ,
    };
    // Wiederholung nur senden, wenn neu oder geändert (erweiterte Regeln anderer Programme bleiben erhalten)
    if (isNew || rr.changed) payload.rrule = rr.value();
    if (!isNew && ev.sourceId !== cal.sourceId) { toast('Verschieben zwischen verschiedenen Servern ist nicht möglich', 'error'); return true; }
    if (people) {
      const list = people.values();
      const bad = list.filter((a) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a.email));
      if (bad.length) { toast(`Ungültige Adresse: ${bad.map((a) => a.email).join(', ')}`, 'error'); return true; }
      if (list.length || people.had) {
        payload.attendees = list;
        payload.identityId = people.identityId();
        payload.notify = people.notify();
      }
    }

    if (!isNew && recurring) {
      payload.recurrenceId = ev.recurrenceId;
      const ruleChanged = rr.changed;
      if (!ruleChanged) {
        const pick = await choiceDialog('Serientermin ändern', `„${ev.title}“ ist ein wiederkehrender Termin. Was möchtest du ändern?`, [
          { value: 'this', label: 'Nur diesen Termin' },
          { value: 'all', label: 'Alle Termine der Serie', primary: true },
        ]);
        if (!pick) return true;
        if (pick.value === 'this') { payload.scope = 'this'; delete payload.calendar; }
      }
    }

    const res = isNew ? await post('/events', payload) : await put('/events', { ...payload, url: ev.url, etag: ev.etag });
    const n = res && res.notified;
    if (n && n.error) toast(`Termin gespeichert, aber Einladungen nicht verschickt: ${n.error}`, 'error', 8000);
    else if (n && (n.invited || n.updated || n.cancelled)) {
      const parts = [];
      if (n.invited) parts.push(`${n.invited} eingeladen`);
      if (n.updated) parts.push(`${n.updated} über die Änderung informiert`);
      if (n.cancelled) parts.push(`${n.cancelled} abgesagt`);
      toast(`Termin gespeichert – ${parts.join(', ')}`, 'success', 6000);
    } else toast('Termin gespeichert', 'success');
    reminders.reschedule();
    notify('events');
    loadEvents();
    return false;
  };

  const remove = async () => {
    const organized = role === 'organizer' && ev.attendees && ev.attendees.length > 1;
    const checkbox = invited ? {
      label: `Absage an ${(ev.organizer && (ev.organizer.name || ev.organizer.email)) || 'den Organisator'} senden`,
      checked: true,
    } : organized ? { label: 'Absage an alle Teilnehmer senden', checked: true } : null;
    let pick;
    if (recurring) {
      pick = await choiceDialog('Serientermin löschen', `„${ev.title}“ ist ein wiederkehrender Termin.`, [
        { value: 'this', label: 'Nur diesen Termin', danger: true },
        { value: 'all', label: 'Ganze Serie', danger: true },
      ], { checkbox });
    } else {
      pick = await choiceDialog('Termin löschen', `„${ev.title}“ löschen?`, [{ value: 'all', label: 'Löschen', danger: true }], { checkbox });
    }
    if (!pick) return true;
    const q = { sourceId: ev.sourceId, url: ev.url, etag: ev.etag };
    if (pick.value === 'this') { q.scope = 'this'; q.recurrenceId = ev.recurrenceId; delete q.etag; }
    if (pick.checked) { q.notify = '1'; q.tz = TZ; }
    const r = await del('/events', q);
    const n = r && r.notified;
    if (n && n.error) toast(`Gelöscht, aber Absage nicht verschickt: ${n.error}`, 'error');
    else if (n && n.replied) toast('Termin gelöscht – Absage an den Organisator gesendet');
    else if (n && n.cancelled) toast(`Termin gelöscht – Absage an ${n.cancelled} Teilnehmer gesendet`);
    else toast(pick.value === 'this' ? 'Termin aus der Serie gelöscht' : 'Termin gelöscht');
    reminders.reschedule();
    notify('events');
    loadEvents();
    return false;
  };

  modal({
    title: isNew ? 'Neuer Termin' : (invited ? 'Einladung' : 'Termin bearbeiten'),
    body,
    wide: true,
    actions: [
      !isNew ? { label: 'Löschen', danger: true, onClick: remove } : null,
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
