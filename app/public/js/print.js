// Nachrichten drucken bzw. über den Systemdialog als PDF speichern.
// Baut ein eigenes, schlichtes Druckdokument in einem unsichtbaren iframe (ohne Skriptrechte)
// und öffnet dafür den Druckdialog des Browsers.
import { get } from './api.js';
import { h, toast, modal } from './ui.js';

// ------------------------------------------------------------------ Was soll gedruckt werden?
export const PRINT_FIELDS = [
  ['subject', 'Betreff (Überschrift)', true],
  ['from', 'Von', true],
  ['to', 'An', true],
  ['cc', 'Cc', true],
  ['bcc', 'Bcc (nur bei eigenen Mails bekannt)', false],
  ['date', 'Datum', true],
  ['attachments', 'Liste der Anhänge', true],
  ['quotes', 'Zitierte frühere Nachrichten im Text', true],
];
const OPTS_KEY = 'wm.printFields';
export const DEFAULT_FILE_NAME = '%s';

export function loadPrintFields() {
  const def = { ...Object.fromEntries(PRINT_FIELDS.map(([k, , v]) => [k, v])), fileName: DEFAULT_FILE_NAME, underscores: false, output: 'single' };
  try { return { ...def, ...(JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') || {}) }; } catch { return def; }
}

// ------------------------------------------------------------------ Dateiname
// Der Browser übernimmt beim Speichern als PDF den Dokumenttitel als Dateinamen.
export const FILE_NAME_CODES = [
  ['%Y', 'Jahr (2026)'], ['%y', 'Jahr kurz (26)'], ['%m', 'Monat (01–12)'], ['%d', 'Tag (01–31)'],
  ['%H', 'Stunde'], ['%M', 'Minute'],
  ['%s', 'Betreff'], ['%b', 'Betreff ohne Re:/AW:/Fwd:'],
  ['%f', 'Absender (Name)'], ['%e', 'Absender (Adresse)'], ['%n', 'Anzahl Nachrichten'],
];
const REPLY_PREFIX = /^\s*((re|aw|antw|wg|fw|fwd|wtr|tr|sv|vs|rif|r)(\[\d+\])?\s*:\s*)+/i;

/** Dateiname aus Muster bilden. info = { subject, date, fromName, fromAddr, count } */
export function formatFileName(pattern, info, { underscores = false } = {}) {
  const x = new Date(info.date);
  const ok = !isNaN(x);
  const subj = String(info.subject || '').trim() || 'kein Betreff';
  const map = {
    Y: ok ? String(x.getFullYear()) : '', y: ok ? String(x.getFullYear()).slice(-2) : '',
    m: ok ? pad(x.getMonth() + 1) : '', d: ok ? pad(x.getDate()) : '',
    H: ok ? pad(x.getHours()) : '', M: ok ? pad(x.getMinutes()) : '',
    s: subj, b: subj.replace(REPLY_PREFIX, '').trim() || subj,
    f: info.fromName || info.fromAddr || '', e: info.fromAddr || '', n: String(info.count || 1),
  };
  let out = String(pattern || DEFAULT_FILE_NAME).replace(/%([%YymdHMsbfen])/g, (all, c) => (c === '%' ? '%' : map[c]));
  // In Dateinamen unzulässige Zeichen entfernen
  out = out.replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s*:\s+/g, ' ')          // „Re: Offerte“ → „Re Offerte“
    .replace(/[*?"<>|]+/g, '')
    .replace(/[\/\\:]+/g, '-')
    .replace(/\s+/g, ' ').trim();
  if (underscores) out = out.replace(/ /g, '_');
  out = out.replace(/^[.\s_-]+|[.\s]+$/g, '').replace(/\.pdf$/i, '');
  if (out.length > 150) out = out.slice(0, 150).trim();
  return out || 'E-Mail';
}

/** Kenndaten für den Dateinamen aus den geladenen Nachrichten (Betreff der Konversation, Datum der neuesten) */
function fileInfo(threads) {
  const first = threads[0][0] || {};
  const all = threads.flat();
  const newest = all.reduce((a, b) => (new Date(b.date) > new Date(a.date) ? b : a), first);
  const from = (newest.from || [])[0] || {};
  return { subject: first.subject, date: newest.date, fromName: from.name, fromAddr: from.address, count: all.length };
}

/** Dialog: Inhalte wählen, dann drucken bzw. als PDF speichern. → Promise<fields | null> */
export function printOptionsDialog(count, sample = null) {
  return new Promise((resolve) => {
    const cur = loadPrintFields();
    const boxes = PRINT_FIELDS.map(([k, label]) => {
      const cb = h('input', { type: 'checkbox', checked: !!cur[k], dataset: { k } });
      return { k, cb, el: h('label', { class: 'check' }, cb, ` ${label}`) };
    });
    const nameIn = h('input', { type: 'text', class: 'print-fname', value: cur.fileName || DEFAULT_FILE_NAME, spellcheck: false, placeholder: DEFAULT_FILE_NAME });
    const underCb = h('input', { type: 'checkbox', class: 'print-under', checked: !!cur.underscores });
    const preview = h('div', { class: 'print-fname-preview muted small' });
    const info = sample || { subject: 'Re: Offerte Projekt', date: new Date(), fromName: 'Anna Muster', fromAddr: 'anna@example.ch', count };
    const upd = () => { preview.textContent = `Beispiel: ${formatFileName(nameIn.value, info, { underscores: underCb.checked })}.pdf`; };
    nameIn.addEventListener('input', upd);
    underCb.addEventListener('change', upd);
    upd();
    const codes = h('div', { class: 'print-codes' }, FILE_NAME_CODES.map(([c, label]) =>
      h('button', { type: 'button', class: 'chip', title: label, onClick: () => {
        const a = nameIn.selectionStart ?? nameIn.value.length;
        const b = nameIn.selectionEnd ?? a;
        nameIn.value = nameIn.value.slice(0, a) + c + nameIn.value.slice(b);
        nameIn.focus();
        nameIn.setSelectionRange(a + c.length, a + c.length);
        upd();
      } }, h('code', {}, c), ` ${label}`)));
    // Ausgabe: ein gemeinsames Dokument oder jede Mail als eigene PDF-Datei
    const msgCount = (sample && sample.count) || count;
    const outSingle = h('input', { type: 'radio', name: 'print-out', value: 'single', checked: cur.output !== 'each' });
    const outEach = h('input', { type: 'radio', name: 'print-out', value: 'each', checked: cur.output === 'each' });
    const outHint = h('p', { class: 'hint print-out-hint' });
    let service = null;
    const updOut = () => {
      const each = outEach.checked;
      const btn = m && m.el.querySelector('.modal-foot .btn-primary');
      if (btn) btn.textContent = each && service && service.pdf ? (msgCount > 1 ? `${msgCount} PDFs erstellen` : 'PDF erstellen') : 'Drucken / PDF …';
      outHint.textContent = !each ? 'Alle Mails in einem Dokument; als PDF im Druckdialog „Als PDF speichern“ wählen.'
        : !service ? ''
          : service.pdf ? (msgCount > 1 ? `Es entstehen ${msgCount} PDF-Dateien, zusammen als ZIP heruntergeladen. Externe Bilder sind darin nicht enthalten.` : 'Die PDF-Datei wird direkt heruntergeladen. Externe Bilder sind darin nicht enthalten.')
            : `${service.reason === 'unreachable' ? 'PDF-Dienst nicht erreichbar' : 'Kein PDF-Dienst eingerichtet'}: Der Druckdialog öffnet sich ${msgCount > 1 ? `nacheinander für jede der ${msgCount} Mails` : 'für die Mail'} – jeweils „Als PDF speichern“ wählen.${service.detail ? ` (Admin-Info: ${service.detail}${service.reason === 'unreachable' ? ' – läuft der Container „pdf“? docker compose up -d' : ''})` : ''}`;
    };
    outSingle.addEventListener('change', updOut);
    outEach.addEventListener('change', updOut);
    pdfServiceInfo().then((r) => { service = r; updOut(); });
    let done = false;
    let m = null;
    m = modal({
      title: count > 1 ? `${count} Konversationen drucken / als PDF` : 'Drucken / als PDF speichern',
      body: h('div', { class: 'print-opts' },
        h('p', { class: 'muted small' }, 'Diese Inhalte übernehmen (der Mailtext ist immer dabei):'),
        h('div', { class: 'print-opts-grid' }, boxes.map((b) => b.el)),
        h('div', { class: 'print-out' },
          h('label', { class: 'check' }, outSingle, ' Ein Dokument'),
          h('label', { class: 'check' }, outEach, msgCount > 1 ? ` Jede Mail als eigene PDF-Datei (${msgCount})` : ' Als PDF-Datei herunterladen'),
          outHint),
        h('div', { class: 'print-fname-box' },
          h('label', { class: 'field' }, h('span', {}, 'Dateiname (PDF)'), nameIn),
          preview,
          codes,
          h('label', { class: 'check' }, underCb, ' Leerzeichen durch _ ersetzen')),
        h('p', { class: 'hint' }, 'Die Auswahl wird für das nächste Mal gemerkt.')),
      actions: [
        { label: 'Abbrechen', onClick: () => { done = true; resolve(null); } },
        { label: 'Drucken / PDF …', primary: true, onClick: () => {
          const fields = Object.fromEntries(boxes.map((b) => [b.k, b.cb.checked]));
          fields.fileName = nameIn.value.trim() || DEFAULT_FILE_NAME;
          fields.underscores = underCb.checked;
          fields.output = outEach.checked ? 'each' : 'single';
          try { localStorage.setItem(OPTS_KEY, JSON.stringify(fields)); } catch { /* egal */ }
          done = true;
          resolve(fields);
        } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    updOut();
  });
}

/** Zitierte frühere Nachrichten aus einer HTML-Mail entfernen (Gmail, Outlook, Apple Mail, Thunderbird) */
function stripQuotesHtml(fragment) {
  for (const el of fragment.querySelectorAll('blockquote, .gmail_quote, .gmail_extra, .yahoo_quoted, #divRplyFwdMsg, #appendonsend, [type="cite"], .moz-cite-prefix')) el.remove();
  // Outlook: alles ab der Trennlinie „Von: … Gesendet: …“
  const sep = [...fragment.querySelectorAll('div')].find((d) => /border-top:\s*solid/i.test(d.getAttribute('style') || '') && /^(Von|From):/i.test((d.textContent || '').trim()));
  if (sep) { let n = sep; while (n) { const next = n.nextSibling; n.remove(); n = next; } }
}

function stripQuotesText(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) continue;
    // Einleitungszeile „Am … schrieb …:“ / „On … wrote:“ direkt vor einem Zitat
    if (/^(Am|On) .+(schrieb|wrote).*:\s*$/i.test(l) && /^\s*>/.test(lines[i + 1] || '')) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

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

// ------------------------------------------------------------------ PDF-Dienst (Gotenberg) vorhanden?
let infoPromise = null;
export function pdfServiceInfo() {
  if (!infoPromise) infoPromise = get('/print/info').catch(() => ({ pdf: false })).then((r) => { if (!r || !r.pdf) infoPromise = null; return r || { pdf: false }; });
  return infoPromise;
}

/** Unsichtbaren iframe für das Druckdokument anlegen */
async function makeFrame(csp, docTitle) {
  if (activeFrame) activeFrame.remove();
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
  return frame;
}

function cspFor(remote) {
  return `default-src 'none'; style-src 'unsafe-inline'${remote ? ' https: http:' : ''}; img-src data: blob:${remote ? ' https: http:' : ''}; font-src data:${remote ? ' https:' : ''}`;
}

/** Konversationen in das Druckdokument schreiben. remoteOk(p) → externe Bilder dieser Nachricht laden? */
function renderInto(d, threads, F, remoteOk) {
  let idx = 0;
  for (const list of threads) {
    const sec = d.createElement('section');
    sec.className = 'thread';
    if (F.subject) {
      const h1 = d.createElement('h1');
      h1.className = 'thread-subject';
      h1.textContent = list[0].subject || '(kein Betreff)';
      sec.appendChild(h1);
    }
    for (const p of list) {
      const ok = remoteOk(p);
      const art = d.createElement('article');
      art.className = 'msg';
      const rows = [
        F.from ? ['Von', addrList(p.from)] : null,
        F.to ? ['An', addrList(p.to)] : null,
        F.cc ? ['Cc', addrList(p.cc)] : null,
        F.bcc ? ['Bcc', addrList(p.bcc)] : null,
        F.date ? ['Datum', deDateTime(p.date)] : null,
      ].filter(Boolean);
      if (F.subject && list.length > 1 && p.subject && p.subject !== list[0].subject) rows.unshift(['Betreff', p.subject]);
      if (rows.some((r) => r[1])) art.innerHTML = `<table class="meta">${rows.filter((r) => r[1]).map(([k2, v]) => `<tr${k2 === 'Betreff' ? ' class="subj"' : ''}><th>${k2}:</th><td>${esc(v)}</td></tr>`).join('')}</table>`;

      if (p.html) {
        const tpl = d.createElement('template');
        tpl.innerHTML = p.html; // inert: nichts wird geladen oder ausgeführt
        if (!F.quotes) stripQuotesHtml(tpl.content);
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
        pre.innerHTML = textToHtml(F.quotes ? p.text : stripQuotesText(p.text));
        art.appendChild(pre);
      }

      const atts = (p.attachments || []).filter((a) => !a.inline);
      if (F.attachments && atts.length) {
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
  return idx;
}

/** Auf Bilder warten (auch in den Shadow Roots), höchstens IMG_TIMEOUT */
async function waitImages(d) {
  const imgs = [...d.querySelectorAll('img')];
  for (const host of d.querySelectorAll('.body-host')) imgs.push(...host.shadowRoot.querySelectorAll('img'));
  await Promise.race([
    Promise.all(imgs.filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
    new Promise((r) => setTimeout(r, IMG_TIMEOUT)),
  ]);
}

/** Druckdialog für den iframe öffnen. → Promise, die nach dem Schliessen des Dialogs erfüllt wird */
function printFrame(frame, docTitle) {
  return new Promise((resolve, reject) => {
    // Titel bestimmt den Dateinamen beim Speichern als PDF
    const oldTitle = document.title;
    document.title = docTitle;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (document.title === docTitle) document.title = oldTitle;
      setTimeout(() => { if (activeFrame === frame) { frame.remove(); activeFrame = null; } }, 1000);
      resolve();
    };
    try {
      frame.contentWindow.addEventListener('afterprint', cleanup, { once: true });
      frame.contentWindow.focus();
      const t0 = Date.now();
      frame.contentWindow.print();
      // Chrome/Edge/Firefox blockieren während des Dialogs: kam print() erst nach > 1 s zurück, ist er zu
      if (Date.now() - t0 > 1000) setTimeout(cleanup, 200);
    } catch (err) {
      if (document.title === docTitle) document.title = oldTitle;
      reject(err);
      return;
    }
    // Manche Browser feuern kein afterprint – spätestens nach fünf Minuten weiter
    setTimeout(cleanup, 300000);
  });
}

/** Druckdokument mit deklarativem Shadow DOM serialisieren (für die PDF-Umwandlung auf dem Server) */
function serialize(d) {
  for (const host of d.querySelectorAll('.body-host')) {
    const tpl = d.createElement('template');
    tpl.setAttribute('shadowrootmode', 'open');
    tpl.innerHTML = host.shadowRoot.innerHTML;
    host.prepend(tpl);
  }
  return `<!doctype html>\n${d.documentElement.outerHTML}`;
}

function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const key = n.toLowerCase();
    const k = (seen.get(key) || 0) + 1;
    seen.set(key, k);
    return k > 1 ? `${n} (${k})` : n;
  });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function pdfFromServer(html) {
  let res;
  try {
    res = await fetch('/api/print/pdf', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'webmail' },
      body: JSON.stringify({ html }),
    });
  } catch { throw new Error('Server nicht erreichbar'); }
  if (!res.ok) {
    let msg = `Fehler ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* kein JSON */ }
    throw new Error(msg);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Jede Nachricht als eigene PDF-Datei: über den PDF-Dienst (eine Datei bzw. ZIP), sonst Druckdialog je Mail */
async function printEach(threads, F, remoteOk) {
  const msgs = threads.flat();
  const names = uniqueNames(msgs.map((p) => {
    const f = (p.from || [])[0] || {};
    return formatFileName(F.fileName, { subject: p.subject, date: p.date, fromName: f.name, fromAddr: f.address, count: 1 }, { underscores: F.underscores });
  }));
  const info = await pdfServiceInfo();

  if (!info.pdf) {
    // Ohne PDF-Dienst: Druckdialog nacheinander für jede Mail
    if (msgs.length > 1) toast(`Der Druckdialog öffnet sich nacheinander für jede der ${msgs.length} Mails – jeweils „Als PDF speichern“ wählen.`, 'info', 8000);
    let n = 0;
    for (let i = 0; i < msgs.length; i++) {
      const p = msgs[i];
      const frame = await makeFrame(cspFor(remoteOk(p)), names[i]);
      renderInto(frame.contentDocument, [[p]], F, remoteOk);
      await waitImages(frame.contentDocument);
      try { await printFrame(frame, names[i]); } catch (err) { toast(`Drucken nicht möglich: ${err.message}`, 'error'); return n; }
      n++;
    }
    return n;
  }

  // Mit PDF-Dienst: Dokumente bauen, auf dem Server umwandeln, herunterladen
  const busy = toast(`PDF 0 von ${msgs.length} wird erstellt …`, 'info', 600000);
  const setBusy = (t) => { if (busy) busy.textContent = t; };
  const files = [];
  try {
    const docs = [];
    for (let i = 0; i < msgs.length; i++) {
      const frame = await makeFrame(cspFor(false), names[i]);
      // Der PDF-Dienst hat keinen Internetzugang: externe Bilder immer weglassen (mit Hinweis)
      renderInto(frame.contentDocument, [[msgs[i]]], F, () => false);
      docs.push(serialize(frame.contentDocument));
      frame.remove();
      if (activeFrame === frame) activeFrame = null;
    }
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < docs.length) {
        const i = next++;
        files[i] = { name: `${names[i]}.pdf`, data: await pdfFromServer(docs[i]) };
        done++;
        setBusy(`PDF ${done} von ${msgs.length} erstellt …`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, docs.length) }, worker));
  } catch (err) {
    if (busy && busy.remove) busy.remove();
    toast(`PDF-Erstellung fehlgeschlagen: ${err.message}`, 'error', 8000);
    return 0;
  }
  if (busy && busy.remove) busy.remove();
  if (files.length === 1) download(new Blob([files[0].data], { type: 'application/octet-stream' }), files[0].name);
  else {
    const x = new Date();
    download(makeZip(files), `${files.length} E-Mails ${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}.zip`);
  }
  toast(files.length === 1 ? 'PDF erstellt' : `${files.length} PDF-Dateien als ZIP heruntergeladen`, 'success');
  return files.length;
}

/**
 * groups: [[messageId, …], …] – jede Gruppe (Konversation) beginnt auf einer neuen Seite.
 * opts.getBody(id) → bereits geladener Inhalt (optional)
 * opts.allowRemote(payload) → externe Bilder für diese Nachricht laden?
 * fields.output: 'single' = ein Dokument (Druckdialog), 'each' = jede Mail als eigene PDF-Datei
 */
export async function printMessages(groups, { getBody, allowRemote = () => false, title, fields } = {}) {
  const F = { ...loadPrintFields(), ...(fields || {}) };
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
  const okMap = new Map(payloads.map((p) => [p, !!allowRemote(p)]));
  const remoteOk = (p) => !!okMap.get(p);

  if (F.output === 'each') return printEach(threads, F, remoteOk);

  const docTitle = title || formatFileName(F.fileName, fileInfo(threads), { underscores: F.underscores });
  const frame = await makeFrame(cspFor(payloads.some(remoteOk)), docTitle);
  const idx = renderInto(frame.contentDocument, threads, F, remoteOk);
  await waitImages(frame.contentDocument);
  printFrame(frame, docTitle).catch((err) => toast(`Drucken nicht möglich: ${err.message}`, 'error'));
  return idx;
}

// ------------------------------------------------------------------ ZIP (ohne Kompression, PDFs sind bereits komprimiert)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k2 = 0; k2 < 8; k2++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** files: [{ name, data: Uint8Array }] → Blob (application/zip), Dateinamen in UTF-8 */
export function makeZip(files, now = new Date()) {
  const enc = new TextEncoder();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
