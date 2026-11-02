'use strict';

/**
 * Einzelne Mails als PDF-Datei: Das Druckdokument entsteht wie beim Drucken im Browser,
 * die Umwandlung in PDF übernimmt ein Gotenberg-Container (Chromium) im internen Netz.
 * Gotenberg hat keinen Internetzugang und lädt nur die übergebene Datei (Allow-List), Skripte sind aus.
 */
const express = require('express');
const config = require('./config');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const MAX_PARALLEL = 3;
const TIMEOUT_MS = 60000;
// A4, Ränder wie beim Drucken (16 mm oben/unten, 14 mm links/rechts)
const PAGE = { paperWidth: '8.27', paperHeight: '11.69', marginTop: '0.63', marginBottom: '0.63', marginLeft: '0.55', marginRight: '0.55' };
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

let running = 0;
const queue = [];
async function slot(fn) {
  if (running >= MAX_PARALLEL) await new Promise((r) => queue.push(r));
  running++;
  try { return await fn(); } finally {
    running--;
    const next = queue.shift();
    if (next) next();
  }
}

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** Zusätzliche Absicherung: strenge CSP gleich zu Beginn des Dokuments (nur eingebettete Bilder/Styles) */
function harden(html) {
  if (!/<head[^>]*>/i.test(html)) throw httpError(400, 'Ungültiges Druckdokument');
  return html.replace(/<head[^>]*>/i, (m) => `${m}<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
}

async function convert(html, url = config.pdfServiceUrl) {
  if (!url) throw httpError(501, 'Kein PDF-Dienst eingerichtet (PDF_SERVICE_URL)');
  return slot(async () => {
    const fd = new FormData();
    fd.append('files', new Blob([harden(html)], { type: 'text/html' }), 'index.html');
    for (const [k, v] of Object.entries(PAGE)) fd.append(k, v);
    fd.append('printBackground', 'true');
    fd.append('preferCssPageSize', 'false');
    let res;
    try {
      res = await fetch(`${url.replace(/\/+$/, '')}/forms/chromium/convert/html`, { method: 'POST', body: fd, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw httpError(502, `PDF-Dienst nicht erreichbar (${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message})`);
    }
    if (!res.ok) {
      const txt = (await res.text().catch(() => '')).slice(0, 200);
      throw httpError(502, `PDF-Dienst meldet Fehler ${res.status}${txt ? `: ${txt}` : ''}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(502, 'PDF-Dienst lieferte kein PDF');
    return buf;
  });
}

/**
 * Ist der PDF-Dienst eingerichtet und erreichbar? (Gotenberg: GET /health)
 * → { pdf: bool, reason: 'ok' | 'off' | 'unreachable', detail }
 * Ergebnis kurz zwischengespeichert (erreichbar 60 s, nicht erreichbar 15 s).
 */
let cached = null;
async function status(url = config.pdfServiceUrl, { fresh = false } = {}) {
  if (!url) return { pdf: false, reason: 'off', detail: 'PDF_SERVICE_URL=off' };
  if (!fresh && cached && cached.url === url && Date.now() < cached.until) return cached.value;
  let value;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    value = res.ok ? { pdf: true, reason: 'ok', detail: url }
      : { pdf: false, reason: 'unreachable', detail: `${url} antwortet mit HTTP ${res.status}` };
  } catch (err) {
    const cause = (err.cause && (err.cause.code || err.cause.message)) || err.name || err.message;
    value = { pdf: false, reason: 'unreachable', detail: `${url} nicht erreichbar (${cause})` };
  }
  cached = { url, value, until: Date.now() + (value.pdf ? 60000 : 15000) };
  return value;
}

function router() {
  const r = express.Router();
  r.get('/print/info', wrap(async (req, res) => {
    const st = await status();
    // Technische Einzelheiten nur für Administratoren
    res.json(req.user && req.user.is_admin ? st : { pdf: st.pdf, reason: st.reason });
  }));
  r.post('/print/pdf', wrap(async (req, res) => {
    const html = req.body && req.body.html;
    if (typeof html !== 'string' || !html.length) throw httpError(400, 'Druckdokument fehlt');
    const pdf = await convert(html);
    res.set('Content-Type', 'application/pdf');
    res.set('Cache-Control', 'no-store');
    res.send(pdf);
  }));
  return r;
}

module.exports = { router, convert, harden, status };
