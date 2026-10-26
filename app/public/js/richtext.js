// Kleiner WYSIWYG-Editor (z. B. für Signaturen): Fett/Kursiv/…, Farbe, Grösse, Links, Bilder –
// mit Umschalter auf den HTML-Quelltext.
import { h, iconButton, toast, promptDialog } from './ui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Text ohne HTML-Tags → HTML mit Zeilenumbrüchen */
export function textToHtml(text) {
  return esc(text || '').replace(/\n/g, '<br>');
}

/** Gefährliches entfernen, Formatierung behalten. */
export function sanitizeRich(html) {
  const doc = new DOMParser().parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
  doc.querySelectorAll('script, style, link, meta, iframe, object, embed, base, title, form, input, button, textarea, select').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'src') && /^\s*(javascript|vbscript):/i.test(attr.value)) el.removeAttribute(attr.name);
      else if (n === 'src' && el.tagName === 'IMG' && !/^(data:image\/(png|jpe?g|gif|webp);base64,|https?:)/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
  });
  return doc.body.innerHTML;
}

/** Ist der Inhalt praktisch leer (nur Leerzeichen/Zeilenumbrüche, keine Bilder)? */
function isEmptyHtml(html) {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return !d.body.textContent.trim() && !d.body.querySelector('img');
}

/** Bild verkleinern (Logo-Grösse) und als data:-URL liefern; PNG bleibt PNG (Transparenz). */
function imageToDataUrl(file, maxW = 300, maxH = 120) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) { reject(new Error('Bitte ein Bild (PNG, JPEG, GIF oder WebP) wählen')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const hh = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = hh;
        const ctx = c.getContext('2d');
        const png = /png|gif|webp/i.test(file.type);
        if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hh); }
        ctx.drawImage(img, 0, 0, w, hh);
        resolve({ src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), width: w, height: hh });
      } catch (err) { reject(err); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}

/**
 * Editor erzeugen.
 * @returns {{ el: HTMLElement, getHtml: () => string, focus: () => void }}
 */
export function richEditor({ html = '', placeholder = '', minHeight = 140 } = {}) {
  const initial = /<[a-z][\s\S]*>/i.test(html) ? sanitizeRich(html) : textToHtml(html);
  let sourceMode = false;

  const area = h('div', {
    class: 'rte-area', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true',
    'data-placeholder': placeholder, style: { minHeight: `${minHeight}px` },
  });
  area.innerHTML = initial;
  const source = h('textarea', { class: 'rte-source', spellcheck: 'false', hidden: true, style: { minHeight: `${minHeight}px` }, 'aria-label': 'HTML-Quelltext' });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });

  // gespeicherte Auswahl (Farbwähler/Dialoge nehmen sonst den Fokus)
  let savedRange = null;
  const saveSel = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && area.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreSel = () => {
    area.focus();
    if (savedRange) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
  };
  area.addEventListener('keyup', saveSel);
  area.addEventListener('mouseup', saveSel);
  area.addEventListener('input', saveSel);

  const exec = (cmd, value) => {
    if (sourceMode) return;
    restoreSel();
    try { document.execCommand('styleWithCSS', false, true); } catch { /* alte Browser */ }
    document.execCommand(cmd, false, value);
    saveSel();
    updateState();
  };
  const btn = (icon, title, fn) => iconButton(icon, title, (e) => { e.preventDefault(); fn(); }, { class: 'rte-btn' });
  const txtBtn = (label, title, fn, cls = '') => h('button', {
    type: 'button', class: `icon-btn rte-btn txt ${cls}`, title, 'aria-label': title,
    onMousedown: (e) => e.preventDefault(), onClick: (e) => { e.preventDefault(); fn(); },
  }, label);

  const colorMark = h('span', { class: 'rte-a' }, 'A');
  const showColor = (hex) => { colorMark.style.borderBottomColor = hex; };
  const color = h('input', {
    type: 'color', class: 'rte-color', value: '#1c2027', title: 'Schriftfarbe',
    onInput: (e) => { showColor(e.target.value); exec('foreColor', e.target.value); },
  });
  showColor(color.value);
  color.addEventListener('mousedown', saveSel);
  const size = h('select', { class: 'rte-size', title: 'Schriftgrösse', 'aria-label': 'Schriftgrösse',
    onChange: (e) => { if (e.target.value) exec('fontSize', e.target.value); e.target.value = ''; } },
  h('option', { value: '' }, 'Grösse'),
  h('option', { value: '2' }, 'Klein'),
  h('option', { value: '3' }, 'Normal'),
  h('option', { value: '4' }, 'Gross'),
  h('option', { value: '5' }, 'Sehr gross'));
  size.addEventListener('mousedown', saveSel);

  const bBold = btn('bold', 'Fett (Strg+B)', () => exec('bold'));
  const bItalic = btn('italic', 'Kursiv (Strg+I)', () => exec('italic'));
  const bUnder = btn('underline', 'Unterstrichen (Strg+U)', () => exec('underline'));
  const toggleSrc = txtBtn('</>', 'HTML-Quelltext bearbeiten', () => setSource(!sourceMode), 'rte-src');

  const toolbar = h('div', { class: 'rte-bar', role: 'toolbar', 'aria-label': 'Formatierung' },
    bBold, bItalic, bUnder,
    h('span', { class: 'rte-sep' }),
    size, h('label', { class: 'rte-color-wrap', title: 'Schriftfarbe' }, colorMark, color),
    h('span', { class: 'rte-sep' }),
    btn('list', 'Aufzählung', () => exec('insertUnorderedList')),
    txtBtn('⇤', 'Linksbündig', () => exec('justifyLeft')),
    txtBtn('↔', 'Zentriert', () => exec('justifyCenter')),
    h('span', { class: 'rte-sep' }),
    btn('link', 'Link einfügen', async () => {
      saveSel();
      const url = await promptDialog('Link einfügen', 'Adresse (https://…, mailto:… oder tel:…)', 'https://');
      if (url && /^(https?:|mailto:|tel:)/i.test(url.trim())) exec('createLink', url.trim());
      else if (url) toast('Bitte eine Adresse mit https://, mailto: oder tel: angeben', 'error');
    }),
    btn('image', 'Bild/Logo einfügen', () => { saveSel(); fileInput.click(); }),
    txtBtn('Tx', 'Formatierung entfernen', () => exec('removeFormat')),
    h('span', { class: 'grow' }),
    toggleSrc);

  function updateState() {
    if (sourceMode) return;
    const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
    bBold.classList.toggle('on', q('bold'));
    bItalic.classList.toggle('on', q('italic'));
    bUnder.classList.toggle('on', q('underline'));
    // Farbwähler zeigt die Farbe des Textes an der Cursor-Position
    let v = '';
    try { v = document.queryCommandValue('foreColor'); } catch { /* egal */ }
    const hex = toHex(v);
    if (hex && document.activeElement === area) { color.value = hex; showColor(hex); }
  }
  document.addEventListener('selectionchange', () => { if (area.isConnected && area.contains(document.activeElement)) updateState(); });

  function setSource(on) {
    if (on === sourceMode) return;
    if (on) {
      source.value = prettyHtml(area.innerHTML);
    } else {
      area.innerHTML = sanitizeRich(source.value);
    }
    sourceMode = on;
    area.hidden = on;
    source.hidden = !on;
    toggleSrc.classList.toggle('on', on);
    toolbar.classList.toggle('source', on);
    (on ? source : area).focus();
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const img = await imageToDataUrl(f);
      exec('insertHTML', `<img src="${img.src}" width="${img.width}" height="${img.height}" alt="">`);
    } catch (err) { toast(err.message, 'error'); }
  });

  // Einfügen aus Word/Webseiten: Formatierung behalten, Gefährliches entfernen
  area.addEventListener('paste', (e) => {
    const html = e.clipboardData && e.clipboardData.getData('text/html');
    if (html) {
      e.preventDefault();
      const clean = sanitizeRich(html.replace(/<!--[\s\S]*?-->/g, ''));
      document.execCommand('insertHTML', false, clean);
    }
  });

  const el = h('div', { class: 'rte' }, toolbar, area, source, fileInput);
  return {
    el,
    focus: () => (sourceMode ? source : area).focus(),
    getHtml: () => {
      const raw = sourceMode ? sanitizeRich(source.value) : sanitizeRich(area.innerHTML);
      return isEmptyHtml(raw) ? '' : raw;
    },
  };
}

/** 'rgb(1, 2, 3)' oder '#abc' → '#rrggbb' */
function toHex(v) {
  const s = String(v || '').trim();
  let m = s.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) return m[1].length === 3 ? `#${m[1].split('').map((c) => c + c).join('')}` : `#${m[1].toLowerCase()}`;
  return '';
}

/** Einfache Zeilenumbrüche für die Quelltext-Ansicht */
function prettyHtml(html) {
  return String(html).replace(/(<br\s*\/?>)(?!\n)/gi, '$1\n').replace(/(<\/(p|div|li|ul|ol|table|tr|h\d)>)(?!\n)/gi, '$1\n');
}
