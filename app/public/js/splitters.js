// Verschiebbare Spaltentrenner. Breiten werden pro Browser gespeichert (Bildschirme sind verschieden).
// Doppelklick auf einen Trenner stellt die Standardbreite wieder her; per Tastatur mit ← / →.

const KEY = 'wm.widths';

// key → Spalte, CSS-Variable, Grenzen, Richtung (+1: Trenner rechts der Spalte, -1: links davon)
const PANES = [
  { key: 'sidebar', sel: '#sidebar', cssVar: '--sidebar-w', min: 180, max: 440, dir: 1, label: 'Breite der Ordnerliste' },
  { key: 'list', sel: '.list-pane', cssVar: '--list-w', min: 260, max: 900, dir: 1, label: 'Breite der Mail-Liste' },
  { key: 'agenda', sel: '#agenda', cssVar: '--agenda-w', min: 220, max: 520, dir: -1, label: 'Breite der Terminspalte' },
  { key: 'contacts', sel: '.contact-col', cssVar: '--contact-w', min: 240, max: 620, dir: 1, label: 'Breite der Kontaktliste' },
  { key: 'calside', sel: '.cal-side', cssVar: '--calside-w', min: 180, max: 420, dir: 1, label: 'Breite der Kalenderleiste' },
];
const MIN_MAIN = 340; // so viel Platz bleibt mindestens für den Inhalt rechts daneben

let widths = {};
let observer = null;

function load() {
  try { widths = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { widths = {}; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(widths)); } catch { /* egal */ }
}

function applyAll() {
  const root = document.documentElement;
  for (const p of PANES) {
    if (widths[p.key]) root.style.setProperty(p.cssVar, `${widths[p.key]}px`);
    else root.style.removeProperty(p.cssVar);
  }
}

/** Höchstbreite: Grenze der Spalte, aber genug Platz für den restlichen Inhalt lassen. */
function maxFor(p, pane) {
  const row = pane.parentElement;
  if (!row) return p.max;
  let others = 0;
  for (const el of row.children) {
    if (el === pane || el.classList.contains('splitter')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue;
    // flexible Spalten (flex-grow) brauchen ihre Mindestbreite, feste behalten ihre Breite
    others += cs.flexGrow !== '0' ? MIN_MAIN : el.getBoundingClientRect().width;
  }
  return Math.max(p.min, Math.min(p.max, row.getBoundingClientRect().width - others));
}

function setWidth(p, px, pane) {
  const w = Math.round(Math.max(p.min, Math.min(maxFor(p, pane), px)));
  widths[p.key] = w;
  document.documentElement.style.setProperty(p.cssVar, `${w}px`);
  return w;
}

function makeSplitter(p, pane) {
  const s = document.createElement('div');
  s.className = 'splitter';
  s.dataset.key = p.key;
  s.setAttribute('role', 'separator');
  s.setAttribute('aria-orientation', 'vertical');
  s.setAttribute('aria-label', p.label);
  s.setAttribute('tabindex', '0');
  s.title = `${p.label} ändern – Doppelklick: Standardbreite`;
  const sync = () => {
    s.setAttribute('aria-valuenow', String(Math.round(pane.getBoundingClientRect().width)));
    s.setAttribute('aria-valuemin', String(p.min));
    s.setAttribute('aria-valuemax', String(p.max));
  };

  s.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = pane.getBoundingClientRect().width;
    s.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    s.classList.add('active');
    let frame = 0;
    const move = (ev) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(p, startW + (ev.clientX - startX) * p.dir, pane));
    };
    const up = () => {
      cancelAnimationFrame(frame);
      s.removeEventListener('pointermove', move);
      s.removeEventListener('pointerup', up);
      s.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      s.classList.remove('active');
      save();
      sync();
      window.dispatchEvent(new Event('resize')); // z. B. iframes der Mail-Ansicht neu messen
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
    s.addEventListener('pointercancel', up);
  });

  s.addEventListener('dblclick', () => {
    delete widths[p.key];
    document.documentElement.style.removeProperty(p.cssVar);
    save();
    sync();
  });

  s.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    let delta = 0;
    if (e.key === 'ArrowLeft') delta = -step;
    else if (e.key === 'ArrowRight') delta = step;
    else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setWidth(p, e.key === 'Home' ? p.min : p.max, pane);
      save(); sync();
      return;
    } else return;
    e.preventDefault();
    setWidth(p, pane.getBoundingClientRect().width + delta * p.dir, pane);
    save();
    sync();
  });
  s.addEventListener('focus', sync);
  return s;
}

/** Fehlende Trenner an vorhandene Spalten anfügen (nach jedem Neuaufbau einer Ansicht). */
export function ensure() {
  for (const p of PANES) {
    for (const pane of document.querySelectorAll(p.sel)) {
      const neighbour = p.dir > 0 ? pane.nextElementSibling : pane.previousElementSibling;
      if (neighbour && neighbour.classList.contains('splitter') && neighbour.dataset.key === p.key) continue;
      const s = makeSplitter(p, pane);
      if (p.dir > 0) pane.after(s); else pane.before(s);
    }
  }
}

export function init() {
  load();
  applyAll();
  ensure();
  if (!observer) {
    let queued = false;
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; ensure(); });
    });
    observer.observe(document.querySelector('.shell-body'), { childList: true, subtree: true });
  }
}
