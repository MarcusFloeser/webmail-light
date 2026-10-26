// Nachrichten drucken bzw. über den Systemdialog als PDF speichern.
// Baut ein eigenes, schlichtes Druckdokument in einem unsichtbaren iframe (ohne Skriptrechte)
// und öffnet dafür den Druckdialog des Browsers.
import { get } from './api.js';
import { toast } from './ui.js';

const MAX = 200;          // Obergrenze pro Druckauftrag
const PARALLEL = 4;       // gleichzeitige Abrufe
const IMG_TIMEOUT = 5000; // so lange auf Bilder warten

const pad = (n) => String(n).padStart(2, '0');
function deDateTime(d) {
  const x = new Date(d);
  if (isNaN(x)) return '';
  const wd = x.toLocaleDateString('de-CH', { weekday: 'short' }).replace('.', '');
  return `${wd}, ${pad(x.getDate())}.${pad(x.getMonth() + 1)}.${x.getFullYear()}, ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
function addrList(list) {
  return (list || []).map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.name || a.address)).join(', ');
}
function fileSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
}

const PRINT_CSS = `
@page { margin: 16mm 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #111; }
body { font: 10.5pt/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.thread + .thread { break-before: page; }
.thread-subject { font-size: 15pt; font-weight: 700; margin: 0 0 4mm; line-height: 1.25; }
.msg { break-inside: auto; }
.msg + .msg { margin-top: 7mm; padding-top: 5mm; border-top: 1px solid #bbb; }
.meta { border-collapse: collapse; margin: 0 0 4mm; font-size: 9.5pt; break-inside: avoid; width: 100%; }
.meta th { text-align: left; font-weight: 600; color: #555; padding: 0.6mm 4mm 0.6mm 0; white-space: nowrap; vertical-align: top; width: 1%; }
.meta td { padding: 0.6mm 0; word-break: break-word; }
.meta .subj td { font-weight: 600; }
.atts { margin: 4mm 0 0; padding: 2.5mm 3mm; border: 1px solid #ccc; border-radius: 2mm; font-size: 9pt; break-inside: avoid; }
.atts strong { display: block; margin-bottom: 1mm; }
.text { white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; font: inherit; margin: 0; }
.text .q { color: #555; }
.body-host { display: block; }
.blocked { font-size: 8.5pt; color: #777; margin: 0 0 3mm; font-style: italic; }
`;

// Grundstil innerhalb jeder HTML-Mail (im Shadow DOM, damit sich Mail-Styles nicht gegenseitig stören)
const BODY_CSS = `
:host { display: block; font-size: 10.5pt; line-height: 1.45; color: #111; overflow-wrap: anywhere; }
img { max-width: 100% !important; height: auto; }
table { max-width: 100% !important; }
pre { white-space: pre-wrap; }
blockquote { margin: 0 0 0 2mm; padding-left: 3mm; border-left: 2px solid #ccc; color: #444; }
a { color: #1a4fb4; }
`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Externe Ressourcen in einem (inerten) Fragment unschädlich machen. */
function stripRemote(fragment) {
  const remote = /^\s*(https?:)?\/\//i;
  let n = 0;
  for (const el of fragment.querySelectorAll('[src], [srcset], [background], [poster], [style]')) {
    for (const attr of ['src', 'background', 'poster']) {
      if (el.hasAttribute(attr) && remote.test(el.getAttribute(attr))) { el.removeAttribute(attr); n++; }
    }
    if (el.hasAttribute('srcset')) { el.removeAttribute('srcset'); n++; }
    const st = el.getAttribute('style');
    if (st && /url\(\s*['"]?\s*(https?:)?\/\//i.test(st)) {
      el.setAttribute('style', st.replace(/url\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, 'none'));
      n++;
    }
  }
  for (const s of fragment.querySelectorAll('style')) {
    if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(s.textContent) || /@import/i.test(s.textContent)) {
      s.textContent = s.textContent.replace(/@import[^;]+;/gi, '').replace(/url\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, 'none');
      n++;
    }
  }
  return n;
}

function textToHtml(text) {
  return String(text || '').split('\n').map((l) => {
    const s = esc(l);
    return /^\s*&gt;/.test(s) ? `<span class="q">${s}</span>` : s;
  }).join('\n');
}

async function loadAll(ids, getBody) {
  const out = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      const cached = getBody && getBody(ids[i]);
      out[i] = cached || await get(`/messages/${ids[i]}/body`, { markSeen: '0' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, worker));
  return out;
}

let activeFrame = null;

/**
 * groups: [[messageId, …], …] – jede Gruppe (Konversation) beginnt auf einer neuen Seite.
 * opts.getBody(id) → bereits geladener Inhalt (optional)
 * opts.allowRemote(payload) → externe Bilder für diese Nachricht laden?
 */
export async function printMessages(groups, { getBody, allowRemote = () => false, title } = {}) {
  groups = groups.map((g) => [...new Set(g)]).filter((g) => g.length);
  const total = groups.reduce((n, g) => n + g.length, 0);
  if (!total) return;
  if (total > MAX) { toast(`Bitte höchstens ${MAX} Nachrichten auf einmal drucken (ausgewählt: ${total}).`, 'error', 6000); return; }
  const busy = total > 3 ? toast(`Druckansicht für ${total} Nachrichten wird vorbereitet …`, 'info', 60000) : null;

  let payloads;
  try {
    payloads = await loadAll(groups.flat(), getBody);
  } catch (err) {
    if (busy && busy.remove) busy.remove();
    toast(`Drucken nicht möglich: ${err.message}`, 'error');
    return;
  }
  if (busy && busy.remove) busy.remove();

  // Nach Gruppen aufteilen, innerhalb einer Konversation chronologisch
  let k = 0;
  const threads = groups.map((g) => payloads.slice(k, (k += g.length))
    .sort((a, b) => new Date(a.date) - new Date(b.date)));

  if (activeFrame) activeFrame.remove();
  const remoteOk = payloads.map((p) => !!allowRemote(p));
  const anyRemote = remoteOk.some(Boolean);
  const csp = `default-src 'none'; style-src 'unsafe-inline'${anyRemote ? ' https: http:' : ''}; img-src data: blob:${anyRemote ? ' https: http:' : ''}; font-src data:${anyRemote ? ' https:' : ''}`;
  const docTitle = title || (threads[0][0] && threads[0][0].subject) || 'E-Mail';

  const frame = document.createElement('iframe');
  // Keine Skripte im Druckdokument; allow-modals wird für den Druckdialog benötigt
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none';
  frame.srcdoc = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>${esc(docTitle)}</title><style>${PRINT_CSS}</style></head><body></body></html>`;
  activeFrame = frame;
  await new Promise((resolve) => { frame.addEventListener('load', resolve, { once: true }); document.body.appendChild(frame); });

  const d = frame.contentDocument;
  let idx = 0;
  for (const list of threads) {
    const sec = d.createElement('section');
    sec.className = 'thread';
    const h1 = d.createElement('h1');
    h1.className = 'thread-subject';
    h1.textContent = list[0].subject || '(kein Betreff)';
    sec.appendChild(h1);
    for (const p of list) {
      const ok = remoteOk[payloads.indexOf(p)];
      const art = d.createElement('article');
      art.className = 'msg';
      const rows = [
        ['Von', addrList(p.from)],
        ['An', addrList(p.to)],
        ['Cc', addrList(p.cc)],
        ['Datum', deDateTime(p.date)],
      ];
      if (list.length > 1 && p.subject && p.subject !== list[0].subject) rows.unshift(['Betreff', p.subject]);
      art.innerHTML = `<table class="meta">${rows.filter((r) => r[1]).map(([k2, v]) => `<tr${k2 === 'Betreff' ? ' class="subj"' : ''}><th>${k2}:</th><td>${esc(v)}</td></tr>`).join('')}</table>`;

      if (p.html) {
        const tpl = d.createElement('template');
        tpl.innerHTML = p.html; // inert: nichts wird geladen oder ausgeführt
        const blocked = ok ? 0 : stripRemote(tpl.content);
        if (blocked) {
          const note = d.createElement('p');
          note.className = 'blocked';
          note.textContent = 'Externe Bilder wurden nicht geladen.';
          art.appendChild(note);
        }
        const host = d.createElement('div');
        host.className = 'body-host';
        const root = host.attachShadow({ mode: 'open' });
        const st = d.createElement('style');
        st.textContent = BODY_CSS;
        root.append(st, tpl.content);
        art.appendChild(host);
      } else {
        const pre = d.createElement('pre');
        pre.className = 'text';
        pre.innerHTML = textToHtml(p.text);
        art.appendChild(pre);
      }

      const atts = (p.attachments || []).filter((a) => !a.inline);
      if (atts.length) {
        const box = d.createElement('div');
        box.className = 'atts';
        box.innerHTML = `<strong>Anhänge (${atts.length})</strong>${atts.map((a) => `${esc(a.filename)}${a.size ? ` (${fileSize(a.size)})` : ''}`).join('<br>')}`;
        art.appendChild(box);
      }
      sec.appendChild(art);
      idx++;
    }
    d.body.appendChild(sec);
  }

  // Auf Bilder warten (auch in den Shadow Roots), höchstens IMG_TIMEOUT
  const imgs = [...d.querySelectorAll('img')];
  for (const host of d.querySelectorAll('.body-host')) imgs.push(...host.shadowRoot.querySelectorAll('img'));
  await Promise.race([
    Promise.all(imgs.filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
    new Promise((r) => setTimeout(r, IMG_TIMEOUT)),
  ]);

  // Titel bestimmt den Dateinamen beim Speichern als PDF
  const oldTitle = document.title;
  document.title = docTitle;
  const cleanup = () => {
    if (document.title === docTitle) document.title = oldTitle;
    setTimeout(() => { if (activeFrame === frame) { frame.remove(); activeFrame = null; } }, 1000);
  };
  try {
    frame.contentWindow.addEventListener('afterprint', cleanup, { once: true });
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch (err) {
    toast(`Drucken nicht möglich: ${err.message}`, 'error');
    cleanup();
    return;
  }
  // Manche Browser feuern kein afterprint – Titel spätestens nach einer Minute zurücksetzen
  setTimeout(() => { if (document.title === docTitle) document.title = oldTitle; }, 60000);
  return idx;
}
