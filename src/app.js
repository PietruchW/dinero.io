// Interfejs aplikacji. Każdy tekst z pliku banku przechodzi przez esc(),
// bo nazwy kontrahentów to dane z zewnątrz i nie mogą trafić do HTML wprost.

import { readStatement } from './importer.js';
import { CATEGORIES } from './categorize.js';
import {
  loadState, saveState, mergeTransactions, setCategory, monthSummary, months,
  exportBackup, importBackup, emptyState, setOwnerNames, recategorize, setAiEnabled
} from './store.js';
import { AI_URL } from './config.js';
import { selectForAI, applyAIResults, requestCategories } from './ai.js';

const COLORS = {
  'Jedzenie': '#D08C3E',
  'Wyjścia': '#5B7FB8',
  'Zakupy': '#B85C8A',
  'Transport': '#3E8E7E',
  'Kosmetyki i zdrowie': '#C57B6A',
  'Rachunki': '#8C7A3D',
  'Subskrypcje': '#7D6BB3',
  'Inne': '#9A958C',
  'Przelewy własne': '#B9B4AA',
  'Przychód': '#2F6B57'
};
const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września',
  'października', 'listopada', 'grudnia'];
const MONTHS_NOM = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień',
  'Październik', 'Listopad', 'Grudzień'];

const money = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
const app = document.getElementById('app');

const ui = {
  view: 'pulpit',
  month: null,
  rememberRules: true,
  onlyReview: false,
  pending: null, // { bytes, result, fileName }
  message: null,
  aiBusy: false
};

function aiReady() {
  return Boolean(AI_URL) && state.settings.aiEnabled;
}

/** Wysyła nierozpoznane sklepy do AI i zapisuje podpowiedzi. */
async function runAI() {
  const items = selectForAI(state);
  if (!items.length || ui.aiBusy) return;
  ui.aiBusy = true;
  render();
  try {
    const results = await requestCategories(AI_URL, items);
    const { state: next, applied } = applyAIResults(state, results);
    state = next;
    if (persist()) {
      ui.message = {
        kind: 'ok',
        text: applied
          ? `AI przypisało kategorie ${applied} sklepom. Sprawdź je – możesz zmienić każdą.`
          : 'AI nie rozpoznało tych sklepów. Przypisz je ręcznie.'
      };
    }
  } catch (err) {
    ui.message = { kind: 'err', text: err.message };
  } finally {
    ui.aiBusy = false;
    render();
  }
}
let state = recategorize(loadState(window.localStorage));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_NOM[m - 1]} ${y}`;
}

function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function persist() {
  try {
    saveState(window.localStorage, state);
    return true;
  } catch {
    ui.message = { kind: 'err', text: 'Nie udało się zapisać danych w telefonie. Zrób kopię zapasową i zwolnij miejsce.' };
    return false;
  }
}

function currentMonth() {
  const list = months(state);
  if (!list.length) return null;
  if (!ui.month || !list.includes(ui.month)) ui.month = list[0];
  return ui.month;
}

const chevron = (dir) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${dir === 'prev' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'}"/></svg>`;

function monthNav() {
  const list = months(state);
  const i = list.indexOf(ui.month);
  return `<div class="month-nav">
    <button type="button" class="icon-btn" data-action="month" data-step="1" aria-label="Poprzedni miesiąc" ${i >= list.length - 1 ? 'disabled' : ''}>${chevron('prev')}</button>
    <button type="button" class="icon-btn" data-action="month" data-step="-1" aria-label="Następny miesiąc" ${i <= 0 ? 'disabled' : ''}>${chevron('next')}</button>
  </div>`;
}

function emptyView() {
  return `<div class="card empty">
    <h2>Zacznij od wczytania wyciągu</h2>
    <p class="muted">Pobierz historię konta jako plik CSV z aplikacji lub strony banku i wczytaj ją tutaj.</p>
    <button type="button" class="btn" data-action="go" data-view="import">Wczytaj wyciąg</button>
  </div>`;
}

function pulpitView() {
  const month = currentMonth();
  if (!month) return `<header><span class="eyebrow">Dinero</span><h1>Pulpit</h1></header>${emptyView()}`;
  const s = monthSummary(state, month);
  const review = state.transactions.filter((t) => t.date.startsWith(month) && t.needsReview).length;
  const cats = Object.entries(s.byCategory).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = cats.length ? cats[0][1] : 1;
  return `
  <header class="head-row">
    <div><span class="eyebrow">Wydatki</span><h1>${esc(monthLabel(month))}</h1></div>
    ${monthNav()}
  </header>
  <section class="hero">
    <span class="label">Wydałaś w tym miesiącu</span>
    <span class="big">${esc(money.format(s.spent))}</span>
    <span class="sub">Wpływy: ${esc(money.format(s.income))}</span>
  </section>
  ${s.neutral ? `<p class="muted">Przelewy między Twoimi kontami (${esc(money.format(s.neutral))}) nie liczą się do wydatków ani wpływów.</p>` : ''}
  ${state.settings.ownerNames.length ? '' : `<section class="card">
    <p>Wpisz swoje imię i nazwisko, żeby przelewy między Twoimi kontami nie liczyły się jako wydatki.</p>
    <button type="button" class="btn secondary" data-action="go" data-view="ustawienia">Przejdź do ustawień</button>
  </section>`}
  ${review ? `<button type="button" class="badge" data-action="review">${review} do sprawdzenia →</button>` : ''}
  <section class="card">
    <h2>Kategorie</h2>
    ${cats.length ? cats.map(([name, value]) => `
      <div class="cat-row">
        <div class="cat-top">
          <span class="cat-name"><span class="dot" style="background:${COLORS[name] ?? '#9A958C'}"></span>${esc(name)}</span>
          <span>${esc(money.format(value))}</span>
        </div>
        <div class="bar"><span style="width:${Math.max(2, Math.round((value / max) * 100))}%"></span></div>
      </div>`).join('') : '<p class="muted">Brak wydatków w tym miesiącu.</p>'}
  </section>`;
}

function categorySelect(tx) {
  const options = CATEGORIES.map(
    (c) => `<option value="${esc(c)}" ${c === tx.category ? 'selected' : ''}>${esc(c)}</option>`
  ).join('');
  return `<label class="tx-cat"><span class="visually-hidden">Kategoria dla ${esc(tx.name)}</span>
    <select data-action="category" data-id="${esc(tx.id)}">${options}</select></label>`;
}

function transakcjeView() {
  const month = currentMonth();
  if (!month) return `<header><h1>Transakcje</h1></header>${emptyView()}`;
  const list = state.transactions.filter((t) => t.date.startsWith(month) && (!ui.onlyReview || t.needsReview));
  const byDay = new Map();
  for (const t of list) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push(t);
  }
  const groups = [...byDay.entries()].map(([day, txs]) => `
    <section class="tx-group">
      <h2>${esc(dayLabel(day))}</h2>
      <div class="tx-list">${txs.map((t) => `
        <div class="tx">
          <div class="tx-main">
            <span class="tx-name">${esc(t.name || '(bez nazwy)')}</span>
            ${categorySelect(t)}
            ${t.needsReview ? '<span class="review">Do sprawdzenia</span>' : ''}
            ${t.source === 'ai' && !t.needsReview ? '<span class="ai-tag">Przypisane przez AI</span>' : ''}
            ${t.source === 'ai' && t.needsReview ? '<span class="ai-tag">AI nie rozpoznało – wybierz kategorię</span>' : ''}
          </div>
          <span class="tx-amount ${t.amount > 0 ? 'plus' : ''}">${t.amount > 0 ? '+' : ''}${esc(money.format(t.amount))}</span>
        </div>`).join('')}
      </div>
    </section>`).join('');
  return `
  <header class="head-row">
    <div><span class="eyebrow">Transakcje</span><h1>${esc(monthLabel(month))}</h1></div>
    ${monthNav()}
  </header>
  ${ui.message ? `<div class="msg ${ui.message.kind}">${esc(ui.message.text)}</div>` : ''}
  ${aiReady() && (selectForAI(state).length || ui.aiBusy) ? `<button type="button" class="btn" data-action="ai" ${ui.aiBusy ? 'disabled' : ''}>
    ${ui.aiBusy ? 'AI przypisuje kategorie…' : `Przypisz kategorie z AI (${selectForAI(state).length})`}</button>` : ''}
  <div class="card">
    <label class="toggle">Pokaż tylko do sprawdzenia
      <input type="checkbox" data-action="only-review" ${ui.onlyReview ? 'checked' : ''}></label>
    <label class="toggle">Zapamiętuj kategorię dla sklepu
      <input type="checkbox" data-action="remember" ${ui.rememberRules ? 'checked' : ''}></label>
  </div>
  ${groups || '<p class="muted">Nic tu nie ma.</p>'}`;
}

function mappingField(key, label, result, optional) {
  const opts = result.headers.map(
    (h, i) => `<option value="${i}" ${result.mapping[key] === i ? 'selected' : ''}>${esc(h)}</option>`
  );
  if (optional) opts.unshift(`<option value="" ${result.mapping[key] == null ? 'selected' : ''}>— brak —</option>`);
  return `<label class="field">${esc(label)}<select data-action="map" data-key="${key}">${opts.join('')}</select></label>`;
}

function importView() {
  const p = ui.pending;
  const msg = ui.message ? `<div class="msg ${ui.message.kind}">${esc(ui.message.text)}</div>` : '';
  let details = '';
  if (p) {
    const r = p.result;
    const preview = r.transactions.slice(0, 5).map((t) => `
      <tr><td>${esc(t.date)}</td><td>${esc(t.name)}</td><td>${esc(money.format(t.amount))}</td></tr>`).join('');
    details = `
    <section class="card">
      <div><h2>${esc(p.fileName)}</h2>
      <p class="muted">${r.transactions.length} transakcji · kodowanie ${esc(r.encoding)}</p></div>
      ${mappingField('date', 'Data', r, false)}
      ${mappingField('amount', 'Kwota', r, false)}
      ${mappingField('name', 'Kontrahent', r, true)}
      ${mappingField('title', 'Tytuł', r, true)}
      ${preview ? `<table class="preview"><tbody>${preview}</tbody></table>`
        : '<p class="msg err">Nie znalazłam transakcji. Sprawdź, czy kolumny Data i Kwota są dobrze wybrane.</p>'}
      <button type="button" class="btn" data-action="do-import" ${r.transactions.length ? '' : 'disabled'}>Importuj ${r.transactions.length} transakcji</button>
    </section>`;
  }
  return `
  <header><span class="eyebrow">Nowe dane</span><h1>Wczytaj wyciąg</h1></header>
  <div class="privacy">
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
    <span>Twoje dane zostają tylko na tym urządzeniu. Nic nie jest nigdzie wysyłane.</span>
  </div>
  ${msg}
  <label class="drop">
    <strong>Wybierz plik CSV</strong>
    <span class="muted">Historia konta pobrana z aplikacji lub strony banku</span>
    <input class="visually-hidden" type="file" accept=".csv,text/csv" data-action="file">
  </label>
  ${details}`;
}

function ustawieniaView() {
  const msg = ui.message ? `<div class="msg ${ui.message.kind}">${esc(ui.message.text)}</div>` : '';
  return `
  <header><span class="eyebrow">Twoje dane</span><h1>Ustawienia</h1></header>
  ${msg}
  <section class="card">
    <h2>Twoje konta</h2>
    <p class="muted">Imię i nazwisko tak, jak widnieje w banku. Przelewy, w których jesteś po obu stronach (np. na konto oszczędnościowe), nie będą liczone jako wydatki. Kilka wariantów oddziel przecinkiem.</p>
    <label class="visually-hidden" for="owner-names">Imię i nazwisko</label>
    <input id="owner-names" class="text-input" type="text" autocomplete="name" value="${esc(state.settings.ownerNames.join(', '))}" placeholder="np. Anna Nowak">
    <button type="button" class="btn" data-action="save-owner">Zapisz</button>
  </section>
  ${AI_URL ? `<section class="card">
    <h2>Podpowiedzi AI</h2>
    <p class="muted">Gdy włączone, nierozpoznane płatności są wysyłane do AI (Claude) przez serwer pośredniczący, który niczego nie zapisuje. Wysyłana jest tylko nazwa sklepu i kwota – bez dat, numerów kont, tytułów i bez przelewów do osób. Każdą podpowiedź możesz zmienić.</p>
    <label class="toggle">Włącz podpowiedzi AI
      <input type="checkbox" data-action="ai-toggle" ${state.settings.aiEnabled ? 'checked' : ''}></label>
  </section>` : ''}
  <section class="card">
    <h2>Kopia zapasowa</h2>
    <p>Dane są tylko w tym telefonie. Raz w miesiącu zapisz kopię w Plikach albo na iCloud – jeśli telefon wyczyści dane strony, odtworzysz wszystko z kopii.</p>
    <p class="muted">${state.transactions.length} transakcji · ${Object.keys(state.rules).length} zapamiętanych sklepów</p>
    <button type="button" class="btn" data-action="backup">Zapisz kopię</button>
    <label class="btn secondary" style="display:flex;align-items:center;justify-content:center">Przywróć z kopii
      <input class="visually-hidden" type="file" accept=".json,application/json" data-action="restore"></label>
  </section>
  <section class="card">
    <h2>Usuń wszystkie dane</h2>
    <p class="muted">Kasuje transakcje i zapamiętane sklepy z tego telefonu. Tego nie da się cofnąć bez kopii.</p>
    <button type="button" class="btn secondary" data-action="wipe">Usuń dane</button>
  </section>`;
}

function render() {
  const views = { pulpit: pulpitView, transakcje: transakcjeView, import: importView, ustawienia: ustawieniaView };
  app.innerHTML = views[ui.view]();
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.view === ui.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

function go(view) {
  if (view !== ui.view) ui.message = null;
  ui.view = view;
  render();
  window.scrollTo(0, 0);
}

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) go(btn.dataset.view);
});

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'go') go(el.dataset.view);
  if (action === 'month') {
    const list = months(state);
    const i = list.indexOf(ui.month) + Number(el.dataset.step);
    if (i >= 0 && i < list.length) ui.month = list[i];
    render();
  }
  if (action === 'review') {
    ui.onlyReview = true;
    go('transakcje');
  }
  if (action === 'do-import' && ui.pending) {
    const { state: next, added, duplicates } = mergeTransactions(state, ui.pending.result.transactions);
    state = next;
    if (persist()) {
      ui.message = {
        kind: 'ok',
        text: `Dodano ${added} transakcji.${duplicates ? ` Pominięto ${duplicates} już wczytanych.` : ''}`
      };
    }
    ui.pending = null;
    ui.month = null;
    render();
    if (aiReady()) runAI();
  }
  if (action === 'ai') runAI();
  if (action === 'backup') saveBackup();
  if (action === 'save-owner') {
    const input = document.getElementById('owner-names');
    state = setOwnerNames(state, input.value.split(','));
    if (persist()) ui.message = { kind: 'ok', text: 'Zapisano. Kategorie zostały przeliczone.' };
    render();
  }
  if (action === 'wipe' && window.confirm('Na pewno usunąć wszystkie dane z tego telefonu?')) {
    state = emptyState();
    persist();
    ui.message = { kind: 'ok', text: 'Dane usunięte.' };
    render();
  }
});

app.addEventListener('change', async (e) => {
  const el = e.target;
  const action = el.dataset.action;
  if (action === 'category') {
    state = setCategory(state, el.dataset.id, el.value, ui.rememberRules);
    persist();
    render();
  }
  if (action === 'remember') ui.rememberRules = el.checked;
  if (action === 'ai-toggle') {
    state = setAiEnabled(state, el.checked);
    persist();
  }
  if (action === 'only-review') {
    ui.onlyReview = el.checked;
    render();
  }
  if (action === 'file' && el.files[0]) {
    const file = el.files[0];
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      ui.pending = { bytes, fileName: file.name, result: readStatement(bytes) };
      ui.message = null;
    } catch {
      ui.pending = null;
      ui.message = { kind: 'err', text: 'Nie udało się odczytać pliku. Czy to na pewno CSV z banku?' };
    }
    render();
  }
  if (action === 'map' && ui.pending) {
    const mapping = { ...ui.pending.result.mapping, [el.dataset.key]: el.value === '' ? null : Number(el.value) };
    ui.pending.result = readStatement(ui.pending.bytes, mapping);
    render();
  }
  if (action === 'restore' && el.files[0]) {
    try {
      const restored = importBackup(await el.files[0].text());
      if (window.confirm(`Zastąpić obecne dane kopią (${restored.transactions.length} transakcji)?`)) {
        state = restored;
        if (persist()) ui.message = { kind: 'ok', text: 'Dane odtworzone z kopii.' };
      }
    } catch {
      ui.message = { kind: 'err', text: 'To nie jest kopia zapasowa z tej aplikacji.' };
    }
    render();
  }
});

async function saveBackup() {
  const name = `dinero-kopia-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([exportBackup(state)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Kopia Dinero' });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
