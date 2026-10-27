'use strict';

/** API: Filter & Abwesenheitsnotiz pro Mailkonto (ManageSieve auf dem Mailserver). */
const express = require('express');
const db = require('../db');
const { decrypt } = require('../crypto');
const { withSieve, SieveError } = require('./client');
const script = require('./script');

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

async function accountFor(req) {
  const a = await db.one(
    `SELECT a.*, d.sieve_port AS domain_sieve_port FROM mail_accounts a LEFT JOIN mail_domains d ON d.id = a.domain_id
      WHERE a.id = $1 AND a.user_id = $2`, [parseInt(req.params.id, 10) || 0, req.user.id]);
  if (!a) throw httpError(404, 'Konto nicht gefunden');
  return a;
}

function connOpts(a) {
  const port = a.domain_id ? Number(a.domain_sieve_port ?? 4190) : 4190;
  return {
    host: a.imap_host,
    port,
    user: a.imap_user,
    pass: decrypt(a.imap_pass),
    // unverschlüsselt nur, wenn auch IMAP unverschlüsselt eingerichtet ist (internes Netz)
    requireTls: a.imap_security !== 'none',
    allowInsecureTls: !!a.allow_insecure_tls,
  };
}

/** Eigene Adressen dieses Kontos (für :addresses der Abwesenheitsnotiz) */
async function accountAddresses(a) {
  const rows = await db.many('SELECT email FROM identities WHERE account_id = $1', [a.id]);
  return [...new Set([a.email, ...rows.map((r) => r.email)].map((x) => String(x || '').toLowerCase()).filter(Boolean))];
}

/** Stand auf dem Server lesen */
async function readState(c) {
  const scripts = await c.list();
  const active = scripts.find((s) => s.active) || null;
  const own = scripts.find((s) => s.name === script.SCRIPT_NAME);
  let data = null;
  if (own) data = script.parse(await c.get(own.name));
  // „anderes“ Script: das aktive, wenn es nicht unseres ist – sonst das bisher eingebundene
  let otherName = active && active.name !== script.SCRIPT_NAME ? active.name : (data && data.includeOther) || null;
  if (otherName && !scripts.some((s) => s.name === otherName)) otherName = null;
  let other = null;
  if (otherName) {
    let otherHasVacation = false;
    try { otherHasVacation = script.hasVacation(await c.get(otherName)); } catch (_) { /* egal */ }
    other = { name: otherName, active: !!(active && active.name === otherName), hasVacation: otherHasVacation };
  }
  return {
    scripts: scripts.map((s) => s.name),
    active: active ? active.name : null,
    ownActive: !!(active && active.name === script.SCRIPT_NAME),
    other,
    data: data || script.empty(),
    foreignOwn: !!own && !data, // Script „webmail“ existiert, wurde aber nicht von uns erzeugt
  };
}

function router() {
  const r = express.Router();

  r.get('/accounts/:id/sieve', wrap(async (req, res) => {
    const a = await accountFor(req);
    const opts = connOpts(a);
    const addresses = await accountAddresses(a);
    if (!opts.port) return res.json({ available: false, reason: 'Filter und Abwesenheitsnotiz sind für diese Domain ausgeschaltet.', addresses });
    try {
      const out = await withSieve(opts, async (c) => ({ ...(await readState(c)), extensions: c.extensions }));
      // Standard-Einbindung: ein bestehendes Script (z. B. SOGo) weiter ausführen
      if (out.other && !out.ownActive && out.data.includeOther === null && !out.data.rules.length && !out.data.vacation.enabled) {
        out.data.includeOther = out.other.name;
      }
      res.json({ available: true, addresses, ...out });
    } catch (err) {
      if (!(err instanceof SieveError)) throw err;
      res.json({ available: false, reason: err.message, addresses });
    }
  }));

  /** Speichern: Script erzeugen, hochladen (Server prüft die Syntax) und aktivieren bzw. deaktivieren */
  r.put('/accounts/:id/sieve', wrap(async (req, res) => {
    const a = await accountFor(req);
    const opts = connOpts(a);
    if (!opts.port) throw httpError(400, 'Filter und Abwesenheitsnotiz sind für diese Domain ausgeschaltet');
    const input = { ...req.body };
    if (input.vacation && (!Array.isArray(input.vacation.addresses) || !input.vacation.addresses.length)) {
      input.vacation = { ...input.vacation, addresses: await accountAddresses(a) };
    }
    const gen = script.generate(input);
    try {
      const state = await withSieve(opts, async (c) => {
        const before = await readState(c);
        if (before.foreignOwn) throw httpError(409, 'Auf dem Server gibt es bereits ein fremdes Sieve-Script namens „webmail“ – bitte umbenennen oder löschen');
        const needs = [];
        if (gen.data.vacation.enabled) needs.push('vacation');
        if (gen.script.includes('"date"')) needs.push('date');
        if (gen.script.includes('"include"')) needs.push('include');
        const missing = needs.filter((x) => !c.extensions.includes(x));
        if (missing.length) throw httpError(400, `Der Mailserver unterstützt ${missing.join(', ')} nicht`);
        try {
          await c.put(script.SCRIPT_NAME, gen.script);
        } catch (err) {
          if (err instanceof SieveError && err.status === 400) throw httpError(400, `Der Mailserver hat die Regeln abgelehnt: ${err.message}`);
          throw err;
        }
        if (gen.active) await c.setActive(script.SCRIPT_NAME);
        else if (before.ownActive) await c.setActive(''); // nichts mehr auszuführen
        return readState(c);
      });
      res.json({ ok: true, ...state });
    } catch (err) {
      if (err instanceof SieveError) throw httpError(502, err.message);
      throw err;
    }
  }));

  return r;
}

module.exports = { router };
