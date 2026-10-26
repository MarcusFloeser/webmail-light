'use strict';
// Versionierte Auslieferung der Oberfläche: alle Dateien liegen zusätzlich unter /v/<kennung>/…
// Die Kennung ist ein Hash über den Inhalt von public/ – sie ändert sich mit jedem Update.
// So laden Browser (auch auf dem Handy) nach einem Update garantiert die neuen Dateien,
// während unveränderte Dateien dauerhaft aus dem Cache kommen.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, '..', 'public');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(p);
  }
  return out;
}

function buildId(dir = PUBLIC) {
  const h = crypto.createHash('sha1');
  for (const f of walk(dir)) {
    h.update(path.relative(dir, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 12);
}

/** index.html mit versionierten Pfaden für Stylesheet und Skript. */
function versionedIndex(id, dir = PUBLIC) {
  return fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    .replace(/(href|src)="\/(app\.css|js\/main\.js)"/g, `$1="/v/${id}/$2"`);
}

module.exports = { buildId, versionedIndex, PUBLIC };
