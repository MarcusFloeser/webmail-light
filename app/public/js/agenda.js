// Ein-/ausklappbare Spalte rechts mit den anstehenden Terminen (nächste 4 Wochen).
import { get } from './api.js';
import { subscribe } from './state.js';
import { h, clear, icon, iconButton } from './ui.js';

const DAYS = 28;                 // Zeitraum: 4 Wochen ab heute
const REFRESH_MS = 5 * 60000;    // alle 5 Minuten neu laden
const STALE_MS = 2 * 60000;      // beim Zurückkehren in den Tab neu laden, wenn älter
const KEY = 'wm.agenda';         // '1' = offen, '0' = zu (pro Browser)
const WIDE = 1400;               // ab dieser Breite standardmässig offen

let el = null;
let listEl = null;
let toggleBtn = null;
let active = false;              // Spalte gehört zur aktuellen Ansicht (Mail)
let events = [];
let errors = [];
let loadedAt = 0;
let loading = false;
let timer = null;
let sourceCount = null;          // Anzahl eingebundener CalDAV/CardDAV-Server (null = unbekannt)

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parseDateOnly = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const wdFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'short' });
const dmFmt = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;

function span(ev) {
  if (ev.allDay) return { s: parseDateOnly(ev.start), e: parseDateOnly(ev.end || ev.start), allDay: true };
  return { s: new Date(ev.start), e: new Date(ev.end || ev.start), allDay: false };
}

function hiddenCals() {
  try { return JSON.parse(localStorage.getItem('wm.hiddenCals') || '[]'); } catch { return []; }
}

function storedOpen() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* kein Speicher */ }
  return window.innerWidth >= WIDE;
}

function setStoredOpen(open) {
  try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* egal */ }
}

export function isOpen() {
  return document.body.classList.contains('agenda-open');
}

/** Einmalig beim App-Start: Spalte und Umschalter in der Kopfleiste anlegen. */
export function init() {
  el = document.getElementById('agenda');
  if (!el || el.dataset.ready) return;
  el.dataset.ready = '1';
  listEl = h('div', { class: 'agenda-list' });
  el.append(
    h('header', { class: 'agenda-head' },
      h('div', { class: 'agenda-title' }, h('strong', {}, 'Termine'), h('small', {}, 'Nächste 4 Wochen')),
      iconButton('refresh', 'Neu laden', () => load(true), { class: 'tiny' }),
      iconButton('chevronRight', 'Terminspalte einklappen', () => setOpen(false), { class: 'tiny' })),
    listEl);
  document.getElementById('agenda-backdrop').addEventListener('click', () => setOpen(false));

  toggleBtn = h('button', {
    class: 'icon-btn appbar-agenda', type: 'button', title: 'Termine ein-/ausblenden', 'aria-label': 'Termine ein-/ausblenden',
    'aria-controls': 'agenda', onClick: () => setOpen(!isOpen()),
  }, icon('agenda', 20));
  document.querySelector('.appbar').insertBefore(toggleBtn, document.getElementById('appbar-user'));

  subscribe((what) => { if (what === 'events' && isOpen()) load(true); });
  window.addEventListener('focus', () => { if (isOpen() && Date.now() - loadedAt > STALE_MS) load(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && window.innerWidth < 1200 && !document.querySelector('.modal-overlay')) setOpen(false);
  });
}

/** Wird beim Routing aufgerufen: Spalte nur in der Mail-Ansicht. */
export function setActive(on) {
  active = on;
  if (!el) return;
  document.body.classList.toggle('agenda-view', on);
  toggleBtn.hidden = !on;
  // Auf schmalen Bildschirmen liegt die Spalte über dem Inhalt – dort nicht automatisch öffnen
  apply(on && storedOpen() && window.innerWidth >= 1200);
}

function setOpen(open) {
  setStoredOpen(open);
  apply(open);
}

function apply(open) {
  document.body.classList.toggle('agenda-open', !!open && active);
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', !!open && active);
    toggleBtn.setAttribute('aria-expanded', String(!!open && active));
  }
  clearInterval(timer);
  timer = null;
  if (open && active) {
    if (Date.now() - loadedAt > STALE_MS) load(); else render();
    timer = setInterval(() => load(), REFRESH_MS);
  }
}

/** Nach Logout alles zurücksetzen. */
export function reset() {
  events = []; errors = []; loadedAt = 0; sourceCount = null;
  clearInterval(timer); timer = null;
  document.body.classList.remove('agenda-open', 'agenda-view');
  if (listEl) clear(listEl);
}

async function load(force = false) {
  if (!el || loading) return;
  if (!force && Date.now() - loadedAt < 5000) return;
  loading = true;
  el.classList.add('loading');
  const from = dayStart(new Date());
  const until = addDays(from, DAYS);
  try {
    if (force || sourceCount === null) {
      sourceCount = await get('/dav/sources').then((x) => x.sources.length).catch(() => sourceCount);
    }
    const r = await get('/events', { start: from.toISOString(), end: until.toISOString(), hidden: hiddenCals().join(',') });
    events = r.events || [];
    errors = r.errors || [];
  } catch (err) {
    errors = [{ sourceName: 'Kalender', message: err.message }];
  } finally {
    loading = false;
    loadedAt = Date.now();
    el.classList.remove('loading');
  }
  render();
}

function dayLabel(d, today) {
  const diff = Math.round((dayStart(d) - today) / 86400000);
  const date = `${wdFmt.format(d).replace('.', '')} ${dmFmt(d)}`;
  if (diff === 0) return ['Heute', date];
  if (diff === 1) return ['Morgen', date];
  return [date, ''];
}

function timeLabel(ev, sp, day) {
  if (sp.allDay) {
    const lastDay = addDays(sp.e, -1);
    return lastDay > sp.s ? `ganztägig bis ${dmFmt(lastDay)}` : 'ganztägig';
  }
  const sameDay = dayStart(sp.s).getTime() === dayStart(sp.e).getTime() || sp.e.getTime() === addDays(dayStart(sp.s), 1).getTime();
  if (sameDay) return `${hm(sp.s)} – ${hm(sp.e)}`;
  // mehrtägig: Beginn liegt vor dem angezeigten Tag → "bis …"
  if (sp.s < day) return `bis ${dmFmt(sp.e)} ${hm(sp.e)}`;
  return `${hm(sp.s)} – ${dmFmt(sp.e)} ${hm(sp.e)}`;
}

function render() {
  if (!listEl) return;
  const now = new Date();
  const today = dayStart(now);
  const hasCalendar = sourceCount !== 0;

  // Vergangene Termine von heute ausblenden; mehrtägige erscheinen am ersten sichtbaren Tag
  const items = events.map((ev) => ({ ev, sp: span(ev) }))
    .filter(({ sp }) => (sp.allDay ? sp.e > today : sp.e > now))
    .map((x) => ({ ...x, day: x.sp.s < today ? today : dayStart(x.sp.s) }))
    .sort((a, b) => (a.day - b.day) || (b.sp.allDay - a.sp.allDay) || (a.sp.s - b.sp.s) || String(a.ev.title).localeCompare(String(b.ev.title)));

  const groups = new Map();
  for (const it of items) {
    const k = ymd(it.day);
    if (!groups.has(k)) groups.set(k, { day: it.day, list: [] });
    groups.get(k).list.push(it);
  }

  const out = [];
  for (const e of errors) out.push(h('p', { class: 'agenda-error' }, `${e.sourceName}: ${e.message}`));
  if (!groups.size && !errors.length) {
    out.push(h('div', { class: 'agenda-empty' }, icon('agenda', 28),
      h('p', {}, hasCalendar ? 'Keine Termine in den nächsten 4 Wochen.' : 'Noch kein Kalender eingebunden.'),
      hasCalendar ? null : h('a', { href: '#/settings/dav' }, 'Kalender einbinden')));
  }
  for (const { day, list } of groups.values()) {
    const [main, sub] = dayLabel(day, today);
    out.push(h('section', { class: `agenda-day${day.getTime() === today.getTime() ? ' today' : ''}` },
      h('h3', {}, h('span', {}, main), sub ? h('small', {}, sub) : null),
      list.map(({ ev, sp }) => {
        const running = !sp.allDay && sp.s <= now && sp.e > now;
        return h('button', {
          type: 'button', class: `agenda-ev${running ? ' running' : ''}`,
          style: { '--ev-color': ev.color || 'var(--accent)' },
          title: [ev.title, ev.location].filter(Boolean).join(' – '),
          onClick: () => openInCalendar(ev, sp),
        },
        h('span', { class: 'agenda-time' }, timeLabel(ev, sp, day), running ? h('span', { class: 'agenda-now' }, 'läuft') : null),
        h('span', { class: 'agenda-ev-title' }, ev.title || '(ohne Titel)'),
        ev.location ? h('span', { class: 'agenda-loc' }, ev.location) : null);
      })));
  }
  clear(listEl, ...out);
}

function openInCalendar(ev, sp) {
  try { sessionStorage.setItem('wm.openEvent', JSON.stringify({ id: ev.id, start: ev.start })); } catch { /* egal */ }
  if (window.innerWidth < 1200) setOpen(false);
  location.hash = `#/calendar/${ymd(sp.s)}`;
}
