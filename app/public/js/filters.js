// Einstellungen → Filter & Abwesenheit: Sieve-Regeln und Abwesenheitsnotiz auf dem Mailserver (ManageSieve).
import { h, clear, icon, iconButton, toast, modal, confirmDialog, field, dateInput } from './ui.js';
import { get, put } from './api.js';
import { state } from './state.js';
import { sortedFolders } from './mail.js';

const FIELD_LABEL = { from: 'Absender', to: 'Empfänger (An)', cc: 'Kopie (Cc)', tocc: 'An oder Cc', subject: 'Betreff', header: 'Kopfzeile …' };
const OP_LABEL = { contains: 'enthält', not_contains: 'enthält nicht', is: 'ist genau', not_is: 'ist nicht' };
const ACTION_LABEL = { fileinto: 'In Ordner verschieben', seen: 'Als gelesen markieren', flag: 'Markieren (Stern)', redirect: 'Weiterleiten an', discard: 'Löschen (endgültig)' };

let current = null; // { account, data, server }

export async function filterSection(c, accountId) {
  const accounts = state.accounts;
  if (!accounts.length) { clear(c, h('p', { class: 'muted' }, 'Noch kein E-Mail-Konto eingerichtet.')); return; }
  const account = accounts.find((a) => a.id === Number(accountId)) || accounts[0];
  const accSel = accounts.length > 1 ? h('select', { class: 'filter-acc', 'aria-label': 'Konto',
    onChange: (e) => { location.hash = `#/settings/filters/${e.target.value}`; } },
  accounts.map((a) => h('option', { value: String(a.id), selected: a.id === account.id }, `${a.name} – ${a.email}`))) : null;
  clear(c, h('div', { class: 'section-head' }, h('h2', {}, 'Filter & Abwesenheit'), accSel),
    h('p', { class: 'muted' }, h('span', { class: 'spinner' }), ' Verbinde mit dem Mailserver …'));
  let srv;
  try { srv = await get(`/accounts/${account.id}/sieve`); } catch (err) { srv = { available: false, reason: err.message }; }
  if (!c.isConnected) return;
  if (!srv.available) {
    clear(c, h('div', { class: 'section-head' }, h('h2', {}, 'Filter & Abwesenheit'), accSel),
      h('div', { class: 'banner banner-error' }, icon('alert', 16), h('span', {}, `Filter und Abwesenheitsnotiz sind für dieses Konto nicht verfügbar: ${srv.reason}`)),
      h('p', { class: 'muted small' }, 'Die Regeln werden direkt auf dem Mailserver gespeichert (Sieve). Dafür muss der Server ManageSieve anbieten – bei mailcow ist das Port 4190.'));
    return;
  }
  current = { account, data: JSON.parse(JSON.stringify(srv.data)), server: srv };
  draw(c, accSel);
}

function draw(c, accSel) {
  const { account, data, server } = current;
  const v = data.vacation;

  // ---- Abwesenheit
  const vOn = h('input', { type: 'checkbox', checked: v.enabled, class: 'switch' });
  const vStart = dateInput(v.start || '', { label: 'Abwesend ab' });
  const vEnd = dateInput(v.end || '', { label: 'Abwesend bis' });
  const vSubject = h('input', { type: 'text', value: v.subject || 'Abwesend', maxlength: 200 });
  const vText = h('textarea', { rows: 6, placeholder: 'Guten Tag\n\nIch bin bis … nicht erreichbar. In dringenden Fällen wenden Sie sich bitte an …' }, v.text || '');
  const vDays = h('input', { type: 'number', min: 1, max: 30, value: v.days || 1, class: 'num-sm' });
  const vBody = h('div', { class: 'vac-body' },
    h('div', { class: 'row2' },
      field('Von (optional)', vStart, 'Leer = ab sofort'),
      field('Bis (optional)', vEnd, 'Leer = bis zum Ausschalten')),
    field('Betreff', vSubject),
    field('Nachricht', vText),
    h('div', { class: 'inline-field' }, h('span', {}, 'Jedem Absender höchstens alle'), vDays, h('span', {}, 'Tag(e) antworten')),
    h('p', { class: 'muted small' }, `Antwortet auf Mails an: ${(server.addresses || []).join(', ')}. Keine Antworten auf Spam, Newsletter und automatische Mails.`));
  const syncV = () => { vBody.classList.toggle('off', !vOn.checked); };
  vOn.addEventListener('change', syncV);
  syncV();
  const otherVacWarn = server.other && server.other.hasVacation
    ? h('div', { class: 'banner' }, icon('alert', 16), h('span', {}, `Das Script „${server.other.name}“ (z. B. SOGo) enthält ebenfalls eine Abwesenheitsnotiz. Bitte nur eine davon verwenden – sonst kann der Mailserver die Antwort verweigern.`))
    : null;

  // ---- Regeln
  const ruleList = h('ul', { class: 'rule-list' });
  const drawRules = () => {
    clear(ruleList, data.rules.length ? data.rules.map((r, i) => h('li', { class: `rule${r.enabled ? '' : ' off'}` },
      h('input', { type: 'checkbox', checked: r.enabled, title: 'Regel aktiv', 'aria-label': `Regel „${r.name}“ aktiv`,
        onChange: (e) => { r.enabled = e.target.checked; drawRules(); } }),
      h('div', { class: 'rule-main', onClick: () => ruleDialog(r, () => drawRules()) },
        h('strong', {}, r.name), h('span', { class: 'muted small' }, ruleSummary(r, account))),
      h('div', { class: 'row-actions' },
        iconButton('up', 'Nach oben', () => { if (i) { data.rules.splice(i - 1, 0, data.rules.splice(i, 1)[0]); drawRules(); } }, { attrs: { disabled: i === 0 } }),
        iconButton('down', 'Nach unten', () => { if (i < data.rules.length - 1) { data.rules.splice(i + 1, 0, data.rules.splice(i, 1)[0]); drawRules(); } }, { attrs: { disabled: i === data.rules.length - 1 } }),
        iconButton('edit', 'Bearbeiten', () => ruleDialog(r, () => drawRules())),
        iconButton('trash', 'Löschen', async () => {
          if (!(await confirmDialog('Regel löschen', `„${r.name}“ löschen?`, { confirmLabel: 'Löschen' }))) return;
          data.rules.splice(i, 1); drawRules();
        }))))
      : h('li', { class: 'muted rule-empty' }, 'Noch keine Regeln. Regeln werden der Reihe nach auf jede eingehende Mail angewendet.'));
  };
  drawRules();

  const incl = server.other ? h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!data.includeOther, onChange: (e) => { data.includeOther = e.target.checked ? server.other.name : null; } }),
    ` Bestehende Filter aus „${server.other.name}“ (z. B. SOGo) weiter ausführen`) : null;

  const save = async (btn) => {
    if (vOn.checked && !vText.value.trim()) { toast('Bitte einen Text für die Abwesenheitsnotiz eingeben', 'error'); vText.focus(); return; }
    if (!vStart.isValid() || !vEnd.isValid()) { toast('Bitte ein gültiges Datum angeben (TT.MM.JJJJ)', 'error'); return; }
    data.vacation = {
      enabled: vOn.checked, start: vStart.value, end: vEnd.value, subject: vSubject.value.trim(),
      text: vText.value, days: Number(vDays.value) || 1, addresses: [],
    };
    btn.disabled = true;
    try {
      const r = await put(`/accounts/${account.id}/sieve`, data);
      current.server = { ...current.server, ...r };
      current.data = JSON.parse(JSON.stringify(r.data));
      const parts = [];
      if (r.data.vacation.enabled) parts.push('Abwesenheitsnotiz aktiv');
      const n = r.data.rules.filter((x) => x.enabled).length;
      if (n) parts.push(`${n} Regel${n === 1 ? '' : 'n'} aktiv`);
      toast(parts.length ? `Gespeichert – ${parts.join(', ')}` : 'Gespeichert – keine Filter aktiv', 'success');
      drawStatus();
    } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
  };
  const status = h('div', { class: 'sieve-status small' });
  const drawStatus = () => {
    const s = current.server;
    clear(status, s.ownActive
      ? h('span', { class: 'ok-text' }, '● Auf dem Mailserver aktiv')
      : h('span', { class: 'muted' }, s.active ? `Aktiv auf dem Server: „${s.active}“ (nicht von der Webmail)` : 'Derzeit keine Filter auf dem Server aktiv'));
  };
  drawStatus();

  clear(c,
    h('div', { class: 'section-head' }, h('h2', {}, 'Filter & Abwesenheit'), accSel),
    h('p', { class: 'muted small' }, 'Wird direkt auf dem Mailserver gespeichert und wirkt auch, wenn die Webmail geschlossen ist – auch für Mails, die aufs Handy kommen.'),
    status,
    h('section', { class: 'card-sec' },
      h('label', { class: 'sec-toggle' }, vOn, h('span', {}, h('strong', {}, 'Abwesenheitsnotiz'), h('small', { class: 'muted' }, 'Automatische Antwort, z. B. während der Ferien'))),
      otherVacWarn, vBody),
    h('section', { class: 'card-sec' },
      h('div', { class: 'section-head' }, h('h3', {}, 'Filterregeln'),
        h('button', { class: 'btn', type: 'button', onClick: () => ruleDialog(null, (r) => { data.rules.push(r); drawRules(); }) }, icon('plus', 16), 'Regel hinzufügen')),
      ruleList, incl),
    h('div', { class: 'form-actions sticky-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onClick: (e) => save(e.currentTarget) }, 'Speichern')));
}

function folderName(account, path) {
  const f = account.folders.find((x) => x.path === path);
  if (!f) return path;
  const it = sortedFolders(account.folders).find((x) => x.f === f);
  return it ? it.parts.join(' / ') : f.name;
}

function ruleSummary(r, account) {
  const all = !r.conditions.length || r.conditions.every((c) => /^\*+$/.test(String(c.value).trim()) && !/^not_/.test(c.op));
  const cond = !all
    ? r.conditions.map((c) => `${c.field === 'header' ? c.header : FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} „${c.value}“`).join(r.match === 'any' ? ' oder ' : ' und ')
    : 'alle Nachrichten';
  const act = r.actions.map((a) => {
    if (a.type === 'fileinto') return `→ ${folderName(account, a.folder)}`;
    if (a.type === 'redirect') return `weiterleiten an ${a.address}${a.copy ? ' (Kopie behalten)' : ''}`;
    return ACTION_LABEL[a.type].toLowerCase();
  }).join(', ');
  return `Wenn ${cond}: ${act || '–'}`;
}

function ruleDialog(rule, done) {
  const { account } = current;
  const r = rule ? JSON.parse(JSON.stringify(rule)) : {
    id: `r${Date.now().toString(36)}`, name: '', enabled: true, match: 'all',
    conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'fileinto', folder: '' }], stop: true,
  };
  const name = h('input', { type: 'text', value: r.name, placeholder: 'z. B. Newsletter', maxlength: 100 });
  const always = !!rule && !rule.conditions.length;
  const match = h('select', { 'aria-label': 'Bedingungen' },
    h('option', { value: 'all', selected: !always && r.match !== 'any' }, 'alle Bedingungen zutreffen'),
    h('option', { value: 'any', selected: !always && r.match === 'any' }, 'eine der Bedingungen zutrifft'),
    h('option', { value: 'always', selected: always }, 'immer – für alle Nachrichten'));
  const condBox = h('div', { class: 'cond-list' });
  const actBox = h('div', { class: 'cond-list' });
  const folders = sortedFolders(account.folders.filter((f) => f.selectable !== false));

  const drawConds = () => {
    clear(condBox, r.conditions.length ? r.conditions.map((cnd, i) => {
      const hdr = h('input', { type: 'text', value: cnd.header || '', placeholder: 'z. B. List-Id', class: 'cond-hdr', 'aria-label': 'Kopfzeile',
        onInput: (e) => { cnd.header = e.target.value.trim(); } });
      hdr.hidden = cnd.field !== 'header';
      return h('div', { class: 'cond-row' },
        h('select', { 'aria-label': 'Feld', onChange: (e) => { cnd.field = e.target.value; hdr.hidden = cnd.field !== 'header'; } },
          Object.entries(FIELD_LABEL).map(([k, l]) => h('option', { value: k, selected: cnd.field === k }, l))),
        hdr,
        h('select', { 'aria-label': 'Vergleich', onChange: (e) => { cnd.op = e.target.value; } },
          Object.entries(OP_LABEL).map(([k, l]) => h('option', { value: k, selected: cnd.op === k }, l))),
        h('input', { type: 'text', value: cnd.value, placeholder: 'Text', class: 'cond-val', 'aria-label': 'Wert', onInput: (e) => { cnd.value = e.target.value; } }),
        iconButton('close', 'Bedingung entfernen', () => { r.conditions.splice(i, 1); drawConds(); }));
    }) : null);
  };
  const drawActs = () => {
    clear(actBox, r.actions.map((a, i) => {
      const extra = a.type === 'fileinto'
        ? h('select', { 'aria-label': 'Ordner', class: 'cond-val', onChange: (e) => { a.folder = e.target.value; } },
          h('option', { value: '' }, 'Ordner wählen …'),
          folders.map(({ f, parts }) => h('option', { value: f.path, selected: a.folder === f.path }, parts.join(' / '))))
        : a.type === 'redirect'
          ? h('span', { class: 'cond-val redir' },
            h('input', { type: 'email', value: a.address || '', placeholder: 'name@beispiel.ch', 'aria-label': 'Weiterleiten an', onInput: (e) => { a.address = e.target.value.trim(); } }),
            h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!a.copy, onChange: (e) => { a.copy = e.target.checked; } }), ' Kopie behalten'))
          : null;
      return h('div', { class: 'cond-row' },
        h('select', { 'aria-label': 'Aktion', onChange: (e) => { a.type = e.target.value; drawActs(); } },
          Object.entries(ACTION_LABEL).map(([k, l]) => h('option', { value: k, selected: a.type === k }, l))),
        extra,
        iconButton('close', 'Aktion entfernen', () => { r.actions.splice(i, 1); drawActs(); }));
    }));
  };
  drawConds();
  drawActs();
  const condWrap = h('div', { class: 'cond-wrap' },
    condBox,
    h('div', {}, h('button', { class: 'link-btn', type: 'button', onClick: () => { r.conditions.push({ field: 'from', op: 'contains', value: '' }); drawConds(); } }, '+ Bedingung')),
    h('small', { class: 'hint' }, 'Platzhalter: * = beliebige Zeichen, ? = ein Zeichen – z. B. „*@firma.ch“.'));
  const syncMatch = () => { condWrap.hidden = match.value === 'always'; };
  match.addEventListener('change', () => {
    if (match.value !== 'always' && !r.conditions.length) { r.conditions.push({ field: 'from', op: 'contains', value: '' }); drawConds(); }
    syncMatch();
  });
  syncMatch();
  const stop = h('input', { type: 'checkbox', checked: r.stop !== false });

  modal({
    title: rule ? 'Regel bearbeiten' : 'Neue Regel',
    wide: true,
    body: h('form', { class: 'form-grid rule-form', onSubmit: (e) => e.preventDefault() },
      field('Name', name),
      h('div', { class: 'inline-field' }, h('span', {}, 'Wenn'), match),
      condWrap,
      h('h4', {}, 'Dann'),
      actBox,
      h('div', {}, h('button', { class: 'link-btn', type: 'button', onClick: () => { r.actions.push({ type: 'seen' }); drawActs(); } }, '+ Aktion')),
      h('label', { class: 'check' }, stop, ' Danach keine weiteren Regeln anwenden')),
    actions: [
      { label: 'Abbrechen' },
      { label: 'Übernehmen', primary: true, onClick: () => {
        r.name = name.value.trim() || 'Regel';
        r.stop = stop.checked;
        if (match.value === 'always') { r.match = 'all'; r.conditions = []; } else {
          r.match = match.value;
          r.conditions = r.conditions.filter((x) => String(x.value).trim());
          if (!r.conditions.length) { toast('Bitte eine Bedingung angeben oder „immer – für alle Nachrichten“ wählen', 'error'); return true; }
        }
        if (r.conditions.some((x) => x.field === 'header' && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(x.header || ''))) { toast('Bitte einen gültigen Kopfzeilen-Namen angeben (z. B. List-Id)', 'error'); return true; }
        if (!r.actions.length) { toast('Bitte mindestens eine Aktion wählen', 'error'); return true; }
        if (r.actions.some((a) => a.type === 'fileinto' && !a.folder)) { toast('Bitte einen Ordner wählen', 'error'); return true; }
        if (r.actions.some((a) => a.type === 'redirect' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address || ''))) { toast('Bitte eine gültige Weiterleitungsadresse angeben', 'error'); return true; }
        if (rule) Object.assign(rule, r); else done(r);
        if (rule) done(rule);
        toast('Regel übernommen – zum Aktivieren „Speichern“ klicken');
        return false;
      } },
    ],
  });
}
