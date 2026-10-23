import { h, clear, icon, iconButton, toast, confirmDialog, fileSize, formatAddress, debounce, fileToBase64, fullDate, esc } from './ui.js';
import { get, post, del } from './api.js';
import { state, allIdentities, defaultIdentity, identityForMessage, findFolder } from './state.js';

let panel = null;
let cur = null; // aktueller Entwurfszustand

// ====================================================================== Hilfen

function prefix(subject, p) {
  const s = String(subject || '');
  const re = p === 'Re' ? /^\s*(re|aw|antw)\s*:/i : /^\s*(fwd?|wg)\s*:/i;
  return re.test(s) ? s : `${p}: ${s}`;
}

function addrString(list) {
  return (list || []).filter((a) => a && a.address).map(formatAddress).join(', ');
}

function myAddresses() {
  return new Set(allIdentities().map((i) => i.email.toLowerCase()));
}

/** Macht fremdes HTML für das Zitat im Editor unschädlich. */
function cleanQuotedHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style, link, meta, iframe, object, embed, base, title, head').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      if (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:')) img.replaceWith(doc.createTextNode(img.getAttribute('alt') || ''));
  });
  return doc.body.innerHTML;
}

function textToHtml(text) {
  return esc(text || '').replace(/\n/g, '<br>');
}

function signatureHtml(identity) {
  if (!identity || !identity.signature) return '';
  const sig = /<[a-z][\s\S]*>/i.test(identity.signature) ? identity.signature : textToHtml(identity.signature);
  return `<div class="wm-signature">-- <br>${sig}</div>`;
}

// ====================================================================== Öffnen

export async function openCompose(opts = {}) {
  if (!allIdentities().length) {
    toast('Bitte zuerst ein E-Mail-Konto einrichten', 'error');
    location.hash = '#/settings/accounts/new';
    return;
  }
  if (panel && cur && cur.dirty) {
    if (!(await confirmDialog('Entwurf verwerfen?', 'Die aktuelle Nachricht wurde noch nicht gesendet. Verwerfen und neu beginnen?', { confirmLabel: 'Verwerfen' }))) {
      panel.classList.remove('minimized');
      return;
    }
  }
  const { mode, message: m, body: p } = opts;
  let accountId = opts.accountId;
  if (!accountId) {
    const hash = location.hash.match(/^#\/mail\/(\d+)/);
    const f = hash && findFolder(hash[1]);
    if (f) accountId = f.account.id;
  }

  const draft = {
    identityId: null, to: opts.to || '', cc: '', bcc: '', subject: opts.subject || '', html: '',
    attachments: [], forwardAtts: [], forwardFrom: null, forwardAsAttachment: null,
    inReplyTo: null, mode: mode || 'new', draftMessageId: null, dirty: false,
  };

  let identity = defaultIdentity(accountId);
  let quote = '';

  if (m && p && (mode === 'reply' || mode === 'replyAll')) {
    identity = identityForMessage(m.accountId, [...(p.to || []), ...(p.cc || [])]);
    const mine = myAddresses();
    const fromIsMe = p.from[0] && mine.has(String(p.from[0].address).toLowerCase());
    const primary = fromIsMe ? p.to : (p.replyTo && p.replyTo.length ? p.replyTo : p.from);
    draft.to = addrString(primary);
    if (mode === 'replyAll') {
      const seen = new Set([...mine, ...primary.map((a) => String(a.address).toLowerCase())]);
      const rest = [...(fromIsMe ? [] : p.to || []), ...(p.cc || [])].filter((a) => {
        const k = String(a.address).toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      draft.cc = addrString(rest);
    }
    draft.subject = prefix(p.subject, 'Re');
    draft.inReplyTo = m.id;
    const who = p.from[0] ? (p.from[0].name || p.from[0].address) : '';
    quote = `<br><div class="wm-quote-head">Am ${esc(fullDate(p.date))} schrieb ${esc(who)}:</div>`
      + `<blockquote type="cite">${p.html ? cleanQuotedHtml(p.html) : textToHtml(p.text)}</blockquote>`;
  } else if (m && p && mode === 'forward') {
    identity = identityForMessage(m.accountId, [...(p.to || []), ...(p.cc || [])]);
    draft.subject = prefix(p.subject, 'Fwd');
    draft.inReplyTo = m.id;
    draft.forwardFrom = m.id;
    draft.forwardAtts = (p.attachments || []).filter((a) => !a.inline).map((a) => ({ ...a, include: true }));
    quote = '<br><div class="wm-fwd-head">---------- Weitergeleitete Nachricht ----------<br>'
      + `Von: ${esc(addrString(p.from))}<br>Datum: ${esc(fullDate(p.date))}<br>Betreff: ${esc(p.subject || '')}<br>`
      + `An: ${esc(addrString(p.to))}${p.cc && p.cc.length ? `<br>Cc: ${esc(addrString(p.cc))}` : ''}</div><br>`
      + (p.html ? cleanQuotedHtml(p.html) : textToHtml(p.text));
  } else if (m && mode === 'forwardAttachment') {
    draft.subject = prefix(m.subject, 'Fwd');
    draft.forwardAsAttachment = m.id;
  } else if (m && p && mode === 'draft') {
    const fromAddr = p.from[0] ? String(p.from[0].address).toLowerCase() : '';
    identity = allIdentities().find((i) => i.email.toLowerCase() === fromAddr && i.accountId === m.accountId) || identity;
    draft.to = addrString(p.to);
    draft.cc = addrString(p.cc);
    draft.bcc = addrString(p.bcc);
    draft.subject = p.subject || '';
    draft.html = p.html ? cleanQuotedHtml(p.html) : textToHtml(p.text);
    draft.draftMessageId = p.messageId;
    // Anhänge des Entwurfs übernehmen
    for (const a of p.attachments || []) {
      try {
        const blob = await (await fetch(`/api/messages/${m.id}/attachments/${a.idx}`)).blob();
        draft.attachments.push({ filename: a.filename, contentType: a.contentType, size: blob.size, data: await fileToBase64(blob) });
      } catch { /* ignore */ }
    }
  }
  draft.identityId = identity.id;
  if (mode !== 'draft') {
    const sig = signatureHtml(identity);
    draft.html = (mode === 'reply' || mode === 'replyAll' || mode === 'forward')
      ? `<div><br></div>${sig}${quote}` : `<div><br></div>${sig}`;
  }
  cur = draft;
  renderPanel();
}

export function closeCompose(force) {
  if (!panel) return;
  if (force) { panel.remove(); panel = null; cur = null; clearInterval(autosaveTimer); return; }
  panel.classList.add('closing');
  setTimeout(() => { if (panel) panel.remove(); panel = null; cur = null; }, 150);
  clearInterval(autosaveTimer);
}

// ====================================================================== Empfängerfeld mit Autovervollständigung

function recipientInput(name, value, placeholder) {
  const input = h('input', { type: 'text', name, value, placeholder, autocomplete: 'off', spellcheck: 'false', class: 'rcpt-input' });
  const list = h('ul', { class: 'suggest', role: 'listbox', hidden: true });
  let items = [];
  let active = -1;

  const segment = () => {
    const v = input.value;
    const pos = input.selectionStart ?? v.length;
    const start = v.lastIndexOf(',', pos - 1) + 1;
    return { start, text: v.slice(start, pos).trim() };
  };
  const choose = (item) => {
    const v = input.value;
    const { start } = segment();
    const end = (() => { const i = v.indexOf(',', start); return i < 0 ? v.length : i + 1; })();
    const before = v.slice(0, start).replace(/\s*$/, start ? ' ' : '');
    const after = v.slice(end).replace(/^\s*/, '');
    input.value = `${before}${formatAddress(item)}, ${after}`;
    list.hidden = true;
    input.dispatchEvent(new Event('input'));
    input.focus();
  };
  const renderList = () => {
    clear(list, items.map((it, i) => h('li', {
      class: i === active ? 'on' : '', role: 'option',
      onMousedown: (e) => { e.preventDefault(); choose(it); },
    }, it.contact ? icon('user', 14) : null, h('strong', {}, it.name || it.address), it.name ? h('span', {}, it.address) : null)));
    list.hidden = !items.length;
  };
  const search = debounce(async () => {
    const { text } = segment();
    if (text.length < 2) { items = []; renderList(); return; }
    try {
      const r = await get('/addresses', { q: text });
      items = r.results;
      active = items.length ? 0 : -1;
      renderList();
    } catch { /* ignore */ }
  }, 200);
  input.addEventListener('input', () => { if (cur) cur.dirty = true; search(); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderList(); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && items[active]) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') { list.hidden = true; e.stopPropagation(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  return h('div', { class: 'rcpt' }, input, list);
}

// ====================================================================== Panel

let autosaveTimer = null;

function renderPanel() {
  if (panel) panel.remove();
  const d = cur;

  // Absender (gruppiert nach Konto)
  const fromSel = h('select', { name: 'identity', class: 'from-select' }, state.accounts.map((a) => h('optgroup', { label: a.name },
    a.identities.map((i) => h('option', { value: String(i.id), selected: i.id === d.identityId },
      i.name ? `${i.name} <${i.email}>` : i.email)))));
  fromSel.addEventListener('change', () => {
    const ident = allIdentities().find((i) => i.id === Number(fromSel.value));
    d.identityId = ident.id;
    // Signatur austauschen
    const sigEl = editor.querySelector('.wm-signature');
    const html = signatureHtml(ident);
    if (sigEl) {
      if (html) sigEl.outerHTML = html; else sigEl.remove();
    } else if (html) {
      const firstQuote = editor.querySelector('.wm-quote-head, .wm-fwd-head');
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      if (firstQuote) editor.insertBefore(tmp.firstChild, firstQuote); else editor.appendChild(tmp.firstChild);
    }
    d.dirty = true;
  });

  const toIn = recipientInput('to', d.to, 'Empfänger');
  const ccIn = recipientInput('cc', d.cc, 'Cc');
  const bccIn = recipientInput('bcc', d.bcc, 'Bcc');
  const ccRow = h('div', { class: 'c-row', hidden: !d.cc }, h('label', {}, 'Cc'), ccIn);
  const bccRow = h('div', { class: 'c-row', hidden: !d.bcc }, h('label', {}, 'Bcc'), bccIn);
  const subject = h('input', { type: 'text', name: 'subject', value: d.subject, placeholder: 'Betreff', class: 'subject-input', onInput: () => { d.dirty = true; title.textContent = subject.value || 'Neue Nachricht'; } });

  const editor = h('div', { class: 'editor', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Nachricht', html: d.html });
  editor.addEventListener('input', () => { d.dirty = true; });
  editor.addEventListener('paste', (e) => {
    // Beim Einfügen von fremdem HTML Formatierung bereinigen
    const htmlData = e.clipboardData.getData('text/html');
    if (htmlData) {
      e.preventDefault();
      document.execCommand('insertHTML', false, cleanQuotedHtml(htmlData));
    }
  });

  const cmd = (c, v) => () => { editor.focus(); document.execCommand(c, false, v); d.dirty = true; };
  const toolbar = h('div', { class: 'fmt-bar' },
    iconButton('bold', 'Fett (Strg+B)', cmd('bold')),
    iconButton('italic', 'Kursiv (Strg+I)', cmd('italic')),
    iconButton('underline', 'Unterstrichen (Strg+U)', cmd('underline')),
    iconButton('list', 'Aufzählung', cmd('insertUnorderedList')),
    iconButton('quote', 'Zitat', cmd('formatBlock', 'blockquote')),
    iconButton('link', 'Link einfügen', () => {
      const url = prompt('Link-Adresse (https://…)');
      if (url && /^(https?:|mailto:)/i.test(url)) cmd('createLink', url)();
    }),
    h('button', { class: 'icon-btn txt', type: 'button', title: 'Formatierung entfernen', onClick: cmd('removeFormat') }, 'Tx'));

  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const attList = h('div', { class: 'c-atts' });
  const renderAtts = () => {
    clear(attList,
      d.forwardAtts.map((a) => h('label', { class: `att ${a.include ? '' : 'off'}` },
        h('input', { type: 'checkbox', checked: a.include, onChange: (e) => { a.include = e.target.checked; renderAtts(); } }),
        h('span', { class: 'att-name' }, a.filename), h('span', { class: 'att-size' }, fileSize(a.size)))),
      d.forwardAsAttachment ? h('span', { class: 'att' }, icon('mail', 14), h('span', { class: 'att-name' }, 'Originalnachricht (.eml)')) : null,
      d.attachments.map((a, i) => h('span', { class: 'att' },
        icon('clip', 14), h('span', { class: 'att-name' }, a.filename), h('span', { class: 'att-size' }, fileSize(a.size)),
        h('button', { type: 'button', class: 'att-x', title: 'Entfernen', onClick: () => { d.attachments.splice(i, 1); d.dirty = true; renderAtts(); } }, '×'))));
  };
  const addFiles = async (files) => {
    let total = d.attachments.reduce((s, a) => s + a.size, 0);
    for (const f of files) {
      total += f.size;
      if (total > 25 * 1024 * 1024) { toast('Anhänge insgesamt größer als 25 MB', 'error'); break; }
      d.attachments.push({ filename: f.name, contentType: f.type || 'application/octet-stream', size: f.size, data: await fileToBase64(f) });
    }
    d.dirty = true;
    renderAtts();
  };
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  renderAtts();

  const collect = () => ({
    identityId: Number(fromSel.value),
    to: toIn.querySelector('input').value,
    cc: ccIn.querySelector('input').value,
    bcc: bccIn.querySelector('input').value,
    subject: subject.value,
    html: editor.innerHTML,
    attachments: d.attachments.map(({ filename, contentType, data }) => ({ filename, contentType, data })),
    inReplyTo: d.inReplyTo || undefined,
    mode: d.mode,
    forwardAttachmentsFrom: d.forwardFrom && d.forwardAtts.some((a) => a.include) ? d.forwardFrom : undefined,
    forwardAttachmentIdx: d.forwardFrom ? d.forwardAtts.filter((a) => a.include).map((a) => a.idx) : undefined,
    forwardAsAttachment: d.forwardAsAttachment || undefined,
    draftMessageId: d.draftMessageId || undefined,
  });

  const sendBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('send', 16), 'Senden');
  const send = async () => {
    const data = collect();
    if (!data.to.trim() && !data.cc.trim() && !data.bcc.trim()) { toast('Bitte einen Empfänger angeben', 'error'); return; }
    if (!data.subject.trim() && !(await confirmDialog('Ohne Betreff senden?', 'Die Nachricht hat keinen Betreff.', { danger: false, confirmLabel: 'Trotzdem senden' }))) return;
    sendBtn.disabled = true;
    sendBtn.lastChild.textContent = 'Sende…';
    try {
      const r = await post('/send', data);
      toast(r.filedIn ? `Nachricht gesendet – abgelegt in „${r.filedIn}“` : 'Nachricht gesendet', 'success');
      for (const w of r.warnings || []) toast(w, 'warn', 7000);
      closeCompose(true);
    } catch (err) {
      toast(err.message, 'error', 7000);
      sendBtn.disabled = false;
      sendBtn.lastChild.textContent = 'Senden';
    }
  };
  sendBtn.addEventListener('click', send);

  const saveDraft = async (silent) => {
    try {
      const r = await post('/drafts', collect());
      d.draftMessageId = r.draftMessageId;
      d.dirty = false;
      status.textContent = `Entwurf gespeichert ${new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}`;
      if (!silent) toast('Entwurf gespeichert');
    } catch (err) {
      if (!silent) toast(err.message, 'error');
    }
  };

  const discard = async () => {
    if (d.dirty || d.draftMessageId) {
      if (!(await confirmDialog('Verwerfen?', 'Diese Nachricht verwerfen?', { confirmLabel: 'Verwerfen' }))) return;
    }
    if (d.draftMessageId) del('/drafts', { identityId: fromSel.value, draftMessageId: d.draftMessageId }).catch(() => {});
    closeCompose(true);
  };

  const status = h('span', { class: 'c-status' });
  const title = h('span', { class: 'c-title' }, d.subject || 'Neue Nachricht');

  panel = h('div', { class: 'compose open', role: 'dialog', 'aria-label': 'Nachricht verfassen' },
    h('div', { class: 'c-head', onDblclick: () => panel.classList.toggle('minimized') },
      title,
      h('div', { class: 'c-head-btns' },
        iconButton('chevronDown', 'Minimieren', () => panel.classList.toggle('minimized'), { class: 'tiny' }),
        iconButton('all', 'Maximieren', () => panel.classList.toggle('max'), { class: 'tiny hide-mobile' }),
        iconButton('close', 'Schließen (als Entwurf behalten)', async () => {
          if (d.dirty) await saveDraft(true);
          closeCompose();
        }, { class: 'tiny' }))),
    h('div', { class: 'c-body' },
      h('div', { class: 'c-row' }, h('label', {}, 'Von'), fromSel),
      h('div', { class: 'c-row' }, h('label', {}, 'An'), toIn,
        h('div', { class: 'c-row-btns' },
          h('button', { class: 'link-btn', type: 'button', onClick: (e) => { ccRow.hidden = false; e.target.remove(); ccIn.querySelector('input').focus(); } }, 'Cc'),
          h('button', { class: 'link-btn', type: 'button', onClick: (e) => { bccRow.hidden = false; e.target.remove(); bccIn.querySelector('input').focus(); } }, 'Bcc'))),
      ccRow, bccRow,
      h('div', { class: 'c-row' }, subject),
      toolbar,
      editor,
      attList),
    h('div', {
      class: 'c-foot',
    },
    sendBtn,
    iconButton('clip', 'Datei anhängen', () => fileInput.click()),
    fileInput,
    h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => saveDraft(false) }, 'Entwurf speichern'),
    status,
    h('span', { class: 'grow' }),
    iconButton('trash', 'Verwerfen', discard)));

  // Drag & Drop von Dateien
  panel.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); panel.classList.add('dropping'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('dropping'); });
  panel.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    panel.classList.remove('dropping');
    addFiles([...e.dataTransfer.files]);
  });
  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    if (e.key === 'Escape' && !e.target.closest('.rcpt')) panel.classList.add('minimized');
  });

  document.getElementById('compose-root').appendChild(panel);
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => {
    if (cur === d && d.dirty && (toIn.querySelector('input').value || subject.value || editor.textContent.trim().length > 20)) saveDraft(true);
  }, 60000);

  setTimeout(() => {
    if (!d.to) toIn.querySelector('input').focus();
    else {
      editor.focus();
      const r = document.createRange();
      r.setStart(editor.firstChild && editor.firstChild.nodeType === 1 ? editor.firstChild : editor, 0);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }, 50);
}
