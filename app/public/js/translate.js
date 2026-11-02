// Mails übersetzen: über den Server (DeepL oder LibreTranslate) oder – falls dort nichts eingerichtet ist –
// mit dem eingebauten Übersetzer des Browsers (Chrome/Edge, läuft auf dem Gerät).
// Übersetzt werden Textabschnitte; Bilder, Links und Formatierung bleiben im Browser erhalten.
import { get, post } from './api.js';

const TARGET_KEY = 'wm.translateTarget';
const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV',
  'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'svg', 'SVG', 'MATH', 'CODE', 'KBD', 'SAMP', 'TEXTAREA', 'SELECT']);
const BLOCK_SEL = [...BLOCK].map((t) => t.toLowerCase()).join(',');
const DROP = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'STYLE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'FRAME', 'FRAMESET']);
const LETTER = /\p{L}/u;
const ONLY_URL = /^\s*(https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.-]+)\s*$/i;

export const languageName = (code) => {
  try { return new Intl.DisplayNames(['de'], { type: 'language' }).of(code) || code; } catch { return code; }
};

export function defaultTarget() {
  try { const v = localStorage.getItem(TARGET_KEY); if (v) return v; } catch { /* egal */ }
  const nav = String(navigator.language || 'de').toLowerCase().split('-')[0];
  return /^[a-z]{2}$/.test(nav) ? nav : 'de';
}
export function rememberTarget(code) {
  try { localStorage.setItem(TARGET_KEY, code); } catch { /* egal */ }
}

// ------------------------------------------------------------------ Was steht zur Verfügung?
let infoPromise = null;
let infoAt = 0;
export function translateInfo() {
  if (!infoPromise || (Date.now() - infoAt > 30000 && infoPromise.__noServer)) {
    infoAt = Date.now();
    infoPromise = get('/translate/info').catch(() => ({ server: false, languages: [] })).then((r) => {
      const out = { ...r, browser: browserCapable() };
      infoPromise.__noServer = !r.server;
      return out;
    });
  }
  return infoPromise;
}
const BROKEN_KEY = 'wm.browserTranslateBroken';
/** Hat der Browser einen nutzbaren eingebauten Übersetzer? Brave bietet die Schnittstelle an, liefert aber keine Sprachmodelle. */
export function browserCapable() {
  if (typeof self === 'undefined' || !('Translator' in self) || !('LanguageDetector' in self)) return false;
  if (typeof navigator !== 'undefined' && navigator.brave) return false;
  try { if (localStorage.getItem(BROKEN_KEY)) return false; } catch { /* egal */ }
  return true;
}
function markBrowserBroken() {
  try { localStorage.setItem(BROKEN_KEY, '1'); } catch { /* egal */ }
  infoPromise = null;
}
const BROWSER_HINT = 'Der Browser kann hier nicht selbst übersetzen – bitte den Administrator bitten, DeepL oder LibreTranslate einzurichten.';

// ------------------------------------------------------------------ Abschnitte bilden
/** HTML: zusammenhängende Inline-Inhalte je Block → [[Knoten, …], …] */
export function htmlRuns(root) {
  const runs = [];
  const visit = (el) => {
    let run = [];
    const flush = () => {
      if (run.length) {
        const text = run.map((n) => n.textContent).join('');
        if (LETTER.test(text) && !ONLY_URL.test(text)) runs.push(run);
      }
      run = [];
    };
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3) { run.push(n); continue; }
      if (n.nodeType !== 1) continue;
      if (SKIP.has(n.tagName)) { flush(); continue; }
      if (BLOCK.has(n.tagName) || n.querySelector(BLOCK_SEL)) { flush(); visit(n); continue; }
      run.push(n);
    }
    flush();
  };
  visit(root);
  return runs;
}

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Abschnitt als HTML ohne Attribute (Elemente nummeriert, um sie danach wiederherzustellen) */
function runToHtml(run, map) {
  return run.map((n) => {
    if (n.nodeType === 3) return escHtml(n.data);
    const clone = n.cloneNode(true);
    const origs = [n, ...n.querySelectorAll('*')];
    const clones = [clone, ...clone.querySelectorAll('*')];
    clones.forEach((c, i) => {
      for (const a of [...c.attributes]) c.removeAttribute(a.name);
      c.setAttribute('data-k', String(map.push(origs[i]) - 1));
      if (SKIP.has(c.tagName)) c.replaceChildren(); // Inhalt (z. B. Code) nicht mitschicken
    });
    return clone.outerHTML;
  }).join('');
}

/** Übersetztes HTML eines Abschnitts einsetzen */
function applyRun(run, html, map) {
  const doc = run[0].ownerDocument;
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  for (const el of [...tpl.content.querySelectorAll('*')]) {
    const k = el.getAttribute('data-k');
    const orig = k != null ? map[Number(k)] : null;
    if (orig) {
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      for (const a of orig.attributes) el.setAttribute(a.name, a.value);
      if (SKIP.has(orig.tagName)) el.replaceChildren(...[...orig.childNodes].map((c) => c.cloneNode(true)));
    } else if (DROP.has(el.tagName)) {
      el.remove();
    } else {
      for (const a of [...el.attributes]) if (/^on/i.test(a.name) || /^(src|href|style)$/i.test(a.name)) el.removeAttribute(a.name);
    }
  }
  const text = run.map((n) => n.textContent).join('');
  const lead = (text.match(/^\s+/) || [''])[0];
  const trail = (text.match(/\s+$/) || [''])[0];
  const parent = run[0].parentNode;
  if (!parent) return;
  const frag = doc.createDocumentFragment();
  if (lead && !/^\s/.test(tpl.content.textContent)) frag.append(doc.createTextNode(lead));
  frag.append(tpl.content);
  if (trail && !/\s$/.test(frag.textContent)) frag.append(doc.createTextNode(trail));
  parent.insertBefore(frag, run[0]);
  for (const n of run) n.remove();
}

/** Text-Mail: Absätze mit gleichem Zitat-Präfix → [{ pre, lines } | { blank }] */
export function textGroups(text) {
  const groups = [];
  let cur = null;
  for (const l of String(text || '').split('\n')) {
    const pre = (l.match(/^\s*(?:>\s?)+/) || [''])[0];
    const body = l.slice(pre.length);
    if (!body.trim() || /^-- ?$/.test(body)) { groups.push({ raw: l }); cur = null; continue; }
    if (cur && cur.pre === pre) cur.lines.push(body);
    else { cur = { pre, lines: [body] }; groups.push(cur); }
  }
  return groups;
}
function groupsToText(groups, translated) {
  let j = 0;
  return groups.map((g) => {
    if (g.raw != null) return g.raw;
    const t = translated && g.translate ? translated[j++] : g.lines.join('\n');
    return String(t).split('\n').map((x) => g.pre + x).join('\n');
  }).join('\n');
}

// ------------------------------------------------------------------ Übersetzen
async function viaServer(segments, target) {
  const r = await post('/translate', { segments, target });
  return { out: r.segments, detected: r.detected, provider: r.provider };
}

async function viaBrowser(segments, target, onProgress) {
  const sample = segments.map((s) => (s.t != null ? s.t : s.plain)).join('\n').slice(0, 2000);
  const det = await self.LanguageDetector.create();
  const found = (await det.detect(sample))[0];
  const source = found && found.detectedLanguage && found.detectedLanguage !== 'und' ? found.detectedLanguage.split('-')[0] : null;
  if (!source) throw new Error('Sprache der Nachricht nicht erkannt');
  if (source === target) return { out: null, detected: source, provider: 'browser' };
  const avail = await self.Translator.availability({ sourceLanguage: source, targetLanguage: target });
  if (avail === 'unavailable') throw new Error(`Der Browser kann nicht von ${languageName(source)} nach ${languageName(target)} übersetzen`);
  const tr = await self.Translator.create({
    sourceLanguage: source, targetLanguage: target,
    monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress && onProgress(`Sprachpaket wird geladen … ${Math.round((e.loaded || 0) * 100)} %`)); },
  });
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.t != null) out.push(await tr.translate(s.t));
    else out.push(await Promise.all(s.texts.map((x) => (LETTER.test(x) ? tr.translate(x) : x))));
    if (onProgress && i % 10 === 9) onProgress(`Übersetze … ${Math.round(((i + 1) / segments.length) * 100)} %`);
  }
  return { out, detected: source, provider: 'browser' };
}

/**
 * Nachricht übersetzen.
 *  target: Zielsprache (z. B. 'de'); subject: Betreff (wird mit übersetzt)
 *  html: { doc } – Dokument des Mail-iframes (wird direkt verändert) | text: Mailtext
 * → { detected, provider, subject, text? (für Text-Mails), same: true wenn schon in der Zielsprache }
 */
export async function translateContent({ target, subject, doc, text, onProgress }) {
  const info = await translateInfo();
  const useServer = info.server;
  if (!useServer && !info.browser) throw new Error('Kein Übersetzungsdienst verfügbar');
  const segments = [];
  const apply = [];
  if (subject && LETTER.test(subject)) {
    segments.push({ t: subject });
    apply.push((v) => { subjectOut = v; });
  }
  let subjectOut = null;
  let textOut = null;
  let finish = null;
  if (doc) {
    const runs = htmlRuns(doc.body);
    const map = [];
    for (const run of runs) {
      if (useServer) {
        segments.push({ h: runToHtml(run, map) });
        apply.push((v) => applyRun(run, v, map));
      } else {
        // Browser: Textknoten einzeln (Formatierung und Links bleiben unverändert)
        const nodes = [];
        const walk = (n) => { if (n.nodeType === 3) nodes.push(n); else if (n.nodeType === 1 && !SKIP.has(n.tagName)) n.childNodes.forEach(walk); };
        run.forEach(walk);
        segments.push({ texts: nodes.map((n) => n.data), plain: run.map((n) => n.textContent).join('') });
        apply.push((v) => nodes.forEach((n, i) => {
          const lead = (n.data.match(/^\s+/) || [''])[0];
          const trail = (n.data.match(/\s+$/) || [''])[0];
          n.data = lead + String(v[i]).trim() + trail;
        }));
      }
    }
  } else {
    const groups = textGroups(text);
    const collected = [];
    for (const g of groups) {
      if (g.raw != null) continue;
      const joined = g.lines.join('\n');
      g.translate = LETTER.test(joined) && !ONLY_URL.test(joined);
      if (g.translate) { segments.push({ t: joined }); apply.push((v) => collected.push(v)); }
    }
    finish = () => { textOut = groupsToText(groups, collected); };
  }
  if (!segments.length) return { detected: null, provider: useServer ? info.provider : 'browser', same: true };
  let r;
  if (useServer) r = await viaServer(segments, target);
  else {
    try {
      r = await viaBrowser(segments, target, onProgress);
    } catch (err) {
      // z. B. „Model not available“: Schnittstelle vorhanden, aber keine Sprachmodelle → künftig nicht mehr anbieten
      if (/model|not available|not supported|NotSupported|NotAllowed|unknown/i.test(`${err.name} ${err.message}`)) {
        markBrowserBroken();
        throw new Error(BROWSER_HINT);
      }
      throw err;
    }
  }
  if (!r.out) return { detected: r.detected, provider: r.provider, same: true };
  if (r.detected && r.detected === target) return { detected: r.detected, provider: r.provider, same: true };
  r.out.forEach((v, i) => apply[i](v));
  if (finish) finish();
  return { detected: r.detected, provider: r.provider, subject: subjectOut, text: textOut };
}
