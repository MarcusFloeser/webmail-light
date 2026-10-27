'use strict';

/** Versand über SMTP (pro Konto), Ablage in "Gesendet", Entwürfe. */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const db = require('../db');
const manager = require('../imap/manager');
const { decrypt } = require('../crypto');
const { smtpConnectOptions, friendlyError } = require('../tls');
const { htmlToText } = require('../imap/util');
const message = require('./message');

function smtpTransport(acc) {
  return nodemailer.createTransport({
    host: acc.smtp_host,
    ...smtpConnectOptions(acc.smtp_port, acc.smtp_security, acc.allow_insecure_tls),
    auth: {
      user: acc.smtp_user || acc.imap_user,
      pass: acc.smtp_pass ? decrypt(acc.smtp_pass) : decrypt(acc.imap_pass),
    },
    connectionTimeout: 30000,
    greetingTimeout: 20000,
  });
}

async function testSmtp(acc) {
  const t = smtpTransport(acc);
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err, { kind: 'smtp', port: acc.smtp_port, security: acc.smtp_security }) };
  } finally {
    t.close();
  }
}

async function findSpecialFolder(accountId, use) {
  return db.one('SELECT * FROM folders WHERE account_id = $1 AND special_use = $2 AND selectable ORDER BY id LIMIT 1', [accountId, use]);
}

async function loadIdentity(identityId, userId) {
  const row = await db.one(
    `SELECT i.id AS identity_id, i.name AS identity_name, i.email AS identity_email, i.reply_to, i.bcc AS identity_bcc,
            a.*
       FROM identities i JOIN mail_accounts a ON a.id = i.account_id
      WHERE i.id = $1 AND a.user_id = $2`, [identityId, userId]);
  if (!row) {
    const err = new Error('Absender-Identität nicht gefunden');
    err.status = 400;
    throw err;
  }
  return row;
}

function listOrUndefined(v) {
  const s = Array.isArray(v) ? v.join(', ') : String(v || '').trim();
  return s ? s : undefined;
}

/** Baut das nodemailer-Mail-Objekt aus dem Request-Body. */
async function buildMail(body, user, ident) {
  const domain = String(ident.identity_email).split('@')[1] || 'localhost';
  const mail = {
    from: { name: ident.identity_name || '', address: ident.identity_email },
    to: listOrUndefined(body.to),
    cc: listOrUndefined(body.cc),
    bcc: listOrUndefined([body.bcc, ident.identity_bcc].filter(Boolean).join(', ')),
    replyTo: ident.reply_to || undefined,
    subject: String(body.subject || ''),
    html: body.html || undefined,
    text: body.text || (body.html ? htmlToText(body.html) : ''),
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    date: new Date(),
    attachments: [],
    headers: { 'User-Agent': 'Webmail' },
  };

  // Eingebettete Bilder (z. B. Logo in der Signatur) als CID-Anhänge versenden –
  // data:-URLs zeigen viele Mailprogramme (u. a. Gmail) nicht an
  if (mail.html) {
    let n = 0;
    mail.html = mail.html.replace(
      /(<img\b[^>]*?\ssrc\s*=\s*)(["'])data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)\2/gi,
      (m0, pre, q, type, b64) => {
        n++;
        const cid = `img${n}.${crypto.randomUUID()}@${domain}`;
        const ext = type.split('/')[1].replace('jpeg', 'jpg');
        mail.attachments.push({
          cid, filename: `bild-${n}.${ext}`, contentType: type, contentDisposition: 'inline',
          content: Buffer.from(b64.replace(/\s+/g, ''), 'base64'),
        });
        return `${pre}${q}cid:${cid}${q}`;
      });
  }

  for (const a of body.attachments || []) {
    if (!a || !a.data) continue;
    mail.attachments.push({
      filename: String(a.filename || 'anhang'),
      contentType: a.contentType || 'application/octet-stream',
      content: Buffer.from(String(a.data), 'base64'),
    });
  }

  let original = null;
  if (body.inReplyTo) {
    original = await message.getOwned(parseInt(body.inReplyTo, 10), user.id);
    if (original.message_id) {
      mail.inReplyTo = original.message_id;
      mail.references = [...(original.refs || []), original.message_id].slice(-30).join(' ');
    }
  }

  if (body.forwardAttachmentsFrom) {
    const src = await message.getOwned(parseInt(body.forwardAttachmentsFrom, 10), user.id);
    const parsed = await message.loadParsed(src);
    const wanted = Array.isArray(body.forwardAttachmentIdx) ? new Set(body.forwardAttachmentIdx.map(Number)) : null;
    (parsed.attachments || []).forEach((a, idx) => {
      if (a.related) return;
      if (wanted && !wanted.has(idx)) return;
      mail.attachments.push({ filename: a.filename || `anhang-${idx + 1}`, contentType: a.contentType, content: a.content });
    });
  }
  if (body.forwardAsAttachment) {
    const src = await message.getOwned(parseInt(body.forwardAsAttachment, 10), user.id);
    const parsed = await message.loadParsed(src);
    mail.attachments.push({ filename: `${(src.subject || 'nachricht').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.eml`, contentType: 'message/rfc822', content: parsed.__source });
  }
  return { mail, original };
}

async function buildRaw(mail, keepBcc) {
  const compiled = new MailComposer(mail).compile();
  if (keepBcc) compiled.keepBcc = true;
  return compiled.build();
}

/** Löscht einen früheren Entwurf anhand seiner Message-ID. */
async function removeDraft(accountId, draftMessageId) {
  if (!draftMessageId) return;
  const drafts = await findSpecialFolder(accountId, '\\Drafts');
  if (!drafts) return;
  const worker = manager.get(accountId);
  try {
    const uids = await worker.withMailbox(drafts.path, (c) => c.search({ header: { 'message-id': draftMessageId } }, { uid: true }));
    if (uids && uids.length) {
      await worker.expunge(drafts.path, uids);
      await db.query('DELETE FROM messages WHERE folder_id = $1 AND uid = ANY($2::bigint[])', [drafts.id, uids]);
    }
  } catch (err) {
    console.log('[compose] Entwurf konnte nicht entfernt werden:', err.message);
  }
}

/**
 * Liefert true, wenn die Antwort im Ordner der Originalnachricht statt in
 * "Gesendet" abgelegt werden soll.
 *   replyFolder = 'original'      (Standard) – im Ordner der Originalnachricht
 *               = 'original_noinbox'          – ebenso, ausser Original liegt im Posteingang
 *               = 'sent'                      – immer "Gesendet"
 */
function replyFolderFor(user, body, original) {
  if (!original || !['reply', 'replyAll'].includes(body.mode)) return false;
  const mode = (user.settings && user.settings.replyFolder) || 'original';
  if (mode === 'sent') return false;
  const special = original.folder_special;
  if (['\\Sent', '\\Trash', '\\Junk', '\\Drafts', '\\All', '\\Flagged'].includes(special)) return false;
  if (mode === 'original_noinbox' && special === '\\Inbox') return false;
  return true;
}

async function send(body, user) {
  const ident = await loadIdentity(body.identityId, user.id);
  const { mail, original } = await buildMail(body, user, ident);
  if (!mail.to && !mail.cc && !mail.bcc) {
    const err = new Error('Bitte mindestens einen Empfänger angeben');
    err.status = 400;
    throw err;
  }
  const transport = smtpTransport(ident);
  try {
    await transport.sendMail({ ...mail, envelope: undefined });
  } catch (err) {
    const e = new Error(`Versand fehlgeschlagen: ${friendlyError(err, { kind: 'smtp', port: ident.smtp_port, security: ident.smtp_security })}`);
    e.status = 502;
    throw e;
  } finally {
    transport.close();
  }

  const worker = manager.get(ident.id);
  const warnings = [];

  // Antworten im Ordner der beantworteten Nachricht ablegen (Einstellung "replyFolder")
  const replyTarget = replyFolderFor(user, body, original);
  let filedIn = null;
  if (replyTarget) {
    filedIn = original.folder_special === '\\Inbox' ? 'Posteingang' : (original.folder_name || original.folder_path);
    try {
      const raw = await buildRaw(mail, true);
      await manager.get(original.account_id).append(original.folder_path, raw, ['\\Seen']);
    } catch (err) {
      warnings.push(`Ablage im Ordner "${original.folder_name || original.folder_path}" fehlgeschlagen: ${err.message}`);
    }
  } else if (ident.save_sent) {
    const sent = await findSpecialFolder(ident.id, '\\Sent');
    if (sent) {
      try {
        const raw = await buildRaw(mail, true);
        await worker.append(sent.path, raw, ['\\Seen']);
      } catch (err) {
        warnings.push(`Kopie in "Gesendet" fehlgeschlagen: ${err.message}`);
      }
    } else {
      warnings.push('Kein "Gesendet"-Ordner gefunden – keine Kopie abgelegt');
    }
  }
  if (original) {
    const flag = body.mode === 'forward' ? '$Forwarded' : '\\Answered';
    manager.get(original.account_id).setFlags(original.folder_path, [original.uid], [flag], true).catch(() => {});
  }
  if (body.draftMessageId) await removeDraft(ident.id, body.draftMessageId);
  return { ok: true, messageId: mail.messageId, warnings, filedIn };
}

async function saveDraft(body, user) {
  const ident = await loadIdentity(body.identityId, user.id);
  const { mail } = await buildMail(body, user, ident);
  const drafts = await findSpecialFolder(ident.id, '\\Drafts');
  if (!drafts) {
    const err = new Error('Kein Entwürfe-Ordner gefunden');
    err.status = 400;
    throw err;
  }
  const raw = await buildRaw(mail, true);
  const worker = manager.get(ident.id);
  await worker.append(drafts.path, raw, ['\\Draft', '\\Seen']);
  if (body.draftMessageId) await removeDraft(ident.id, body.draftMessageId);
  return { ok: true, draftMessageId: mail.messageId };
}

/**
 * Kalender-Nachricht (iMIP: Einladung, Absage, Antwort) über das SMTP-Konto einer Identität senden.
 * ident: Zeile aus loadIdentity; opts: { to: [{ email, name }], subject, text, method, ics }
 */
async function sendItip(ident, { to, subject, text, html, method, ics }) {
  const list = (to || []).filter((r) => r && r.email);
  if (!list.length) return { ok: true, sent: 0 };
  const domain = String(ident.identity_email).split('@')[1] || 'localhost';
  const transport = smtpTransport(ident);
  try {
    await transport.sendMail({
      from: { name: ident.identity_name || '', address: ident.identity_email },
      to: list.map((r) => (r.name ? { name: r.name, address: r.email } : r.email)),
      subject,
      text,
      html,
      messageId: `<${crypto.randomUUID()}@${domain}>`,
      date: new Date(),
      headers: { 'User-Agent': 'Webmail' },
      icalEvent: { method, content: ics, filename: 'invite.ics' },
    });
  } catch (err) {
    const e = new Error(`Versand fehlgeschlagen: ${friendlyError(err, { kind: 'smtp', port: ident.smtp_port, security: ident.smtp_security })}`);
    e.status = 502;
    throw e;
  } finally {
    transport.close();
  }
  return { ok: true, sent: list.length };
}

module.exports = { sendItip, loadIdentity, send, saveDraft, testSmtp, findSpecialFolder, removeDraft, replyFolderFor, buildMail };
