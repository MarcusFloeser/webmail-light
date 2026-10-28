// Speicherplatz eines Postfachs: Balken + Text (Ordnerleiste und Kontoeinstellungen).
import { h } from './ui.js';
import { state } from './state.js';

export function bytes(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('de-CH', { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

/** Füllstand in Prozent (oder null ohne Limit) */
export function percent(q) {
  return q && q.limit ? Math.min(100, Math.round((q.used / q.limit) * 100)) : null;
}

/** Schwellen aus der .env (QUOTA_WARN_PERCENT / QUOTA_FULL_PERCENT) */
export function thresholds() {
  const c = state.config || {};
  const full = Number(c.quotaFullPercent) || 95;
  const warn = Math.min(Number(c.quotaWarnPercent) || 80, full);
  return { warn, full };
}

/** '' (grün) | 'warn' (orange) | 'full' (rot) */
export function level(p) {
  if (p === null || p === undefined) return '';
  const t = thresholds();
  return p >= t.full ? 'full' : p >= t.warn ? 'warn' : '';
}

function stand(q) {
  if (!q.checkedAt) return '';
  const d = new Date(q.checkedAt);
  return `Stand: ${d.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * opts.compact: kurze Form für die Ordnerleiste
 */
export function quotaView(q, { compact = false } = {}) {
  if (!q) return null;
  const p = percent(q);
  const est = q.source === 'estimate';
  const text = p !== null
    ? `${bytes(q.used)} von ${bytes(q.limit)} belegt (${p} %)`
    : `${est ? 'ca. ' : ''}${bytes(q.used)} belegt`;
  const tip = [text, p !== null ? `${bytes(Math.max(0, q.limit - q.used))} frei` : (est ? 'Schätzung – der Mailserver meldet keine Speichergrenze' : 'Keine Speichergrenze gemeldet'), stand(q)].filter(Boolean).join(' · ');
  return h('div', { class: `quota ${compact ? 'compact' : ''} ${level(p)}`, title: tip },
    p !== null ? h('div', { class: 'quota-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p), 'aria-label': 'Speicherplatz' },
      h('span', { style: { width: `${Math.max(p, 1)}%` } })) : null,
    h('div', { class: 'quota-text' }, compact ? (p !== null ? `${bytes(q.used)} von ${bytes(q.limit)}` : text) : text),
    !compact && level(p)
      ? h('p', { class: `quota-hint ${level(p)}` }, level(p) === 'full'
        ? 'Das Postfach ist fast voll – neue Mails können abgewiesen werden. Bitte alte Mails oder grosse Anhänge löschen und den Papierkorb leeren.'
        : 'Das Postfach wird langsam voll. Alte Mails oder grosse Anhänge löschen und den Papierkorb leeren schafft Platz.') : null);
}
