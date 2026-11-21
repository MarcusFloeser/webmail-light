// mailto:-Links (RFC 6068) mit der Webmail öffnen:
//  - im Browser als Handler registriert (navigator.registerProtocolHandler) → /?mailto=<Link>
//  - als installierte App (Manifest „protocol_handlers“), z. B. als Standard-Mailprogramm unter Windows/macOS
const KEY = 'wm.pendingMailto';
const HANDLER = '/?mailto=%s';

/** mailto:-Link zerlegen → { to, cc, bcc, subject, body } */
export function parseMailto(url) {
  const s = String(url || '').trim().replace(/^mailto:/i, '');
  const [addr, query = ''] = s.split('?');
  const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, '%20')); } catch { return x; } };
  const out = { to: dec(addr || ''), cc: '', bcc: '', subject: '', body: '' };
  for (const part of query.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).toLowerCase();
    const v = i < 0 ? '' : dec(part.slice(i + 1));
    if (k === 'to') out.to = [out.to, v].filter(Boolean).join(', ');
    else if (k === 'cc' || k === 'bcc') out[k] = [out[k], v].filter(Boolean).join(', ');
    else if (k === 'subject' && !out.subject) out.subject = v;
    else if (k === 'body' && !out.body) out.body = v.replace(/\r\n/g, '\n');
  }
  // Mehrfach-Kommas/Leerzeichen bereinigen
  for (const k of ['to', 'cc', 'bcc']) out[k] = out[k].split(/[,;]/).map((x) => x.trim()).filter(Boolean).join(', ');
  return out;
}

/** Beim Start: ?mailto=… aus der Adresse übernehmen (und merken, falls erst angemeldet werden muss) */
export function captureFromUrl() {
  const q = new URLSearchParams(location.search);
  const v = q.get('mailto');
  if (!v) return;
  try { sessionStorage.setItem(KEY, v); } catch { /* egal */ }
  q.delete('mailto');
  const rest = q.toString();
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash || '#/mail'}`);
}

/** Nach der Anmeldung: gemerkten Link öffnen → true, wenn etwas geöffnet wurde */
export async function openPending(openCompose) {
  let v = null;
  try { v = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch { /* egal */ }
  if (!v || !/^mailto:/i.test(v)) return false;
  await openCompose(parseMailto(v));
  return true;
}

export function canRegister() {
  return typeof navigator !== 'undefined' && typeof navigator.registerProtocolHandler === 'function' && window.isSecureContext;
}

/** Webmail als Handler für mailto:-Links in diesem Browser anmelden (der Browser fragt nach) */
export function register() {
  navigator.registerProtocolHandler('mailto', `${location.origin}${HANDLER}`);
}

/** Läuft die Webmail als installierte App? */
export function isInstalledApp() {
  try { return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches; } catch { return false; }
}
