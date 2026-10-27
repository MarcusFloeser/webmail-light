'use strict';

/**
 * Minimaler ManageSieve-Client (RFC 5804) – für Filter und Abwesenheitsnotiz auf dem Mailserver
 * (Dovecot/Pigeonhole, z. B. mailcow: Port 4190, STARTTLS).
 */
const net = require('net');
const tls = require('tls');

class SieveError extends Error {
  constructor(message, { status = 502, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Sieve/ManageSieve-String: "…" mit \\ und \" escaped */
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

class ManageSieve {
  /**
   * opts: { host, port, user, pass, requireTls (Standard true), allowInsecureTls, timeout }
   */
  constructor(opts) {
    this.opts = { port: 4190, requireTls: true, timeout: 15000, ...opts };
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.capabilities = {};
    this.closed = false;
  }

  // ------------------------------------------------------------------ Transport

  _attach(sock) {
    this.sock = sock;
    sock.setTimeout(this.opts.timeout);
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
    sock.on('timeout', () => this._fail(new SieveError('Zeitüberschreitung beim Sieve-Server')));
    sock.on('error', (err) => this._fail(err));
    sock.on('close', () => { this.closed = true; this._fail(new SieveError('Verbindung zum Sieve-Server getrennt')); });
  }

  _fail(err) {
    const w = this.waiters.splice(0);
    for (const x of w) x.reject(err);
  }

  /** Nächste vollständige Antwort lesen: Zeilen bis OK/NO/BYE (Literale {n} werden mitgelesen). */
  _pump() {
    while (this.waiters.length) {
      const res = this._tryParse();
      if (!res) return;
      this.waiters.shift().resolve(res);
    }
  }

  _tryParse() {
    const lines = [];
    let pos = 0;
    const buf = this.buf;
    for (;;) {
      const nl = buf.indexOf('\r\n', pos);
      if (nl < 0) return null;
      let line = buf.subarray(pos, nl).toString('utf8');
      pos = nl + 2;
      // Literal am Zeilenende: {123} oder {123+}
      let m;
      while ((m = line.match(/\{(\d+)\+?\}$/))) {
        const n = parseInt(m[1], 10);
        if (buf.length < pos + n) return null;
        const lit = buf.subarray(pos, pos + n).toString('utf8');
        pos += n;
        const nl2 = buf.indexOf('\r\n', pos);
        if (nl2 < 0) return null;
        const rest = buf.subarray(pos, nl2).toString('utf8');
        pos = nl2 + 2;
        line = `${line.slice(0, m.index)}${JSON.stringify(lit)}${rest}`;
        m = null;
        if (!/\{(\d+)\+?\}$/.test(rest)) break;
      }
      lines.push(line);
      const status = line.match(/^(OK|NO|BYE)\b\s*(?:\(([^)]*)\))?\s*(.*)$/i);
      if (status) {
        this.buf = buf.subarray(pos);
        return { status: status[1].toUpperCase(), code: status[2] || null, text: unquote(status[3] || ''), lines: lines.slice(0, -1) };
      }
    }
  }

  _read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._pump();
    });
  }

  async _cmd(line, literal) {
    if (this.closed) throw new SieveError('Verbindung zum Sieve-Server getrennt');
    if (literal !== undefined) {
      const body = Buffer.from(literal, 'utf8');
      this.sock.write(`${line} {${body.length}+}\r\n`);
      this.sock.write(body);
      this.sock.write('\r\n');
    } else this.sock.write(`${line}\r\n`);
    return this._read();
  }

  async _ok(line, literal) {
    const r = await this._cmd(line, literal);
    if (r.status !== 'OK') throw new SieveError(r.text || `${line.split(' ')[0]} fehlgeschlagen`, { status: 400, code: r.code });
    return r;
  }

  _parseCaps(lines) {
    const caps = {};
    for (const l of lines) {
      const m = l.match(/^"([^"]+)"(?:\s+"(.*)")?$/);
      if (m) caps[m[1].toUpperCase()] = m[2] !== undefined ? m[2] : true;
    }
    this.capabilities = caps;
    return caps;
  }

  get extensions() {
    return String(this.capabilities.SIEVE || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  // ------------------------------------------------------------------ Ablauf

  async connect() {
    const { host, port, timeout } = this.opts;
    await new Promise((resolve, reject) => {
      const s = net.connect({ host, port, timeout });
      const onErr = (err) => reject(friendly(err, this.opts));
      s.once('error', onErr);
      s.once('timeout', () => { s.destroy(); reject(new SieveError(`Sieve-Server ${host}:${port} antwortet nicht (Port/Firewall prüfen)`)); });
      s.once('connect', () => { s.removeListener('error', onErr); this._attach(s); resolve(); });
    });
    const hello = await this._read();
    if (hello.status !== 'OK') throw new SieveError(`Sieve-Server meldet: ${hello.text}`);
    this._parseCaps(hello.lines);
    if (this.capabilities.STARTTLS) {
      await this._ok('STARTTLS');
      await this._upgrade();
      const again = await this._read();
      if (again.status === 'OK' && again.lines.length) this._parseCaps(again.lines);
      else {
        // manche Server senden die Fähigkeiten erst auf CAPABILITY
        const c = await this._ok('CAPABILITY');
        this._parseCaps(c.lines);
      }
    } else if (this.opts.requireTls) {
      throw new SieveError('Der Sieve-Server bietet keine Verschlüsselung (STARTTLS) an – Anmeldung abgebrochen');
    }
  }

  _upgrade() {
    return new Promise((resolve, reject) => {
      const plain = this.sock;
      plain.removeAllListeners('data');
      plain.removeAllListeners('close');
      plain.removeAllListeners('error');
      plain.removeAllListeners('timeout');
      const { host, allowInsecureTls } = this.opts;
      const t = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !allowInsecureTls }, () => {
        this.buf = Buffer.alloc(0);
        this._attach(t);
        resolve();
      });
      t.once('error', (err) => {
        this.closed = true;
        try { t.destroy(); plain.destroy(); } catch (_) { /* egal */ }
        reject(friendly(err, this.opts));
      });
    });
  }

  async login(user, pass) {
    const mechs = String(this.capabilities.SASL || '').toUpperCase().split(/\s+/);
    if (mechs.length && mechs[0] && !mechs.includes('PLAIN')) throw new SieveError(`Sieve-Server unterstützt keine PLAIN-Anmeldung (${mechs.join(', ')})`);
    const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
    const r = await this._cmd(`AUTHENTICATE "PLAIN" ${q(token)}`);
    if (r.status !== 'OK') throw new SieveError('Anmeldung am Sieve-Server fehlgeschlagen', { status: 502, code: r.code });
  }

  /** → [{ name, active }] */
  async list() {
    const r = await this._ok('LISTSCRIPTS');
    return r.lines.map((l) => {
      const m = l.match(/^"((?:[^"\\]|\\.)*)"(\s+ACTIVE)?/i);
      return m ? { name: unquote(`"${m[1]}"`), active: !!m[2] } : null;
    }).filter(Boolean);
  }

  async get(name) {
    const r = await this._ok(`GETSCRIPT ${q(name)}`);
    const first = r.lines[0] || '""';
    return unquote(first);
  }

  async put(name, script) { await this._ok(`PUTSCRIPT ${q(name)}`, script); }

  async check(script) {
    const r = await this._cmd('CHECKSCRIPT', script);
    return r.status === 'OK' ? null : (r.text || 'Script fehlerhaft');
  }

  async setActive(name) { await this._ok(`SETACTIVE ${q(name || '')}`); }

  async remove(name) { await this._ok(`DELETESCRIPT ${q(name)}`); }

  async logout() {
    if (this.sock && !this.closed) {
      // höchstens 2 s auf die Antwort warten
      await Promise.race([this._cmd('LOGOUT').catch(() => {}), new Promise((r) => setTimeout(r, 2000).unref())]);
    }
    this.closed = true;
    try { if (this.sock) this.sock.destroy(); } catch (_) { /* egal */ }
  }
}

function unquote(s) {
  const t = String(s).trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t); } catch (_) { return t.slice(1, -1).replace(/\\(.)/g, '$1'); }
  }
  return t;
}

function friendly(err, { host, port }) {
  if (err instanceof SieveError) return err;
  const code = err.code || '';
  if (code === 'ECONNREFUSED') return new SieveError(`Sieve-Server ${host}:${port} nicht erreichbar (Verbindung abgelehnt)`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new SieveError(`Sieve-Server ${host} nicht gefunden (DNS)`);
  if (/certificate|self.signed|CERT_/i.test(err.message) || /CERT/.test(code)) return new SieveError(`Zertifikat des Sieve-Servers nicht vertrauenswürdig (${code || err.message})`);
  return new SieveError(`Sieve-Server: ${err.message}`);
}

/** Verbinden + anmelden; fn(client) ausführen; immer abmelden. */
async function withSieve(opts, fn) {
  const c = new ManageSieve(opts);
  try {
    await c.connect();
    await c.login(opts.user, opts.pass);
    return await fn(c);
  } finally {
    await c.logout();
  }
}

module.exports = { ManageSieve, SieveError, withSieve, quote: q };
