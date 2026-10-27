// Kleine DOM-/UI-Helfer ohne Framework.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ Icons
const ICONS = {
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  send: 'M4 12l16-8-6 16-2-7z',
  draft: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  junk: 'M12 3l9 16H3zM12 10v4M12 17v.5',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  folder: 'M3 6h6l2 2h10v11H3z',
  all: 'M4 6h16M4 12h16M4 18h16',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z',
  reply: 'M10 8L4 13l6 5M4 13h10a6 6 0 016 6',
  replyAll: 'M12 8L6 13l6 5M8 8l-5 5 5 5M6 13h8a6 6 0 016 6',
  forward: 'M14 8l6 5-6 5M20 13H10a6 6 0 00-6 6',
  mail: 'M3 6h18v12H3zM3 6l9 7 9-7',
  mailOpen: 'M3 10l9-6 9 6v9H3zM3 10l9 6 9-6',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v5M15 3v5',
  agenda: 'M4 6h16v14H4zM4 10h16M9 3v5M15 3v5M8 14h3M13 14h3M8 17h3',
  contacts: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  clip: 'M20 12l-8 8a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M6 9l6 6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  move: 'M3 6h6l2 2h10v11H3zM10 14h6M13 11l3 3-3 3',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7zM17 12h.01',
  check: 'M5 12l5 5 9-10',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  back: 'M19 12H5M12 5l-7 7 7 7',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  bold: 'M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z',
  italic: 'M10 5h8M6 19h8M14 5l-4 14',
  underline: 'M7 4v7a5 5 0 0010 0V4M5 20h14',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  link: 'M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1',
  quote: 'M6 17h3l2-4V7H5v6h3M14 17h3l2-4V7h-6v6h3',
  download: 'M12 4v12M6 10l6 6 6-6M4 20h16',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.folder);
  svg.appendChild(p);
  return svg;
}

export function iconButton(name, title, onClick, extra = {}) {
  return h('button', { class: `icon-btn ${extra.class || ''}`, title, 'aria-label': title, type: 'button', onClick, ...extra.attrs }, icon(name));
}

// ------------------------------------------------------------------ Toasts
export function toast(message, type = 'info', timeout = 4000) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, timeout);
  return el;
}

// ------------------------------------------------------------------ Modal
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const footer = h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
    class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`,
    type: 'button',
    onClick: async (e) => {
      if (a.onClick) {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const keepOpen = await a.onClick();
          if (keepOpen !== true) close();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      } else close();
    },
  }, a.label)));
  const dialog = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), iconButton('close', 'Schließen', close)),
    h('div', { class: 'modal-body' }, body),
    actions.length ? footer : null);
  const overlay = h('div', { class: 'modal-overlay', onMousedown: (e) => { if (e.target === overlay) close(); } }, dialog);
  root.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  const first = dialog.querySelector('input:not([type=hidden]),select,textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: dialog };
}

export function confirmDialog(title, text, { danger = true, confirmLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: h('p', {}, text),
      actions: [
        { label: 'Abbrechen', onClick: () => { done = true; resolve(false); } },
        { label: confirmLabel, primary: !danger, danger, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/**
 * Auswahl-Dialog: choices [{ value, label, primary, danger }], optional eine Checkbox.
 * → Promise<{ value, checked } | null>
 */
export function choiceDialog(title, text, choices, { checkbox = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const cb = checkbox ? h('input', { type: 'checkbox', checked: checkbox.checked !== false }) : null;
    modal({
      title,
      body: h('div', { class: 'choice-body' },
        text ? h('p', {}, text) : null,
        cb ? h('label', { class: 'check' }, cb, ` ${checkbox.label}`) : null),
      actions: [
        { label: 'Abbrechen', onClick: () => { done = true; resolve(null); } },
        ...choices.map((c) => ({ label: c.label, primary: c.primary, danger: c.danger,
          onClick: () => { done = true; resolve({ value: c.value, checked: cb ? cb.checked : false }); } })),
      ],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value });
    let done = false;
    const m = modal({
      title,
      body: h('label', { class: 'field' }, h('span', {}, label), input),
      actions: [
        { label: 'Abbrechen', onClick: () => { done = true; resolve(null); } },
        { label: 'OK', primary: true, onClick: () => { done = true; resolve(input.value.trim()); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { done = true; resolve(input.value.trim()); m.close(); }
    });
  });
}

// ------------------------------------------------------------------ Formular-Helfer
export function field(label, input, hint) {
  // <label> nur um einzelne Eingabefelder: Ein Klick in ein Label löst sonst einen Klick auf das
  // erste Bedienelement darin aus (z. B. den Fett-Knopf eines Editors)
  const simple = input instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(input.tagName);
  return h(simple ? 'label' : 'div', { class: 'field', ...(simple ? {} : { role: 'group' }) },
    h('span', {}, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function formValues(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

// ------------------------------------------------------------------ Formatierung
const dtf = (opts) => new Intl.DateTimeFormat('de-CH', opts.hour ? { hourCycle: 'h23', ...opts } : opts);
const fmtTime = dtf({ hour: '2-digit', minute: '2-digit' });
const fmtDay = dtf({ day: 'numeric', month: 'short' });
const fmtFull = dtf({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = dtf({ day: '2-digit', month: '2-digit', year: 'numeric' });

export function shortDate(d) {
  if (!d) return '';
  const date = new Date(d);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return fmtTime.format(date);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return 'Gestern';
  if (now - date < 6 * 86400000 && date < now) return dtf({ weekday: 'short' }).format(date);
  if (date.getFullYear() === now.getFullYear()) return fmtDay.format(date);
  return fmtDate.format(date);
}

export function fullDate(d) {
  return d ? fmtFull.format(new Date(d)) : '';
}

export function timeOnly(d) {
  return fmtTime.format(new Date(d));
}

export function fileSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatAddress(a) {
  if (!a) return '';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function initials(name) {
  const parts = String(name || '?').replace(/[<>"@].*$/, '').trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  return s.toUpperCase();
}

export function colorFor(str) {
  let hash = 0;
  for (const ch of String(str || '')) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 48%)`;
}

// Kontaktfotos: E-Mail-Adressen, für die ein Foto im Adressbuch hinterlegt ist
let photoEmails = new Set();

function initialsAvatar(name, address, size) {
  return h('span', {
    class: 'avatar',
    style: { background: colorFor(address || name), width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` },
    'aria-hidden': 'true',
    dataset: { email: String(address || '').toLowerCase(), name: name || '', size: String(size) },
  }, initials(name || address));
}

function imageAvatar(src, name, address, size) {
  const img = h('img', {
    class: 'avatar avatar-img', src, alt: '', loading: 'lazy', decoding: 'async',
    width: size, height: size, style: { width: `${size}px`, height: `${size}px` },
    dataset: { email: String(address || '').toLowerCase(), name: name || '', size: String(size) },
  });
  img.addEventListener('error', () => img.replaceWith(initialsAvatar(name, address, size)), { once: true });
  return img;
}

/**
 * Avatar mit Kontaktfoto (falls vorhanden) oder Initialen.
 * opts.photoUrl: direktes Foto (z. B. aus dem Adressbuch)
 */
export function avatar(name, address, size = 36, opts = {}) {
  if (opts.photoUrl) return imageAvatar(opts.photoUrl, name, address, size);
  const key = String(address || '').toLowerCase();
  if (key && photoEmails.has(key)) return imageAvatar(`/api/contact-photo?email=${encodeURIComponent(key)}`, name, address, size);
  return initialsAvatar(name, address, size);
}

/** Liste der Adressen mit Foto setzen und bereits angezeigte Avatare aktualisieren. */
export function setPhotoEmails(list, { bust = false } = {}) {
  photoEmails = new Set((list || []).map((e) => String(e).toLowerCase()));
  const v = bust ? `&v=${Date.now()}` : '';
  for (const el of document.querySelectorAll('.avatar[data-email]')) {
    const { email, name, size } = el.dataset;
    if (!email) continue;
    const has = photoEmails.has(email);
    if (has && (el.tagName !== 'IMG' || bust)) el.replaceWith(imageAvatar(`/api/contact-photo?email=${encodeURIComponent(email)}${v}`, name, email, Number(size)));
    else if (!has && el.tagName === 'IMG' && !el.classList.contains('avatar-direct')) el.replaceWith(initialsAvatar(name, email, Number(size)));
  }
}

/** Bild verkleinern/zuschneiden (quadratisch) und als JPEG-data:-URI liefern. */
export function imageToAvatarDataUrl(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------ Datum/Zeit-Eingabe (deutsch, 24 h)
// Native <input type=date/time> richtet sich nach der Browsersprache (oft US: MM/DD/YYYY, AM/PM).
// Deshalb eigene Felder: TT.MM.JJJJ und HH:MM, unabhängig von Browser und Betriebssystem.

const pad2 = (n) => String(n).padStart(2, '0');

/** "21.11.2026", "21.11.26", "21.11." (aktuelles Jahr), "21112026", "2026-11-21" -> "2026-11-21" | null */
export function parseDeDate(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let d; let m; let y;
  let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (r) { [, y, m, d] = r; } else {
    r = s.match(/^(\d{1,2})[.\/\- ](\d{1,2})(?:[.\/\- ](\d{2,4})?)?\.?$/) || s.match(/^(\d{2})(\d{2})(\d{2}|\d{4})?$/);
    if (!r) return null;
    [, d, m, y] = r;
  }
  d = Number(d); m = Number(m);
  y = y === undefined || y === '' ? new Date().getFullYear() : Number(y);
  if (y < 100) y += 2000;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** "2026-11-21" -> "21.11.2026" */
export function formatDeDate(iso) {
  const r = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return r ? `${r[3]}.${r[2]}.${r[1]}` : '';
}

/** "9", "930", "9:30", "9.30", "09h30" -> "09:30" | null */
export function parseTime(input) {
  const s = String(input || '').trim().toLowerCase().replace(/\s*uhr$/, '');
  if (!s) return null;
  let r = s.match(/^(\d{1,2})(?:[:.h](\d{1,2}))?$/) || s.match(/^(\d{1,2})(\d{2})$/);
  if (!r) return null;
  const hh = Number(r[1]); const mm = Number(r[2] || 0);
  if (hh > 23 || mm > 59) return null;
  return `${pad2(hh)}:${pad2(mm)}`;
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/**
 * Datumsfeld (TT.MM.JJJJ) mit Kalender-Popup.
 * .value liest/schreibt ISO "JJJJ-MM-TT"; löst "change" aus.
 */
export function dateInput(iso, { placeholder = 'TT.MM.JJJJ', label = 'Datum' } = {}) {
  const input = h('input', { type: 'text', class: 'date-input', inputmode: 'numeric', autocomplete: 'off', placeholder, value: formatDeDate(iso), 'aria-label': label });
  const btn = h('button', { type: 'button', class: 'icon-btn tiny date-btn', title: 'Kalender öffnen', 'aria-label': 'Kalender öffnen' }, icon('calendar', 15));
  const wrap = h('div', { class: 'date-field' }, input, btn);
  let popup = null;

  const commit = () => {
    const p = parseDeDate(input.value);
    if (p) input.value = formatDeDate(p);
    input.classList.toggle('invalid', !!input.value.trim() && !p);
    wrap.dispatchEvent(new Event('change'));
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });

  const closePopup = () => {
    if (!popup) return;
    popup.remove();
    popup = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  const outside = (e) => { if (!wrap.contains(e.target)) closePopup(); };
  const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopup(); } };

  const openPopup = () => {
    if (popup) { closePopup(); return; }
    const cur = parseDeDate(input.value) || (() => { const t = new Date(); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`; })();
    let [y, m] = cur.split('-').map(Number);
    popup = h('div', { class: 'date-popup', role: 'dialog', 'aria-label': 'Datum wählen' });
    const draw = () => {
      const first = new Date(y, m - 1, 1);
      const offset = (first.getDay() + 6) % 7;
      const days = new Date(y, m, 0).getDate();
      const sel = parseDeDate(input.value);
      const today = new Date();
      const todayIso = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
      const cells = [];
      for (let i = 0; i < offset; i++) cells.push(h('span', {}));
      for (let d = 1; d <= days; d++) {
        const iso2 = `${y}-${pad2(m)}-${pad2(d)}`;
        cells.push(h('button', {
          type: 'button', class: `dp-day ${iso2 === sel ? 'sel' : ''} ${iso2 === todayIso ? 'today' : ''}`,
          onClick: () => { input.value = formatDeDate(iso2); closePopup(); commit(); input.focus(); },
        }, d));
      }
      clear(popup,
        h('div', { class: 'dp-head' },
          h('button', { type: 'button', class: 'icon-btn tiny', title: 'Vorheriger Monat', onClick: () => { m--; if (m < 1) { m = 12; y--; } draw(); } }, icon('chevronLeft', 14)),
          h('span', {}, `${MONTHS[m - 1]} ${y}`),
          h('button', { type: 'button', class: 'icon-btn tiny', title: 'Nächster Monat', onClick: () => { m++; if (m > 12) { m = 1; y++; } draw(); } }, icon('chevronRight', 14))),
        h('div', { class: 'dp-grid' }, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((w) => h('span', { class: 'dp-wd' }, w)), cells));
    };
    draw();
    wrap.appendChild(popup);
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  };
  btn.addEventListener('click', openPopup);

  Object.defineProperty(wrap, 'value', {
    get: () => parseDeDate(input.value) || '',
    set: (v) => { input.value = formatDeDate(v); input.classList.remove('invalid'); },
  });
  Object.defineProperty(wrap, 'disabled', {
    get: () => input.disabled,
    set: (v) => { input.disabled = !!v; btn.disabled = !!v; },
  });
  wrap.isValid = () => !input.value.trim() || !!parseDeDate(input.value);
  wrap.input = input;
  return wrap;
}

/** Zeitfeld HH:MM (24 h) mit Vorschlagsliste in 30-Minuten-Schritten. */
export function timeInput(value) {
  if (!document.getElementById('wm-times')) {
    const dl = h('datalist', { id: 'wm-times' });
    for (let i = 0; i < 48; i++) dl.appendChild(h('option', { value: `${pad2(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}` }));
    document.body.appendChild(dl);
  }
  const input = h('input', { type: 'text', class: 'time-input', inputmode: 'numeric', autocomplete: 'off', placeholder: 'HH:MM', list: 'wm-times', value: value || '', 'aria-label': 'Uhrzeit' });
  input.addEventListener('blur', () => {
    const p = parseTime(input.value);
    if (p) input.value = p;
    input.classList.toggle('invalid', !!input.value.trim() && !p);
  });
  return input;
}
