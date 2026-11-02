'use strict';

/**
 * Mails übersetzen. Anbieter (der erste passende):
 *  - DeepL, wenn DEEPL_API_KEY gesetzt ist (Inhalte gehen an DeepL)
 *  - LibreTranslate (eigener Container „webmail-translate“ oder TRANSLATE_URL), läuft lokal
 * Ohne Server-Anbieter übersetzt der Browser selbst, sofern er das kann (Chrome/Edge, auf dem Gerät).
 *
 * Der Client schickt nur Textabschnitte: HTML-Abschnitte enthalten ausschliesslich Inline-Markup ohne
 * Attribute (Bilder, Links usw. bleiben im Browser), Text-Abschnitte reinen Text.
 */
const crypto = require('crypto');
const express = require('express');
const config = require('./config');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const MAX_SEGMENTS = 2000;
const DEEPL_BATCH = 50;
const DEEPL_BATCH_BYTES = 100 * 1024;
const LT_PARALLEL = 4;
const TIMEOUT_MS = 60000;

// Häufige Sprachen (Basis-Codes) – Zielsprachen-Liste, falls der Anbieter keine liefert
const COMMON = ['de', 'en', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'cs', 'sv', 'da', 'fi', 'hu', 'ro', 'tr', 'el', 'uk', 'ru', 'ja', 'zh', 'ko', 'ar'];

// ------------------------------------------------------------------ Zwischenspeicher (spart Kontingent beim erneuten Öffnen)
const CACHE_MAX = 5000;
const cache = new Map();
function cacheKey(provider, target, kind, text) {
  return crypto.createHash('sha1').update(`${provider}\0${target}\0${kind}\0${text}`).digest('base64');
}
function cacheGet(k) {
  const v = cache.get(k);
  if (v !== undefined) { cache.delete(k); cache.set(k, v); }
  return v;
}
function cachePut(k, v) {
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ------------------------------------------------------------------ Anbieter
function deeplBase() {
  // Schlüssel der kostenlosen Stufe enden auf „:fx“
  if (config.deeplApiUrl) return config.deeplApiUrl;
  return /:fx$/.test(config.deeplApiKey) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}
function deeplTarget(code) {
  const c = String(code).toLowerCase();
  if (c === 'en') return 'EN-GB';
  if (c === 'pt') return 'PT-PT';
  if (c === 'zh') return 'ZH-HANS';
  return c.toUpperCase();
}
async function deeplFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${deeplBase()}${path}`, {
      ...opts,
      // Content-Type nur mit Inhalt – bei GET mit „application/json“ verlangt DeepL sonst einen Body (Fehler 400)
      headers: { Authorization: `DeepL-Auth-Key ${config.deeplApiKey}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const why = (err.cause && (err.cause.code || err.cause.message)) || err.name;
    console.warn(`[translate] DeepL nicht erreichbar: ${why}`);
    throw httpError(502, `DeepL nicht erreichbar (${why}) – hat der Container „app“ Internetzugang?`);
  }
  if (res.ok) return res.json();
  let detail = '';
  try { const t = await res.text(); try { detail = JSON.parse(t).message || t; } catch { detail = t; } } catch { /* egal */ }
  detail = String(detail || '').replace(/\s+/g, ' ').slice(0, 200);
  console.warn(`[translate] DeepL ${path.split('?')[0]} → HTTP ${res.status} ${detail}`);
  if (res.status === 456) throw httpError(429, 'Das DeepL-Kontingent ist aufgebraucht');
  if (res.status === 403) throw httpError(502, `DeepL lehnt den API-Schlüssel ab – DEEPL_API_KEY prüfen${/:fx$/.test(config.deeplApiKey) ? '' : ' (Schlüssel der kostenlosen Stufe enden auf „:fx“)'}`);
  if (res.status === 429) throw httpError(429, 'DeepL: zu viele Anfragen – bitte gleich nochmals versuchen');
  throw httpError(502, `DeepL meldet Fehler ${res.status}${detail ? `: ${detail}` : ''}`);
}

function ltBase() { return config.translateUrl.replace(/\/+$/, ''); }
async function ltFetch(path, body) {
  let res;
  try {
    res = await fetch(`${ltBase()}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(config.translateApiKey ? { ...body, api_key: config.translateApiKey } : body) : undefined,
      signal: AbortSignal.timeout(body ? TIMEOUT_MS : 3000),
    });
  } catch (err) {
    throw httpError(502, `Übersetzungsdienst nicht erreichbar (${(err.cause && err.cause.code) || err.name})`);
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch { /* egal */ }
    throw httpError(502, `Übersetzungsdienst meldet Fehler ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return res.json();
}

/** Verfügbarer Anbieter + Zielsprachen. Kurz zwischengespeichert. */
let infoCache = null;
async function info({ fresh = false } = {}) {
  if (!fresh && infoCache && Date.now() < infoCache.until) return infoCache.value;
  let value;
  if (config.deeplApiKey) {
    try {
      const langs = await deeplFetch('/v2/languages?type=target');
      const codes = [...new Set(langs.map((l) => String(l.language).toLowerCase().split('-')[0]))];
      value = { server: true, provider: 'deepl', languages: codes };
    } catch (err) {
      value = { server: false, provider: 'deepl', error: err.message, languages: [] };
    }
  } else if (config.translateUrl) {
    try {
      const langs = await ltFetch('/languages');
      const codes = [...new Set((Array.isArray(langs) ? langs : []).map((l) => String(l.code).toLowerCase()))];
      value = { server: codes.length > 0, provider: 'libretranslate', languages: codes, error: codes.length ? undefined : 'Noch keine Sprachmodelle geladen' };
    } catch (err) {
      value = { server: false, provider: 'libretranslate', error: err.message, languages: [] };
    }
  } else {
    value = { server: false, provider: null, languages: [] };
  }
  if (!value.languages.length) value.languages = COMMON;
  infoCache = { value, until: Date.now() + (value.server ? 300000 : 15000) };
  return value;
}

async function usage() {
  if (!config.deeplApiKey) return null;
  try {
    const u = await deeplFetch('/v2/usage');
    return { used: u.character_count, limit: u.character_limit };
  } catch { return null; }
}

/** segments: [{ h: html } | { t: text }] → { segments: [string], detected } */
async function translate(segments, target) {
  const st = await info();
  if (!st.server) throw httpError(503, st.error || 'Kein Übersetzungsdienst eingerichtet');
  const tgt = String(target || 'de').toLowerCase();
  if (!/^[a-z]{2,3}$/.test(tgt)) throw httpError(400, 'Ungültige Zielsprache');
  const out = new Array(segments.length);
  const todo = [];
  segments.forEach((s, i) => {
    const kind = s.h != null ? 'h' : 't';
    const text = String(s.h != null ? s.h : s.t || '');
    if (!text.trim()) { out[i] = text; return; }
    const k = cacheKey(st.provider, tgt, kind, text);
    const hit = cacheGet(k);
    if (hit !== undefined) out[i] = hit.text;
    else todo.push({ i, kind, text, k });
  });
  const detected = new Map();
  const note = (lang) => { if (lang) detected.set(lang, (detected.get(lang) || 0) + 1); };

  if (st.provider === 'deepl') {
    for (const kind of ['h', 't']) {
      const items = todo.filter((x) => x.kind === kind);
      let batch = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        const body = { text: batch.map((x) => x.text), target_lang: deeplTarget(tgt) };
        if (kind === 'h') body.tag_handling = 'html';
        else body.preserve_formatting = true;
        const r = await deeplFetch('/v2/translate', { method: 'POST', body: JSON.stringify(body) });
        (r.translations || []).forEach((t, j) => {
          const x = batch[j];
          out[x.i] = t.text;
          const lang = String(t.detected_source_language || '').toLowerCase().split('-')[0];
          note(lang);
          cachePut(x.k, { text: t.text, lang });
        });
        batch = [];
        bytes = 0;
      };
      for (const x of items) {
        const b = Buffer.byteLength(x.text);
        if (batch.length >= DEEPL_BATCH || (bytes + b > DEEPL_BATCH_BYTES && batch.length)) await flush();
        batch.push(x);
        bytes += b;
      }
      await flush();
    }
  } else {
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const x = todo[next++];
        const r = await ltFetch('/translate', { q: x.text, source: 'auto', target: tgt, format: x.kind === 'h' ? 'html' : 'text' });
        const text = Array.isArray(r.translatedText) ? r.translatedText[0] : r.translatedText;
        out[x.i] = String(text ?? x.text);
        const lang = r.detectedLanguage && String(r.detectedLanguage.language || '').toLowerCase();
        note(lang);
        cachePut(x.k, { text: out[x.i], lang });
      }
    };
    await Promise.all(Array.from({ length: Math.min(LT_PARALLEL, todo.length) }, worker));
  }
  // Erkannte Sprache: die häufigste (aus dem Zwischenspeicher, falls nichts neu übersetzt wurde)
  if (!detected.size) {
    for (const s of segments) {
      const kind = s.h != null ? 'h' : 't';
      const hit = cache.get(cacheKey(st.provider, tgt, kind, String(s.h != null ? s.h : s.t || '')));
      if (hit) note(hit.lang);
    }
  }
  const lang = [...detected.entries()].sort((a, b) => b[1] - a[1])[0];
  return { segments: out, detected: lang ? lang[0] : null, provider: st.provider };
}

function router() {
  const r = express.Router();
  r.get('/translate/info', wrap(async (req, res) => {
    const st = await info();
    const out = { server: st.server, provider: st.server ? st.provider : null, languages: st.languages, maxChars: config.translateMaxChars };
    // Einzelheiten (Fehler, Kontingent) nur für Administratoren
    if (req.user && req.user.is_admin) {
      out.error = st.error;
      out.configured = st.provider;
      if (st.provider === 'deepl' && st.server) out.usage = await usage();
    }
    res.json(out);
  }));
  r.post('/translate', wrap(async (req, res) => {
    const segs = req.body && req.body.segments;
    if (!Array.isArray(segs) || !segs.length) throw httpError(400, 'Nichts zu übersetzen');
    if (segs.length > MAX_SEGMENTS) throw httpError(413, 'Die Nachricht ist zu lang zum Übersetzen');
    const clean = segs.map((s) => (s && typeof s.h === 'string' ? { h: s.h } : { t: String((s && s.t) || '') }));
    const chars = clean.reduce((n, s) => n + (s.h != null ? s.h : s.t).length, 0);
    if (chars > config.translateMaxChars) throw httpError(413, `Die Nachricht ist zu lang zum Übersetzen (${chars} Zeichen, höchstens ${config.translateMaxChars})`);
    res.json(await translate(clean, req.body.target));
  }));
  return r;
}

module.exports = { router, translate, info, deeplTarget, _cache: cache, _resetInfo: () => { infoCache = null; } };
