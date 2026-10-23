import { h, clear, icon, iconButton, toast, modal, confirmDialog, field, avatar, debounce, dateInput, formatDeDate, imageToAvatarDataUrl } from './ui.js';
import { loadContactPhotos } from './state.js';
import { get, post, put, del, patch } from './api.js';
import * as compose from './compose.js';

let root = null;
let els = {};
let books = [];
let book = null;
let contacts = [];
let selected = null;
let q = '';

const EMAIL_TYPES = [['', '—'], ['home', 'Privat'], ['work', 'Arbeit'], ['other', 'Andere']];
const ADR_TYPES = [['home', 'Privat'], ['work', 'Arbeit'], ['', 'Andere']];
const PHONE_TYPES = [['cell', 'Mobil'], ['home', 'Privat'], ['work', 'Arbeit'], ['fax', 'Fax'], ['', 'Andere']];
const typeLabel = (list, t) => (list.find(([k]) => k === t) || [null, t || ''])[1];

export function unmount() { root = null; }

export async function render(main) {
  if (!root || !main.contains(root)) mount(main);
  await loadBooks();
}

function mount(main) {
  els = {};
  els.books = h('div', { class: 'book-list' });
  els.list = h('ul', { class: 'contact-list' });
  els.detail = h('div', { class: 'contact-detail' });
  els.search = h('input', {
    type: 'search', placeholder: 'Kontakte durchsuchen…', class: 'search-input',
    onInput: debounce(() => { q = els.search.value.trim().toLowerCase(); renderList(); }, 150),
  });
  root = h('div', { class: 'contacts-view' },
    h('aside', { class: 'cal-side' },
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onClick: () => editDialog(null) }, icon('plus', 16), 'Neuer Kontakt'),
      h('div', { class: 'side-title' }, h('span', {}, 'Adressbücher'), iconButton('plus', 'Adressbuch anlegen', newBookDialog, { class: 'tiny' })),
      els.books),
    h('section', { class: 'contact-col' },
      h('div', { class: 'contact-search' },
        h('div', { class: 'search-wrap' }, icon('search', 16), els.search),
        iconButton('plus', 'Neuer Kontakt', () => editDialog(null))),
      h('div', { class: 'list-scroll' }, els.list)),
    h('section', { class: 'contact-detail-pane' }, els.detail));
  clear(main, root);
  renderDetail();
}

async function loadBooks(fresh) {
  try {
    const r = await get('/dav/collections', { fresh: fresh ? 1 : '' });
    books = r.collections.filter((c) => c.type === 'addressbook');
    for (const e of r.errors || []) toast(`${e.sourceName}: ${e.message}`, 'error', 6000);
  } catch (err) {
    toast(err.message, 'error');
    books = [];
  }
  if (!book || !books.find((b) => b.url === book.url)) book = books[0] || null;
  renderBooks();
  await loadContacts();
}

function renderBooks() {
  clear(els.books, books.length ? books.map((b) => h('button', {
    type: 'button', class: `book ${book && b.url === book.url ? 'active' : ''}`,
    onClick: () => { book = b; selected = null; renderBooks(); loadContacts(); },
  },
  icon('contacts', 16),
  h('span', { class: 'book-name' }, b.name),
  h('small', {}, b.sourceName),
  iconButton('more', 'Adressbuch bearbeiten', (e) => { e.stopPropagation(); bookDialog(b); }, { class: 'tiny' })))
    : h('div', { class: 'muted small' }, h('p', {}, 'Keine Adressbücher gefunden.'),
      h('a', { class: 'btn btn-small', href: '#/settings/dav' }, 'CardDAV-Server einbinden')));
}

async function loadContacts() {
  if (!book) { contacts = []; renderList(); return; }
  clear(els.list, h('li', { class: 'list-loading' }, h('span', { class: 'spinner' })));
  try {
    const r = await get('/contacts', { sourceId: book.sourceId, book: book.url });
    contacts = r.contacts;
  } catch (err) {
    toast(err.message, 'error');
    contacts = [];
  }
  if (selected) selected = contacts.find((c) => c.url === selected.url) || null;
  renderList();
  renderDetail();
}

function renderList() {
  const list = contacts.filter((c) => !q || `${c.fn} ${c.org} ${c.emails.map((e) => e.value).join(' ')} ${c.phones.map((p) => p.value).join(' ')}`.toLowerCase().includes(q));
  if (!list.length) {
    clear(els.list, h('li', { class: 'empty-list' }, q ? 'Keine Treffer.' : 'Noch keine Kontakte.'));
    return;
  }
  let letter = '';
  const items = [];
  for (const c of list) {
    const l = (c.fn || '#')[0].toUpperCase();
    if (l !== letter) { letter = l; items.push(h('li', { class: 'letter' }, l)); }
    items.push(h('li', {
      class: `contact ${selected && selected.url === c.url ? 'active' : ''}`,
      onClick: () => { selected = c; renderList(); renderDetail(); root.classList.add('reading'); },
    }, contactAvatar(c, 32),
    h('div', {}, h('strong', {}, c.fn || '(ohne Namen)'), h('small', {}, (c.emails[0] && c.emails[0].value) || c.org || ''))));
  }
  clear(els.list, items);
}

function renderDetail() {
  if (!selected) {
    clear(els.detail, h('div', { class: 'reader-empty' }, icon('contacts', 40), h('p', {}, books.length ? 'Wähle einen Kontakt aus' : 'Kein Adressbuch vorhanden')));
    return;
  }
  const c = selected;
  const row = (label, value, href) => h('div', { class: 'kv' }, h('span', { class: 'k' }, label),
    href ? h('a', { href, class: 'v' }, value) : h('span', { class: 'v' }, value));
  clear(els.detail,
    h('div', { class: 'reader-toolbar' },
      iconButton('back', 'Zurück', () => root.classList.remove('reading'), { class: 'only-mobile' }),
      h('span', { class: 'grow' }),
      iconButton('edit', 'Bearbeiten', () => editDialog(c)),
      iconButton('trash', 'Löschen', async () => {
        if (!(await confirmDialog('Kontakt löschen', `„${c.fn}“ löschen?`, { confirmLabel: 'Löschen' }))) return;
        try {
          await del('/contacts', { sourceId: book.sourceId, url: c.url, etag: c.etag });
          selected = null;
          toast('Kontakt gelöscht');
          loadContactPhotos(true);
          loadContacts();
        } catch (err) { toast(err.message, 'error'); }
      })),
    h('div', { class: 'contact-card' },
      h('div', { class: 'contact-hero' }, contactAvatar(c, 72),
        h('div', {}, h('h2', {}, c.fn || '(ohne Namen)'), c.org || c.title ? h('p', { class: 'muted' }, [c.title, c.org].filter(Boolean).join(' · ')) : null)),
      c.emails.map((e) => h('div', { class: 'kv' },
        h('span', { class: 'k' }, `E-Mail${e.type ? ' (' + typeLabel(EMAIL_TYPES, e.type) + ')' : ''}`),
        h('button', { class: 'link-btn v', type: 'button', onClick: () => compose.openCompose({ to: c.fn ? `${c.fn} <${e.value}>` : e.value }) }, e.value))),
      c.phones.map((p) => row(`Telefon${p.type ? ' (' + typeLabel(PHONE_TYPES, p.type) + ')' : ''}`, p.value, `tel:${p.value.replace(/\s+/g, '')}`)),
      (c.addresses || []).map((a) => {
        const lines = [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.region, a.country].filter(Boolean);
        const q = encodeURIComponent(lines.join(', ').replace(/\n/g, ', '));
        return h('div', { class: 'kv' },
          h('span', { class: 'k' }, `Adresse${a.type ? ' (' + typeLabel(ADR_TYPES, a.type) + ')' : ''}`),
          h('a', { class: 'v address', href: `https://www.openstreetmap.org/search?query=${q}`, target: '_blank', rel: 'noopener noreferrer', title: 'Auf Karte zeigen' },
            lines.flatMap((l) => l.split('\n')).map((l) => h('div', {}, l))));
      }),
      c.birthday ? row('Geburtstag', formatDeDate(c.birthday)) : null,
      c.website ? row('Webseite', c.website, /^https?:/i.test(c.website) ? c.website : null) : null,
      c.note ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Notiz'), h('p', { class: 'v note' }, c.note)) : null));
}

// ====================================================================== Bearbeiten

function multiRows(items, types, placeholder, inputType) {
  const wrap = h('div', { class: 'multi' });
  const add = (it = { type: types[0][0], value: '' }) => {
    const row = h('div', { class: 'multi-row' },
      h('select', {}, types.map(([k, l]) => h('option', { value: k, selected: k === (it.type || '') }, l))),
      h('input', { type: inputType, value: it.value, placeholder }),
      h('button', { type: 'button', class: 'icon-btn tiny', title: 'Entfernen', onClick: () => row.remove() }, icon('close', 14)));
    wrap.insertBefore(row, addBtn);
  };
  const addBtn = h('button', { type: 'button', class: 'link-btn', onClick: () => add() }, '+ hinzufügen');
  wrap.appendChild(addBtn);
  (items.length ? items : [{ type: types[0][0], value: '' }]).forEach(add);
  wrap.values = () => [...wrap.querySelectorAll('.multi-row')].map((r) => ({ type: r.querySelector('select').value, value: r.querySelector('input').value.trim() })).filter((x) => x.value);
  return wrap;
}

function addressRows(items) {
  const wrap = h('div', { class: 'multi' });
  const add = (a = { type: 'home', street: '', postalCode: '', city: '', region: '', country: '' }) => {
    const inp = (name, ph, val) => h('input', { type: 'text', 'data-k': name, placeholder: ph, value: val || '' });
    const box = h('div', { class: 'adr-row' },
      h('div', { class: 'adr-head' },
        h('select', { 'data-k': 'type' }, ADR_TYPES.map(([k, l]) => h('option', { value: k, selected: k === (a.type || '') }, l))),
        h('button', { type: 'button', class: 'icon-btn tiny', title: 'Adresse entfernen', onClick: () => box.remove() }, icon('close', 14))),
      h('textarea', { 'data-k': 'street', rows: 2, placeholder: 'Strasse und Hausnummer' }, a.street || ''),
      h('div', { class: 'adr-city' }, inp('postalCode', 'PLZ', a.postalCode), inp('city', 'Ort', a.city)),
      h('div', { class: 'row2' }, inp('region', 'Kanton / Bundesland', a.region), inp('country', 'Land', a.country)));
    wrap.insertBefore(box, addBtn);
  };
  const addBtn = h('button', { type: 'button', class: 'link-btn', onClick: () => add() }, '+ Adresse hinzufügen');
  wrap.appendChild(addBtn);
  items.forEach(add);
  wrap.values = () => [...wrap.querySelectorAll('.adr-row')].map((r) => {
    const o = {};
    r.querySelectorAll('[data-k]').forEach((el) => { o[el.dataset.k] = el.value.trim(); });
    return o;
  }).filter((a) => a.street || a.city || a.postalCode || a.country || a.region);
  return wrap;
}

function photoUrl(c, bust) {
  return `/api/contact-photo?sourceId=${encodeURIComponent(book.sourceId)}&url=${encodeURIComponent(c.url)}${bust ? `&v=${encodeURIComponent(c.etag || Date.now())}` : `&v=${encodeURIComponent(c.etag || '')}`}`;
}

function contactAvatar(c, size) {
  const el = avatar(c.fn, c.emails[0] && c.emails[0].value, size, c.hasPhoto && book ? { photoUrl: photoUrl(c) } : {});
  if (c.hasPhoto) el.classList.add('avatar-direct');
  return el;
}

/** Foto-Auswahl im Bearbeiten-Dialog. value(): undefined = unverändert, null = entfernen, data:-URI = neu */
function photoPicker(c) {
  let value;
  let current = c && c.hasPhoto ? photoUrl(c) : null;
  const preview = h('div', { class: 'photo-preview' });
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const removeBtn = h('button', { type: 'button', class: 'link-btn', onClick: () => { value = null; current = null; draw(); } }, 'Entfernen');
  const draw = () => {
    const src = value || (value === null ? null : current);
    clear(preview, src ? h('img', { src, alt: 'Kontaktfoto' }) : h('span', {}, icon('user', 32)));
    removeBtn.hidden = !src;
  };
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast('Bitte eine Bilddatei wählen', 'error'); return; }
    try { value = await imageToAvatarDataUrl(f, 256); draw(); } catch (err) { toast(err.message, 'error'); }
  });
  draw();
  const wrap = h('div', { class: 'photo-picker' }, preview,
    h('div', { class: 'photo-actions' },
      h('button', { type: 'button', class: 'btn btn-small', onClick: () => input.click() }, icon('image', 15), 'Foto wählen'),
      removeBtn, input,
      h('small', { class: 'hint' }, 'Wird quadratisch zugeschnitten und verkleinert. Erscheint auch bei Mails dieses Kontakts.')));
  wrap.value = () => value;
  return wrap;
}

export function editDialog(c, preset = {}) {
  if (!books.length && !c) { noServerHint(); return; }
  const v = c || { firstName: '', lastName: '', fn: '', org: '', title: '', emails: preset.emails || [], phones: [], addresses: [], birthday: '', website: '', note: '' };
  const photo = photoPicker(c);
  const first = h('input', { type: 'text', value: v.firstName || preset.firstName || '' });
  const last = h('input', { type: 'text', value: v.lastName || preset.lastName || '' });
  const fn = h('input', { type: 'text', value: c ? v.fn : '', placeholder: 'automatisch aus Vor- und Nachname' });
  const org = h('input', { type: 'text', value: v.org });
  const title = h('input', { type: 'text', value: v.title });
  const emails = multiRows(v.emails, EMAIL_TYPES, 'name@beispiel.ch', 'email');
  const phones = multiRows(v.phones, PHONE_TYPES, '+41 …', 'tel');
  const addresses = addressRows(v.addresses || []);
  const bday = dateInput(v.birthday || '', { label: 'Geburtstag' });
  const url = h('input', { type: 'url', value: v.website || '' });
  const note = h('textarea', { rows: 3 }, v.note || '');
  const bookSel = h('select', {}, books.map((b) => h('option', { value: b.url, selected: book && b.url === book.url }, `${b.name} – ${b.sourceName}`)));

  modal({
    title: c ? 'Kontakt bearbeiten' : 'Neuer Kontakt',
    wide: true,
    body: h('div', { class: 'form-grid' },
      photo,
      h('div', { class: 'row2' }, field('Vorname', first), field('Nachname', last)),
      field('Anzeigename', fn),
      h('div', { class: 'row2' }, field('Firma', org), field('Position', title)),
      field('E-Mail-Adressen', emails),
      field('Telefonnummern', phones),
      field('Adressen', addresses),
      h('div', { class: 'row2' }, field('Geburtstag', bday), field('Webseite', url)),
      field('Notiz', note),
      !c ? field('Adressbuch', bookSel) : null),
    actions: [
      { label: 'Abbrechen' },
      { label: 'Speichern', primary: true, onClick: async () => {
        const contact = {
          firstName: first.value.trim(), lastName: last.value.trim(), fn: fn.value.trim(), org: org.value.trim(), title: title.value.trim(),
          emails: emails.values(), phones: phones.values(), addresses: addresses.values(), birthday: bday.value, website: url.value.trim(), note: note.value, photo: photo.value(),
        };
        if (!bday.isValid()) { toast('Bitte das Geburtsdatum als TT.MM.JJJJ angeben', 'error'); return true; }
        if (!contact.fn && !contact.firstName && !contact.lastName && !contact.org && !contact.emails.length) {
          toast('Bitte mindestens einen Namen oder eine E-Mail-Adresse angeben', 'error');
          return true;
        }
        if (c) {
          await put('/contacts', { sourceId: book.sourceId, url: c.url, etag: c.etag, contact });
        } else {
          const b = books.find((x) => x.url === bookSel.value) || book;
          await post('/contacts', { sourceId: b.sourceId, book: b.url, contact });
          if (book && b.url !== book.url) book = b;
        }
        toast('Kontakt gespeichert', 'success');
        loadContactPhotos(true);
        if (root) await loadContacts();
      } },
    ],
  });
}

async function newBookDialog() {
  const name = h('input', { type: 'text', placeholder: 'z. B. Arbeit' });
  let sources = [];
  try { sources = (await get('/dav/sources')).sources.map((x) => [String(x.id), x.name]); } catch (err) { toast(err.message, 'error'); return; }
  if (!sources.length) { noServerHint(); return; }
  const src = h('select', {}, sources.map(([id, n]) => h('option', { value: id }, n)));
  modal({
    title: 'Neues Adressbuch',
    body: h('div', { class: 'form-grid' }, field('Name', name), field('Speicherort', src)),
    actions: [
      { label: 'Abbrechen' },
      { label: 'Anlegen', primary: true, onClick: async () => {
        await post('/dav/collections', { sourceId: src.value, type: 'addressbook', name: name.value || 'Adressbuch' });
        toast('Adressbuch angelegt', 'success');
        await loadBooks(true);
      } },
    ],
  });
}

function bookDialog(b) {
  const name = h('input', { type: 'text', value: b.name });
  modal({
    title: 'Adressbuch bearbeiten',
    body: h('div', { class: 'form-grid' }, field('Name', name), h('p', { class: 'hint' }, `${b.sourceName} · ${b.url}`)),
    actions: [
      { label: 'Löschen', danger: true, onClick: async () => {
        if (!(await confirmDialog('Adressbuch löschen', `„${b.name}“ mit allen Kontakten löschen?`, { confirmLabel: 'Löschen' }))) return true;
        await del('/dav/collections', { sourceId: b.sourceId, url: b.url });
        book = null;
        await loadBooks(true);
      } },
      { label: 'Abbrechen' },
      { label: 'Speichern', primary: true, onClick: async () => {
        await patch('/dav/collections', { sourceId: b.sourceId, url: b.url, name: name.value });
        await loadBooks(true);
      } },
    ],
  });
}

function noServerHint() {
  modal({
    title: 'Kein Kalender-/Kontakte-Server',
    body: h('p', {}, 'Webmail speichert Kalender und Kontakte auf deinem vorhandenen CalDAV/CardDAV-Server (z. B. Nextcloud, mailcow/SOGo, mailbox.org). Binde ihn zuerst in den Einstellungen ein.'),
    actions: [{ label: 'Abbrechen' }, { label: 'Zu den Einstellungen', primary: true, onClick: () => { location.hash = '#/settings/dav'; } }],
  });
}
