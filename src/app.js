// Interfejs aplikacji. Każdy tekst z pliku banku przechodzi przez esc(),
// bo nazwy kontrahentów to dane z zewnątrz i nie mogą trafić do HTML wprost.

import { readFile, analyzeRows } from './importer.js';
import { CATEGORIES } from './categorize.js';
import { parseAmount } from './detect.js';
import {
  loadState, saveState, mergeTransactions, setCategory, monthSummary, months,
  exportBackup, importBackup, emptyState, setOwnerNames, recategorize, setAiEnabled, setAiToken, setChatSettings,
  accounts, forAccount, spendingRatio, NO_ACCOUNT, hasUnnamedAccount, EXPENSE_CATEGORIES, setBudgets, budgetRows, averageSpending
} from './store.js';
import { AI_URL, APP_VERSION } from './config.js';
import {
  selectForAI, applyAIResults, requestCategories, generateAccessCode,
  buildChatContext, requestChat, loadChat, saveChat
} from './ai.js';

const COLORS = {
  'Jedzenie': '#D08C3E',
  'Wyjścia': '#5B7FB8',
  'Zakupy': '#B85C8A',
  'Transport': '#3E8E7E',
  'Podróże': '#2F7FA6',
  'Kosmetyki i zdrowie': '#C57B6A',
  'Rachunki': '#8C7A3D',
  'Podatki i ZUS': '#5E6B7A',
  'Długi': '#A8483A',
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
const moneyWhole = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 });
/** Kwota limitu: bez „,00”, gdy jest pełna. */
const limitMoney = (v) => (Number.isInteger(v) ? moneyWhole : money).format(v);
const app = document.getElementById('app');

const ui = {
  view: 'pulpit',
  month: null,
  account: null, // null = wszystkie konta
  rememberRules: true,
  onlyReview: false,
  editLimits: false,
  category: null, // filtr kategorii w Transakcjach (z pulpitu)
  limitDraft: null, // wpisane, jeszcze niezapisane kwoty limitów
  pending: null, // { result, fileName }
  message: null,
  aiBusy: false,
  chat: loadChat(window.localStorage),
  chatBusy: false,
  chatError: null,
  refreshing: false
};

const SUGGESTIONS = [
  'Na co poszło najwięcej w tym miesiącu?',
  'Porównaj wydatki z poprzednimi miesiącami',
  'Gdzie mogę najłatwiej zaoszczędzić?',
  'Ile wydaję średnio na jedzenie na mieście?'
];

/** Prosty format odpowiedzi: tekst escapowany, potem tylko **pogrubienie**. */
function formatReply(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

async function sendChat(text) {
  const content = text.trim();
  if (!content || ui.chatBusy) return;
  ui.chat = [...ui.chat, { role: 'user', content }];
  ui.chatBusy = true;
  ui.chatError = null;
  saveChat(window.localStorage, ui.chat);
  render();
  try {
    const context = buildChatContext(state, state.settings.chatMonths);
    const reply = await requestChat(AI_URL, state.settings.aiToken, ui.chat, context);
    ui.chat = [...ui.chat, { role: 'assistant', content: reply }];
    saveChat(window.localStorage, ui.chat);
  } catch (err) {
    // Pytanie bez odpowiedzi wraca do pola tekstowego – rozmowa zostaje spójna.
    ui.chat = ui.chat.slice(0, -1);
    saveChat(window.localStorage, ui.chat);
    ui.chatError = { text: err.message, draft: content };
  } finally {
    ui.chatBusy = false;
    render();
    const list = document.querySelector('.chat');
    if (list) list.lastElementChild?.scrollIntoView({ block: 'end' });
  }
}

function aiReady() {
  return Boolean(AI_URL) && state.settings.aiEnabled && Boolean(state.settings.aiToken);
}

/** Wysyła nierozpoznane sklepy do AI i zapisuje podpowiedzi. */
async function runAI() {
  const items = selectForAI(state);
  if (!items.length || ui.aiBusy) return;
  ui.aiBusy = true;
  render();
  try {
    const results = await requestCategories(AI_URL, items, state.settings.aiToken);
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

/** Wybór konta – widoczny dopiero, gdy w danych są co najmniej dwa konta. */
function accountFilter() {
  const list = accounts(state);
  const unnamed = hasUnnamedAccount(state);
  if (list.length + (unnamed ? 1 : 0) < 2) {
    ui.account = null;
    return '';
  }
  const values = unnamed ? [...list, NO_ACCOUNT] : list;
  if (ui.account && !values.includes(ui.account)) ui.account = null;
  const opts = values.map((a) => `<option value="${esc(a)}" ${a === ui.account ? 'selected' : ''}>${
    a === NO_ACCOUNT ? 'Bez nazwy konta' : esc(a)}</option>`);
  return `<label class="field account-filter"><span class="visually-hidden">Konto</span>
    <select data-action="account">
      <option value="" ${ui.account ? '' : 'selected'}>Wszystkie konta</option>${opts.join('')}
    </select></label>
    ${ui.account === NO_ACCOUNT ? '<p class="muted">Transakcje wczytane, zanim można było podać nazwę konta. Wczytaj te pliki jeszcze raz z nazwą konta – nic się nie zdubluje, a transakcje dostaną nazwę.</p>' : ''}`;
}

function emptyView() {
  return `<div class="card empty">
    <h2>Zacznij od wczytania wyciągu</h2>
    <p class="muted">Pobierz historię konta jako plik CSV lub Excel z aplikacji lub strony banku i wczytaj ją tutaj.</p>
    <button type="button" class="btn" data-action="go" data-view="import">Wczytaj wyciąg</button>
  </div>`;
}

/** Pierścień „ile z wpływów wydałaś” i zdanie pod nim. */
function incomeRing(s, month) {
  const r = spendingRatio(s);
  if (s.spent < 0) {
    return `<p class="hero-note">Wpływy zapisane w kategoriach wydatków są większe niż wydatki – sprawdź kategorie poniżej.</p>`;
  }
  if (!r) {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `<p class="hero-note">${month === current
      ? 'Wypłata jeszcze nie wpłynęła – wtedy zobaczysz, ile z niej zostało.'
      : 'W tym miesiącu nie było wpływów.'}</p>`;
  }
  const radius = 26;
  const length = 2 * Math.PI * radius;
  const filled = Math.min(r.ratio, 1) * length;
  const text = r.level === 'over'
    ? `Wydałaś o ${money.format(-r.left)} więcej, niż wpłynęło`
    : `Zostało ${money.format(r.left)} z wpływów`;
  return `<div class="hero-ring ${r.level}">
    <svg viewBox="0 0 64 64" role="img" aria-label="Wydano ${r.percent}% wpływów">
      <circle class="ring-track" cx="32" cy="32" r="${radius}"/>
      <circle class="ring-fill" cx="32" cy="32" r="${radius}"
        stroke-dasharray="${filled.toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 32 32)"/>
      <text x="32" y="32" dy="0.35em" text-anchor="middle" ${r.percent >= 100 ? 'class="long"' : ''}>${r.percent > 999 ? '999+' : r.percent}%</text>
    </svg>
    <span>${esc(text)}</span>
  </div>`;
}

const dot = (name) => `<span class="dot" style="background:${COLORS[name] ?? '#9A958C'}"></span>`;

/** Lista kategorii z paskami. Z limitem pasek pokazuje jego wykorzystanie. */
function categoriesCard(s) {
  // Limity dotyczą wszystkich kont razem – przy filtrze konta ich nie pokazujemy.
  const filtered = Boolean(ui.account);
  const rows = budgetRows(s, filtered ? {} : state.budgets);
  const max = Math.max(1, ...rows.filter((r) => !r.limit).map((r) => r.spent));
  const over = rows.filter((r) => r.level === 'over').length;
  const hasLimits = Object.keys(state.budgets).length > 0;
  const minus = Object.entries(s.byCategory).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  const row = (r) => {
    if (!r.limit) {
      return `<button type="button" class="cat-row" data-action="show-category" data-category="${esc(r.category)}">
        <span class="cat-top"><span class="cat-name">${dot(r.category)}${esc(r.category)}</span>
          <span>${esc(money.format(r.spent))}</span></span>
        <span class="bar"><span style="width:${Math.max(2, Math.round((r.spent / max) * 100))}%"></span></span>
      </button>`;
    }
    const note = r.level === 'over'
      ? `Przekroczony o ${money.format(-r.left)}`
      : `Zostało ${money.format(r.left)}`;
    return `<button type="button" class="cat-row" data-action="show-category" data-category="${esc(r.category)}">
      <span class="cat-top"><span class="cat-name">${dot(r.category)}${esc(r.category)}</span>
        <span>${esc(money.format(r.spent))} <span class="muted">z ${esc(limitMoney(r.limit))}</span></span></span>
      <span class="bar limit ${r.level}"><span style="width:${Math.max(2, Math.min(100, Math.round(r.ratio * 100)))}%"></span></span>
      <span class="limit-note ${r.level}">${esc(note)}</span>
    </button>`;
  };
  return `<section class="card">
    <div class="card-head"><h2>Kategorie</h2>
      ${filtered ? '' : `<button type="button" class="link-btn" data-action="edit-limits">${hasLimits ? 'Zmień limity' : 'Ustaw limity'}</button>`}
    </div>
    ${filtered && hasLimits ? '<p class="muted">Limity są liczone dla wszystkich kont razem – wybierz „Wszystkie konta”, żeby je zobaczyć.</p>' : ''}
    ${over ? `<p class="limit-alert">${over === 1 ? 'Jedna kategoria jest' : `${over} kategorie są`} ponad limitem.</p>` : ''}
    ${rows.length ? rows.map(row).join('') : '<p class="muted">Brak wydatków w tym miesiącu.</p>'}
    ${minus.length ? `<div class="minus-cats">
      <p class="limit-alert">Wpływy w kategoriach wydatków</p>
      <p class="muted">Te kategorie mają więcej wpływów (zwrotów) niż wydatków. Jeśli to przelewy z Twojego innego konta, zmień ich kategorię na „Przelewy własne”.</p>
      ${minus.map(([c, v]) => `<button type="button" class="cat-row" data-action="show-category" data-category="${esc(c)}">
        <span class="cat-top"><span class="cat-name">${dot(c)}${esc(c)}</span>
        <span class="plus">+${esc(money.format(-v))}</span></span></button>`).join('')}
    </div>` : ''}
  </section>`;
}

/** Edycja limitów: pole na kwotę przy każdej kategorii i średnia z 3 miesięcy. */
function limitsForm(month) {
  const avg = averageSpending(state, month);
  const fields = EXPENSE_CATEGORIES.map((c) => {
    const saved = state.budgets[c];
    const value = ui.limitDraft?.[c]
      ?? (saved ? (Number.isInteger(saved) ? String(saved) : saved.toFixed(2).replace('.', ',')) : '');
    return `<label class="limit-field">
      <span class="limit-label"><span class="cat-name">${dot(c)}${esc(c)}</span>
        <span class="muted">${avg[c] ? `średnio ${esc(money.format(avg[c]))} / mies.` : 'brak wydatków w ostatnich miesiącach'}</span></span>
      <span class="limit-input"><input class="text-input" type="text" inputmode="decimal" autocomplete="off"
        data-limit="${esc(c)}" value="${esc(value)}" placeholder="bez limitu" aria-label="Limit: ${esc(c)}"> zł</span>
    </label>`;
  }).join('');
  return `<form class="card" data-action="limits-form" novalidate>
    <h2>Miesięczne limity</h2>
    <p class="muted">Ile chcesz wydawać w miesiącu na każdą kategorię. Puste pole – bez limitu. Średnie liczone są z ostatnich pełnych miesięcy.</p>
    ${fields}
    ${ui.message ? `<div class="msg ${ui.message.kind}" role="alert">${esc(ui.message.text)}</div>` : ''}
    <button type="submit" class="btn">Zapisz limity</button>
    <button type="button" class="btn secondary" data-action="cancel-limits">Anuluj</button>
  </form>`;
}

function pulpitView() {
  const month = currentMonth();
  if (!month) return `<header><span class="eyebrow">Dinero</span><h1>Pulpit</h1></header>${emptyView()}`;
  const filter = accountFilter();
  const view = forAccount(state, ui.account);
  const s = monthSummary(view, month);
  const review = view.transactions.filter((t) => t.date.startsWith(month) && t.needsReview).length;
  return `
  ${ui.message && !ui.editLimits ? `<div class="msg ${ui.message.kind}">${esc(ui.message.text)}</div>` : ''}
  <header class="head-row">
    <div><span class="eyebrow">Wydatki</span><h1>${esc(monthLabel(month))}</h1></div>
    ${monthNav()}
  </header>
  ${filter}
  <section class="hero">
    <span class="label">Wydałaś w tym miesiącu</span>
    <span class="big">${esc(money.format(Math.max(0, s.spent)))}</span>
    <span class="sub">Wpływy: ${esc(money.format(s.income))}</span>
    ${incomeRing(s, month)}
  </section>
  ${s.neutral ? `<p class="muted">Przelewy między Twoimi kontami (${esc(money.format(s.neutral))}) nie liczą się do wydatków ani wpływów.</p>` : ''}
  ${state.settings.ownerNames.length ? '' : `<section class="card">
    <p>Wpisz swoje imię i nazwisko, żeby przelewy między Twoimi kontami nie liczyły się jako wydatki.</p>
    <button type="button" class="btn secondary" data-action="go" data-view="ustawienia">Przejdź do ustawień</button>
  </section>`}
  ${review ? `<button type="button" class="badge" data-action="review">${review} do sprawdzenia →</button>` : ''}
  ${ui.editLimits ? limitsForm(month) : categoriesCard(s)}`;
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
  const filter = accountFilter();
  const showAccount = !ui.account && accounts(state).length + (hasUnnamedAccount(state) ? 1 : 0) > 1;
  const list = forAccount(state, ui.account).transactions
    .filter((t) => t.date.startsWith(month) && (!ui.onlyReview || t.needsReview) &&
      (!ui.category || t.category === ui.category));
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
            ${showAccount && t.account ? `<span class="tx-account">${esc(t.account)}</span>` : ''}
            ${categorySelect(t)}
            ${t.needsReview ? `<span class="review">Do sprawdzenia</span>
              <button type="button" class="confirm-btn" data-action="confirm-category" data-id="${esc(t.id)}">Zostaw „${esc(t.category)}”</button>` : ''}
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
  ${filter}
  ${ui.category ? `<div class="chip-row"><span class="chip">${dot(ui.category)}${esc(ui.category)}</span>
    <button type="button" class="link-btn" data-action="clear-category">Pokaż wszystkie</button></div>` : ''}
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
    const known = accounts(state).map((a) => `<option value="${esc(a)}"></option>`).join('');
    details = `
    <section class="card">
      <div><h2>${esc(p.fileName)}</h2>
      <p class="muted">${r.transactions.length} transakcji · ${r.encoding === 'Excel' ? 'plik Excel' : `kodowanie ${esc(r.encoding)}`}</p></div>
      <label class="field stacked">Nazwa konta (np. „ING”, „Konto wspólne”)
        <input id="import-label" class="text-input" type="text" maxlength="40" autocomplete="off" list="known-accounts"
          data-action="import-label" value="${esc(r.label)}" placeholder="${r.accounts.length ? 'opcjonalnie' : 'np. ING'}">
        <datalist id="known-accounts">${known}</datalist>
      </label>
      <p class="muted">Przy kolejnych wyciągach z tego konta wpisuj tę samą nazwę – wtedy wydatki można oglądać osobno dla każdego konta.</p>
      ${r.accounts.length ? `<p class="muted">Konta w pliku: ${r.accounts.map(esc).join(', ')}</p>` : ''}
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
    <strong>Wybierz plik CSV lub Excel</strong>
    <span class="muted">Historia konta pobrana z aplikacji lub strony banku</span>
    <input class="visually-hidden" type="file" data-action="file"
      accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
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
    <label for="ai-token" class="muted">Kod dostępu do AI. Bez niego AI nie działa. Kod zostaje tylko w tym telefonie i nie trafia do kopii zapasowej.</label>
    <input id="ai-token" class="text-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(state.settings.aiToken)}" placeholder="dn-…">
    <button type="button" class="btn" data-action="save-token">Zapisz kod</button>
    <button type="button" class="btn secondary" data-action="gen-token">Wygeneruj nowy kod</button>
    <p class="muted">Wygenerowany kod trzeba jeszcze dodać na serwerze AI (zrobi to osoba, która nim zarządza).</p>
    <label class="toggle">Czat o wydatkach
      <input type="checkbox" data-action="chat-toggle" ${state.settings.chatEnabled ? 'checked' : ''}></label>
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
  </section>
  <section class="card">
    <h2>Aplikacja</h2>
    <p class="muted">Wersja ${APP_VERSION}. Odświeżenie pobiera najnowszą wersję aplikacji – Twoje dane zostają nietknięte.</p>
    <button type="button" class="btn secondary" data-action="refresh-app" ${ui.refreshing ? 'disabled' : ''}>
      ${ui.refreshing ? 'Sprawdzam…' : 'Odśwież aplikację'}</button>
  </section>`;
}

function czatView() {
  const header = '<header><span class="eyebrow">Asystent</span><h1>Czat o wydatkach</h1></header>';
  if (!state.settings.chatEnabled) {
    return `${header}
    <section class="card">
      <h2>Jak to działa</h2>
      <p>Zadajesz pytania o swoje wydatki, a AI (Claude) odpowiada na podstawie Twoich transakcji.</p>
      <p class="muted">Przy każdym pytaniu do AI wysyłane są przez serwer pośredniczący transakcje z wybranego okresu: data, kwota, nazwa sklepu i kategoria, oraz podsumowania miesięcy. Nie są wysyłane numery kont, tytuły ani nazwiska – przelewy trafiają jako „przelew przychodzący/wychodzący”, a przelewy między Twoimi kontami są pomijane. Serwer niczego nie zapisuje; rozmowa zostaje tylko w tym telefonie.</p>
      <button type="button" class="btn" data-action="chat-enable">Rozumiem, włącz czat</button>
    </section>`;
  }
  if (!state.settings.aiToken) {
    return `${header}<section class="card"><p>Do czatu potrzebny jest kod dostępu do AI.</p>
      <button type="button" class="btn secondary" data-action="go" data-view="ustawienia">Przejdź do ustawień</button></section>`;
  }
  if (!state.transactions.length) return `${header}${emptyView()}`;
  const options = [1, 3, 6, 12].map(
    (m) => `<option value="${m}" ${state.settings.chatMonths === m ? 'selected' : ''}>${m === 1 ? 'ostatni miesiąc' : `ostatnie ${m} mies.`}</option>`
  ).join('');
  const bubbles = ui.chat.map((m) =>
    `<div class="bubble ${m.role}">${m.role === 'assistant' ? formatReply(m.content) : esc(m.content)}</div>`).join('');
  const chips = ui.chat.length ? '' : `<div class="chips">${SUGGESTIONS.map(
    (q) => `<button type="button" class="chip" data-action="chat-suggest" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  return `${header}
  <label class="field">Dane z okresu<select data-action="chat-months">${options}</select></label>
  <div class="chat" aria-live="polite">${bubbles}${ui.chatBusy ? '<div class="bubble assistant pending">Liczę…</div>' : ''}</div>
  ${chips}
  ${ui.chatError ? `<div class="msg err">${esc(ui.chatError.text)}</div>` : ''}
  <form class="composer" data-action="chat-form">
    <label class="visually-hidden" for="chat-input">Twoje pytanie</label>
    <textarea id="chat-input" rows="1" placeholder="Zapytaj o wydatki…" ${ui.chatBusy ? 'disabled' : ''}>${esc(ui.chatError?.draft ?? '')}</textarea>
    <button type="submit" class="btn" ${ui.chatBusy ? 'disabled' : ''}>Wyślij</button>
  </form>
  ${ui.chat.length ? '<button type="button" class="btn secondary" data-action="chat-clear">Wyczyść rozmowę</button>' : ''}`;
}

function render() {
  const views = { pulpit: pulpitView, transakcje: transakcjeView, czat: czatView, import: importView, ustawienia: ustawieniaView };
  app.innerHTML = views[ui.view]();
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.view === ui.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

function go(view) {
  if (view !== ui.view) {
    ui.message = null;
    ui.editLimits = false;
    ui.limitDraft = null;
  }
  ui.view = view;
  render();
  window.scrollTo(0, 0);
}

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) {
    ui.category = null;
    go(btn.dataset.view);
  }
});

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'go') go(el.dataset.view);
  if (action === 'confirm-category') {
    // Wybranie z listy tej samej kategorii nie wywołuje zmiany – stąd przycisk.
    const tx = state.transactions.find((t) => t.id === el.dataset.id);
    if (tx) {
      state = setCategory(state, tx.id, tx.category, ui.rememberRules);
      persist();
      render();
    }
  }
  if (action === 'show-category') {
    ui.category = el.dataset.category;
    ui.onlyReview = false;
    go('transakcje');
  }
  if (action === 'clear-category') {
    ui.category = null;
    render();
  }
  if (action === 'edit-limits') {
    ui.editLimits = true;
    ui.limitDraft = null;
    ui.message = null;
    render();
  }
  if (action === 'cancel-limits') {
    ui.editLimits = false;
    ui.limitDraft = null;
    ui.message = null;
    render();
  }
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
    const { state: next, added, duplicates, updated } = mergeTransactions(state, ui.pending.result.transactions);
    state = next;
    if (persist()) {
      ui.message = {
        kind: 'ok',
        text: `Dodano ${added} transakcji.${updated ? ` Poprawiono ${updated} wcześniej wczytanych.` : ''}${
          duplicates ? ` Pominięto ${duplicates} już wczytanych.` : ''}`
      };
    }
    ui.pending = null;
    ui.month = null;
    ui.account = null;
    render();
    if (aiReady()) runAI();
  }
  if (action === 'ai') runAI();
  if (action === 'backup') saveBackup();
  if (action === 'refresh-app') refreshApp();
  if (action === 'chat-enable') {
    state = setChatSettings(state, { enabled: true });
    persist();
    render();
  }
  if (action === 'chat-suggest') sendChat(el.dataset.text);
  if (action === 'chat-clear') {
    ui.chat = [];
    ui.chatError = null;
    saveChat(window.localStorage, ui.chat);
    render();
  }
  if (action === 'gen-token') {
    document.getElementById('ai-token').value = generateAccessCode();
  }
  if (action === 'save-token') {
    state = setAiToken(state, document.getElementById('ai-token').value);
    if (persist()) ui.message = { kind: 'ok', text: 'Kod dostępu zapisany.' };
    render();
  }
  if (action === 'save-owner') {
    const input = document.getElementById('owner-names');
    state = setOwnerNames(state, input.value.split(','));
    if (persist()) ui.message = { kind: 'ok', text: 'Zapisano. Kategorie zostały przeliczone.' };
    render();
  }
  if (action === 'wipe' && window.confirm('Na pewno usunąć wszystkie dane z tego telefonu?')) {
    state = emptyState();
    ui.account = null;
    ui.chat = [];
    saveChat(window.localStorage, ui.chat);
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
  if (action === 'chat-toggle') {
    state = setChatSettings(state, { enabled: el.checked });
    persist();
  }
  if (action === 'chat-months') {
    state = setChatSettings(state, { months: Number(el.value) });
    persist();
  }
  if (action === 'ai-toggle') {
    state = setAiEnabled(state, el.checked);
    persist();
  }
  if (action === 'only-review') {
    ui.onlyReview = el.checked;
    render();
  }
  if (action === 'account') {
    ui.account = el.value || null;
    render();
  }
  if (action === 'import-label' && ui.pending) {
    const r = ui.pending.result;
    ui.pending.result = analyzeRows(r.rows, r.mapping, { encoding: r.encoding, delimiter: r.delimiter, label: el.value });
    render();
  }
  if (action === 'file' && el.files[0]) {
    const file = el.files[0];
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      ui.pending = { fileName: file.name, result: await readFile(bytes) };
      ui.message = null;
    } catch (err) {
      ui.pending = null;
      const known = err instanceof Error && /\.xls|Excel|przeglądarka|za duży/.test(err.message);
      ui.message = {
        kind: 'err',
        text: known ? err.message : 'Nie udało się odczytać pliku. Czy to na pewno CSV lub Excel z banku?'
      };
    }
    render();
  }
  if (action === 'map' && ui.pending) {
    const r = ui.pending.result;
    const mapping = { ...r.mapping, [el.dataset.key]: el.value === '' ? null : Number(el.value) };
    ui.pending.result = analyzeRows(r.rows, mapping, { encoding: r.encoding, delimiter: r.delimiter, label: r.label });
    render();
  }
  if (action === 'restore' && el.files[0]) {
    try {
      const restored = importBackup(await el.files[0].text());
      if (window.confirm(`Zastąpić obecne dane kopią (${restored.transactions.length} transakcji)?`)) {
        state = setAiToken(restored, state.settings.aiToken);
        if (persist()) ui.message = { kind: 'ok', text: 'Dane odtworzone z kopii.' };
      }
    } catch {
      ui.message = { kind: 'err', text: 'To nie jest kopia zapasowa z tej aplikacji.' };
    }
    render();
  }
});

app.addEventListener('submit', (e) => {
  if (e.target.dataset.action === 'limits-form') {
    e.preventDefault();
    saveLimits(e.target);
    return;
  }
  if (e.target.dataset.action !== 'chat-form') return;
  e.preventDefault();
  sendChat(document.getElementById('chat-input').value);
});

function saveLimits(form) {
  const limits = {};
  const wrong = [];
  const draft = {};
  for (const input of form.querySelectorAll('[data-limit]')) {
    const raw = input.value.trim();
    draft[input.dataset.limit] = raw;
    const value = raw === '' ? null : parseAmount(raw);
    if (raw !== '' && (value === null || value < 0)) wrong.push(input.dataset.limit);
    limits[input.dataset.limit] = value;
  }
  if (wrong.length) {
    // Wpisane kwoty zostają w formularzu – poprawia się tylko błędne pole.
    ui.limitDraft = draft;
    ui.message = { kind: 'err', text: `Popraw kwotę: ${wrong.join(', ')}. Wpisz samą liczbę, np. 800 albo 450,50.` };
    render();
    return;
  }
  state = setBudgets(state, limits);
  if (persist()) ui.message = { kind: 'ok', text: 'Limity zapisane.' };
  ui.editLimits = false;
  ui.limitDraft = null;
  render();
  window.scrollTo(0, 0);
}

app.addEventListener('keydown', (e) => {
  // Enter wysyła, Shift+Enter robi nową linię (na klawiaturze komputera).
  if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChat(e.target.value);
  }
});

/**
 * Wymusza pobranie najnowszej wersji: sprawdza service worker i przeładowuje
 * stronę. Dane w localStorage nie są ruszane.
 */
async function refreshApp() {
  ui.refreshing = true;
  render();
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.update();
  } catch {
    // Bez sieci update się nie uda – przeładowanie i tak pokaże wersję z pamięci.
  }
  window.location.reload();
}

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

document.querySelector('.tabbar button[data-view="czat"]').hidden = !AI_URL;
render();
