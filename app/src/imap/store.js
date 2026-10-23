'use strict';

/**
 * Speichert IMAP-Nachrichtenköpfe in PostgreSQL und ordnet sie Threads zu.
 *
 * Threading (vereinfachter JWZ-Ansatz, kontoübergreifend über alle Ordner):
 *  - Eine Nachricht gehört zu dem Thread, in dem eine ihrer References/In-Reply-To-IDs
 *    liegt, ODER zu dem Thread einer Nachricht, die SIE referenziert (Antwort kam zuerst an).
 *  - Treffen mehrere Threads aufeinander, werden sie zusammengeführt.
 */
const db = require('../db');
const {
  extractMessageIds, headerValue, normalizeMessageId, hasAttachments, addrList,
} = require('./util');

async function assignThread(t, accountId, messageId, keys) {
  const r = await t.query(
    `SELECT DISTINCT thread_id FROM messages
      WHERE account_id = $1
        AND ( message_id = ANY($2::text[])
              OR ($3::text IS NOT NULL AND (message_id = $3 OR in_reply_to = $3 OR refs @> ARRAY[$3::text])) )`,
    [accountId, keys, messageId]);
  const ids = r.rows.map((x) => Number(x.thread_id));
  if (!ids.length) {
    const n = await t.query("SELECT nextval('thread_seq') AS id");
    return Number(n.rows[0].id);
  }
  const target = Math.min(...ids);
  const others = ids.filter((i) => i !== target);
  if (others.length) {
    await t.query('UPDATE messages SET thread_id = $1 WHERE account_id = $2 AND thread_id = ANY($3::bigint[])',
      [target, accountId, others]);
  }
  return target;
}

/** Fügt per FETCH geladene imapflow-Nachrichten ein (idempotent). */
async function insertMessages(accountId, folderId, fetched) {
  if (!fetched.length) return 0;
  let inserted = 0;
  await db.tx(async (t) => {
    // Threading pro Konto serialisieren
    await t.query('SELECT pg_advisory_xact_lock(1, $1)', [accountId]);
    for (const m of fetched) {
      const env = m.envelope || {};
      const messageId = normalizeMessageId(env.messageId);
      const inReplyTo = normalizeMessageId(env.inReplyTo);
      const refs = extractMessageIds(headerValue(m.headers, 'references'));
      const keys = [...new Set([...refs, inReplyTo].filter(Boolean))].filter((k) => k !== messageId);
      const threadId = await assignThread(t, accountId, messageId, keys);
      const from = addrList(env.from)[0] || addrList(env.sender)[0] || { name: '', address: '' };
      const date = env.date instanceof Date && !isNaN(env.date) ? env.date
        : (m.internalDate instanceof Date ? m.internalDate : null);
      const r = await t.query(
        `INSERT INTO messages (account_id, folder_id, uid, message_id, in_reply_to, refs, thread_id, subject,
                               from_name, from_addr, to_list, cc_list, date, flags, size, has_attachments)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (folder_id, uid) DO UPDATE SET flags = EXCLUDED.flags
         RETURNING (xmax = 0) AS inserted`,
        [accountId, folderId, m.uid, messageId, inReplyTo, refs, threadId,
          String(env.subject || '').slice(0, 1000),
          from.name.slice(0, 300), from.address.slice(0, 300),
          JSON.stringify(addrList(env.to)), JSON.stringify(addrList(env.cc)),
          date, [...(m.flags || [])], m.size || 0, hasAttachments(m.bodyStructure)]);
      if (r.rows[0] && r.rows[0].inserted) inserted++;
    }
  });
  return inserted;
}

/** Setzt Flags vieler Nachrichten auf einmal. updates: [{uid, flags:[...]}] */
async function replaceFlags(folderId, updates) {
  if (!updates.length) return 0;
  const r = await db.query(
    `UPDATE messages m
        SET flags = ARRAY(SELECT jsonb_array_elements_text(v.f))
       FROM jsonb_to_recordset($2::jsonb) AS v(uid bigint, f jsonb)
      WHERE m.folder_id = $1 AND m.uid = v.uid
        AND m.flags IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(v.f))`,
    [folderId, JSON.stringify(updates.map((u) => ({ uid: u.uid, f: u.flags })))]);
  return r.rowCount;
}

async function changeFlagsLocal(folderId, uids, flags, add) {
  let seenDelta = 0;
  if (flags.includes('\\Seen')) {
    const c = await db.one(
      `SELECT count(*)::int AS n FROM messages
        WHERE folder_id = $1 AND uid = ANY($2::bigint[]) AND (('\\Seen' = ANY(flags)) = $3)`,
      [folderId, uids, !add]);
    seenDelta = add ? -c.n : c.n;
  }
  if (add) {
    await db.query(
      `UPDATE messages SET flags = ARRAY(SELECT DISTINCT unnest(flags || $3::text[]))
        WHERE folder_id = $1 AND uid = ANY($2::bigint[])`, [folderId, uids, flags]);
  } else {
    await db.query(
      `UPDATE messages SET flags = ARRAY(SELECT f FROM unnest(flags) f WHERE NOT (f = ANY($3::text[])))
        WHERE folder_id = $1 AND uid = ANY($2::bigint[])`, [folderId, uids, flags]);
  }
  // Unread-Zähler lokal nachziehen (wird beim nächsten Sync vom Server bestätigt)
  if (seenDelta) {
    await db.query('UPDATE folders SET unseen = GREATEST(0, unseen + $2) WHERE id = $1', [folderId, seenDelta]);
  }
}

module.exports = { insertMessages, replaceFlags, changeFlagsLocal, assignThread };
