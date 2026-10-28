'use strict';

/**
 * Komprimierung ohne Zusatzbibliothek (Node-zlib):
 *  - Oberfläche (JS, CSS, HTML, SVG …): beim Start einmal mit Brotli und gzip vorkomprimiert,
 *    dann ohne Rechenaufwand ausgeliefert
 *  - API-Antworten (JSON) ab 1 KB: gzip bzw. Brotli, asynchron (blockiert den Server nicht)
 * Liegt ein Proxy (Nginx) davor, komprimiert er bereits komprimierte Antworten nicht noch einmal.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TEXT_EXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt|map)$/i;
const MIN_BYTES = 1024;

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

/** Vorkomprimierte Fassungen aller Textdateien eines Verzeichnisses: relPath → { br, gzip } */
function precompress(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!TEXT_EXT.test(e.name)) continue;
      const raw = fs.readFileSync(p);
      if (raw.length < MIN_BYTES) continue;
      out.set('/' + path.relative(dir, p).split(path.sep).join('/'), {
        br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
        gzip: zlib.gzipSync(raw, { level: 9 }),
        size: raw.length,
      });
    }
  };
  walk(dir);
  return out;
}

/**
 * Middleware vor express.static: liefert vorkomprimierte Dateien aus.
 * cacheControl(req, res) bestimmt den Cache-Control-Header (wie bei express.static).
 */
function staticCompressed(dir, { cacheControl } = {}) {
  const files = precompress(dir);
  let saved = 0; let total = 0;
  for (const f of files.values()) { total += f.size; saved += f.size - f.br.length; }
  console.log(`[http] ${files.size} Dateien der Oberfläche vorkomprimiert (${Math.round(total / 1024)} KB → ${Math.round((total - saved) / 1024)} KB)`);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const entry = files.get(decodeURIComponent(req.path));
    const enc = entry && pickEncoding(req);
    if (!enc) return next();
    const body = entry[enc];
    res.setHeader('Content-Encoding', enc);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', body.length);
    res.type(path.extname(req.path));
    if (cacheControl) res.setHeader('Cache-Control', cacheControl(req, res));
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  };
}

/** JSON-Antworten komprimieren (für /api) */
function jsonCompression(req, res, next) {
  const enc = pickEncoding(req);
  if (!enc) return next();
  const origJson = res.json.bind(res);
  res.json = (data) => {
    if (res.headersSent || res.getHeader('Content-Encoding')) return origJson(data);
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    if (body.length < MIN_BYTES) return origJson(data);
    const done = (err, out) => {
      if (err || res.headersSent) return err ? origJson(data) : undefined;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', enc);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', out.length);
      res.end(out);
    };
    if (enc === 'br') zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }, done);
    else zlib.gzip(body, { level: 5 }, done);
    return res;
  };
  next();
}

module.exports = { staticCompressed, jsonCompression, precompress, pickEncoding };
