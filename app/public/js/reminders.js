// Terminerinnerungen als Browser-Benachrichtigung.
// Läuft, solange ein Webmail-Tab geöffnet ist (auch im Hintergrund).
import { get } from './api.js';
import { state } from './state.js';
import { toast } from './ui.js';

const LOOKAHEAD_DAYS = 8;        // Termine so weit im Voraus laden (längste Vorlaufzeit: 1 Woche)
const REFRESH_MS = 5 * 60000;    // Terminliste alle 5 Min. neu laden
const GRACE_MS = 10 * 60000;     // verpasste Erinnerungen (z. B. Rechner im Ruhezustand) bis 10 Min. nachholen
const ALLDAY_HOUR = 9;           // ganztägige Termine: Standard-Erinnerung um 09:00 am Tag selbst

let refreshTimer = null;
let timers = [];
let running = false;

export const REMINDER_OPTIONS = [
  [0, 'Zum Beginn'], [5, '5 Minuten vorher'], [10, '10 Minuten vorher'], [15, '15 Minuten vorher'],
  [30, '30 Minuten vorher'], [60, '1 Stunde vorher'], [120, '2 Stunden vorher'], [1440, '1 Tag vorher'],
  [2880, '2 Tage vorher'], [10080, '1 Woche vorher'],
];

export function reminderLabel(min) {
  const o = REMINDER_OPTIONS.find(([m]) => m === Number(min));
  if (o) return o[1];
  if (min < 0) return `${-min} Minuten nach Beginn`;
  if (min % 1440 === 0) return `${min / 1440} Tage vorher`;
  if (min % 60 === 0) return `${min / 60} Stunden vorher`;
  return `${min} Minuten vorher`;
}

export function settings() {
  const s = (state.user && state.user.settings) || {};
  return {
    enabled: s.reminders !== false,
    defaultMinutes: s.reminderDefault === undefined ? 15 : s.reminderDefault, // null = keine Standard-Erinnerung
  };
}

function hidden() {
  try { return JSON.parse(localStorage.getItem('wm.hiddenCals') || '[]'); } catch { return []; }
}

// Bereits gezeigte Erinnerungen merken (über Tabs hinweg, damit nicht jeder Tab meldet)
function seenKey(id) { return `wm.rem.${id}`; }
function alreadyShown(id) {
  try { return !!localStorage.getItem(seenKey(id)); } catch { return false; }
}
function markShown(id) {
  try {
    localStorage.setItem(seenKey(id), String(Date.now()));
    // Alte Einträge (> 3 Tage) aufräumen
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('wm.rem.') && Date.now() - Number(localStorage.getItem(k)) > 3 * 86400000) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

function startOf(ev) {
  if (ev.allDay) {
    const [y, m, d] = ev.start.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(ev.start);
}

/** Alle Erinnerungszeitpunkte eines Termins. */
function fireTimes(ev, cfg) {
  const start = startOf(ev);
  if (Array.isArray(ev.alarms)) return ev.alarms.map((m) => ({ at: new Date(start.getTime() - m * 60000), minutes: m }));
  if (cfg.defaultMinutes === null || cfg.defaultMinutes === 'none') return [];
  if (ev.allDay) {
    const at = new Date(start); at.setHours(ALLDAY_HOUR, 0, 0, 0);
    return [{ at, minutes: null }];
  }
  return [{ at: new Date(start.getTime() - Number(cfg.defaultMinutes) * 60000), minutes: Number(cfg.defaultMinutes) }];
}

function fmtWhen(ev) {
  const s = startOf(ev);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const day = s.toDateString() === today.toDateString() ? 'Heute'
    : s.toDateString() === tomorrow.toDateString() ? 'Morgen'
      : s.toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  if (ev.allDay) return `${day}, ganztägig`;
  const t = (d) => d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${day}, ${t(s)}–${t(new Date(ev.end))} Uhr`;
}

function show(ev, key) {
  if (alreadyShown(key)) return;
  markShown(key);
  const title = `📅 ${ev.title}`;
  const body = [fmtWhen(ev), ev.location].filter(Boolean).join('\n');
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: key, requireInteraction: true });
      n.onclick = () => { window.focus(); location.hash = '#/calendar'; n.close(); };
    } catch { /* manche Browser erlauben new Notification nur im Service Worker */ }
  }
  if (document.visibilityState === 'visible') toast(`${ev.title} – ${fmtWhen(ev)}`, 'info', 10000);
}

async function refresh() {
  if (!running) return;
  timers.forEach(clearTimeout);
  timers = [];
  const cfg = settings();
  if (!cfg.enabled) return;
  const now = Date.now();
  // Vergangene Termine kurz zurück laden, damit gerade begonnene/verpasste Erinnerungen noch kommen
  const from = new Date(now - 60 * 60000);
  // Weit genug vorausschauen, damit auch "1 Woche vorher"-Erinnerungen erfasst werden
  const until = new Date(now + LOOKAHEAD_DAYS * 86400000);
  let events;
  try {
    ({ events } = await get('/events', { start: from.toISOString(), end: until.toISOString(), hidden: hidden().join(',') }));
  } catch {
    return; // nächster Versuch beim nächsten Intervall
  }
  for (const ev of events) {
    for (const f of fireTimes(ev, cfg)) {
      const key = `${ev.id}|${ev.start}|${f.at.getTime()}`;
      const delay = f.at.getTime() - Date.now();
      if (delay <= 0) {
        if (-delay <= GRACE_MS && startOf(ev).getTime() + 60000 > Date.now() - GRACE_MS) show(ev, key);
      } else if (delay < REFRESH_MS + 60000) {
        timers.push(setTimeout(() => show(ev, key), delay));
      }
    }
  }
}

export function start() {
  if (running) return;
  running = true;
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
  // Nach Ruhezustand / Tab-Wechsel sofort prüfen
  document.addEventListener('visibilitychange', onVisible);
}

function onVisible() {
  if (document.visibilityState === 'visible') refresh();
}

export function stop() {
  running = false;
  clearInterval(refreshTimer);
  timers.forEach(clearTimeout);
  timers = [];
  document.removeEventListener('visibilitychange', onVisible);
}

/** Nach Änderungen an Terminen oder Einstellungen aufrufen. */
export function reschedule() {
  if (running) refresh();
}
