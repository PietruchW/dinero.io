// Stan aplikacji i jego zapis. Dane leżą wyłącznie w pamięci przeglądarki
// na urządzeniu użytkowniczki (localStorage). Nic nie jest wysyłane.

import { categorize, merchantKey, isOwner, CATEGORIES, NEUTRAL } from './categorize.js';
import { normalize } from './detect.js';

export const STORAGE_KEY = 'dinero.v1';

/** Kategorie, którym można ustawić limit (bez wpływów i przelewów własnych). */
export const EXPENSE_CATEGORIES = CATEGORIES.filter((c) => c !== 'Przychód' && !NEUTRAL.has(c));
const VERSION = 1;

export function emptyState() {
  return {
    version: VERSION, transactions: [], rules: {}, aiRules: {}, budgets: {}, goals: [],
    settings: { ownerNames: [], aiEnabled: false, aiToken: '', chatEnabled: false, chatMonths: 3 }
  };
}

/**
 * Wczytuje stan. Uszkodzony lub obcy zapis nie wysadza aplikacji –
 * wtedy startujemy od pustego stanu, a stary zapis zostaje nietknięty.
 * @param {{getItem(k: string): string|null}} storage
 */
export function loadState(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    return validateState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

/** @param {{setItem(k: string, v: string): void}} storage */
export function saveState(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function validateState(data) {
  if (!data || typeof data !== 'object' || data.version !== VERSION || !Array.isArray(data.transactions)) {
    throw new Error('Nieprawidłowy format danych');
  }
  const txOk = (t) =>
    t && typeof t.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && typeof t.amount === 'number' &&
    typeof t.name === 'string' && CATEGORIES.includes(t.category);
  if (!data.transactions.every(txOk)) throw new Error('Nieprawidłowe transakcje');
  return {
    version: VERSION,
    transactions: data.transactions.map(fixAccountName),
    rules: data.rules && typeof data.rules === 'object' ? data.rules : {},
    // Pola dodane po pierwszej wersji – stare zapisy ich nie mają.
    aiRules: cleanRules(data.aiRules),
    budgets: cleanBudgets(data.budgets),
    goals: Array.isArray(data.goals) ? data.goals : [],
    settings: {
      ownerNames: Array.isArray(data.settings?.ownerNames)
        ? data.settings.ownerNames.filter((n) => typeof n === 'string')
        : [],
      aiEnabled: data.settings?.aiEnabled === true,
      aiToken: typeof data.settings?.aiToken === 'string' ? data.settings.aiToken : '',
      chatEnabled: data.settings?.chatEnabled === true,
      chatMonths: [1, 3, 6, 12].includes(data.settings?.chatMonths) ? data.settings.chatMonths : 3
    }
  };
}

/**
 * Nazwy kont z pierwszej wersji importu BNP („BNP · Konto Osobiste •5424”,
 * „BNP · Karta Otwarta na Dzisiaj •5424”) → jedno konto „BNP •5424”.
 * Zmienia tylko podpis; identyfikatory zostają.
 */
function fixAccountName(t) {
  const m = typeof t.account === 'string' ? t.account.match(/^(.+?) · .+ •(\d{4})$/) : null;
  return m ? { ...t, account: `${m[1]} •${m[2]}` } : t;
}

/** Limity: tylko kategorie wydatków i dodatnie kwoty – reszta jest pomijana. */
function cleanBudgets(budgets) {
  if (!budgets || typeof budgets !== 'object') return {};
  return Object.fromEntries(
    Object.entries(budgets).filter(
      ([k, v]) => EXPENSE_CATEGORIES.includes(k) && typeof v === 'number' && Number.isFinite(v) && v > 0
    )
  );
}

function cleanRules(rules) {
  if (!rules || typeof rules !== 'object') return {};
  return Object.fromEntries(
    Object.entries(rules).filter(([k, v]) => typeof k === 'string' && CATEGORIES.includes(v))
  );
}

function ownerNames(state) {
  return state.settings?.ownerNames ?? [];
}

/**
 * Dokłada transakcje z importu. Te, które już są (ten sam identyfikator),
 * pomija – można bezpiecznie wczytać zachodzące na siebie wyciągi.
 * Transakcję wczytaną starszą wersją (inny identyfikator, `legacyIds`) też
 * rozpoznaje jako już wczytaną i poprawia w niej to, co nowy import czyta
 * lepiej: kontrahenta, tytuł, nazwę konta i – jeśli nie była zmieniona
 * ręcznie – kategorię. Identyfikator zostaje stary.
 * @returns {{state: object, added: number, duplicates: number, updated: number}}
 */
export function mergeTransactions(state, incoming) {
  const known = new Set(state.transactions.map((t) => t.id));
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  const patches = new Map();
  const fresh = [];
  let duplicates = 0;
  // Import bez nazwy konta nie przeczy żadnemu kontu – pasuje do każdego.
  const sameAccount = (old, tx) => !old.account || !tx.account || normalize(old.account) === normalize(tx.account);
  for (const { legacyIds = [], legacyId, ...tx } of incoming) {
    if (known.has(tx.id)) {
      duplicates += 1;
      continue;
    }
    const oldId = [...legacyIds, ...(legacyId ? [legacyId] : [])]
      .find((id) => byId.has(id) && !patches.has(id) && sameAccount(byId.get(id), tx));
    if (oldId) {
      patches.set(oldId, tx);
      continue;
    }
    known.add(tx.id);
    const { category, needsReview, source } = categorize(tx, state.rules, ownerNames(state), state.aiRules);
    fresh.push({ ...tx, category, needsReview, source, manual: false });
  }
  let updated = 0;
  const existing = state.transactions.map((t) => {
    const tx = patches.get(t.id);
    if (!tx) return t;
    const next = { ...t, name: tx.name, title: tx.title };
    if (!t.account && tx.account) next.account = tx.account;
    if (next.name !== t.name || next.title !== t.title) {
      if (!t.manual) Object.assign(next, categorize(next, state.rules, ownerNames(state), state.aiRules));
    }
    const changed = next.name !== t.name || next.title !== t.title || next.account !== t.account ||
      next.category !== t.category;
    if (changed) updated += 1;
    else duplicates += 1;
    return changed ? next : t;
  });
  const transactions = [...existing, ...fresh].sort((a, b) =>
    a.date === b.date ? 0 : a.date < b.date ? 1 : -1
  );
  return { state: { ...state, transactions }, added: fresh.length, duplicates, updated };
}

/** Wartość filtra dla transakcji wczytanych bez nazwy konta. */
export const NO_ACCOUNT = '__bez-konta__';

/** Czy są transakcje bez nazwy konta (wczytane przed dodaniem kont). */
export function hasUnnamedAccount(state) {
  return state.transactions.some((t) => !t.account);
}

/** Nazwy kont występujące w danych, alfabetycznie. */
export function accounts(state) {
  return [...new Set(state.transactions.map((t) => t.account).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pl'));
}

/**
 * Widok stanu ograniczony do jednego konta (null = wszystkie). Tylko do
 * wyświetlania – nie zapisywać wyniku.
 */
export function forAccount(state, account) {
  if (!account) return state;
  if (account === NO_ACCOUNT) return { ...state, transactions: state.transactions.filter((t) => !t.account) };
  return { ...state, transactions: state.transactions.filter((t) => t.account === account) };
}

/**
 * Zmienia kategorię transakcji. Z `remember` zapisuje regułę dla sklepu
 * i przestawia jego pozostałe transakcje, oprócz tych zmienionych ręcznie.
 */
export function setCategory(state, txId, category, remember = false) {
  if (!CATEGORIES.includes(category)) throw new Error(`Nieznana kategoria: ${category}`);
  const target = state.transactions.find((t) => t.id === txId);
  if (!target) return state;
  // Dla przelewów z udziałem samej właścicielki nie zapamiętujemy reguły –
  // zmienia się tylko ta jedna transakcja (reguła złapałaby wszystkie
  // przelewy między jej kontami, w obie strony).
  const key = isOwner(target.name, ownerNames(state)) ? '' : merchantKey(target.name);
  const rules = remember && key ? { ...state.rules, [key]: category } : state.rules;
  const transactions = state.transactions.map((t) => {
    if (t.id === txId) return { ...t, category, needsReview: false, manual: true, source: 'user' };
    if (remember && key && !t.manual && merchantKey(t.name) === key) {
      return { ...t, category, needsReview: false, source: 'user' };
    }
    return t;
  });
  return { ...state, rules, transactions };
}

/**
 * Ustawia imiona i nazwiska właścicielki kont i na nowo przypisuje kategorie
 * wszystkim transakcjom poza zmienionymi ręcznie.
 * @param {string[]} names
 */
export function setOwnerNames(state, names) {
  const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  const next = { ...state, settings: { ...state.settings, ownerNames: clean } };
  return recategorize(next);
}

/** Zapisuje kod dostępu do pośrednika AI (tylko w tym telefonie). */
export function setAiToken(state, token) {
  return { ...state, settings: { ...state.settings, aiToken: String(token ?? '').trim() } };
}

/** Ustawienia czatu: włączenie (zgoda) i okres danych wysyłanych do AI. */
export function setChatSettings(state, { enabled, months }) {
  const settings = { ...state.settings };
  if (enabled !== undefined) settings.chatEnabled = enabled === true;
  if ([1, 3, 6, 12].includes(months)) settings.chatMonths = months;
  return { ...state, settings };
}

/**
 * Ustawia miesięczne limity kategorii. Pusta, zerowa lub ujemna kwota
 * usuwa limit. Kwoty zaokrąglone do groszy.
 * @param {Record<string, number|null>} limits kategoria → kwota
 */
export function setBudgets(state, limits) {
  const budgets = { ...state.budgets };
  for (const [category, value] of Object.entries(limits)) {
    if (!EXPENSE_CATEGORIES.includes(category)) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      budgets[category] = Math.round(value * 100) / 100;
    } else {
      delete budgets[category];
    }
  }
  return { ...state, budgets };
}

/**
 * Wiersze kategorii na pulpit: wydane, limit i stopień jego wykorzystania.
 * Kategorie z limitem są zawsze (także bez wydatków), pozostałe – gdy coś wydano.
 * Kolejność: od największych wydatków.
 * @param {{byCategory: Record<string, number>}} summary wynik monthSummary
 * @param {Record<string, number>} budgets
 */
export function budgetRows(summary, budgets = {}) {
  const names = new Set([
    ...Object.keys(summary.byCategory).filter((c) => summary.byCategory[c] > 0),
    ...Object.keys(budgets).filter((c) => budgets[c] > 0)
  ]);
  return [...names]
    .map((category) => {
      const spent = Math.max(0, summary.byCategory[category] ?? 0);
      const limit = budgets[category] ?? null;
      if (!limit) return { category, spent, limit: null, ratio: null, left: null, level: null };
      const ratio = spent / limit;
      return {
        category, spent, limit, ratio,
        left: Math.round((limit - spent) * 100) / 100,
        level: ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok'
      };
    })
    .sort((a, b) => b.spent - a.spent || (b.limit ?? 0) - (a.limit ?? 0));
}

/**
 * Średnie miesięczne wydatki w kategoriach z `count` pełnych miesięcy przed
 * podanym (bez niego – bieżący zwykle jest niepełny). Podpowiedź przy limitach.
 * @returns {Record<string, number>}
 */
export function averageSpending(state, month, count = 3) {
  const prior = months(state).filter((m) => m < month).slice(0, count);
  if (!prior.length) return {};
  const totals = {};
  for (const m of prior) {
    for (const [c, v] of Object.entries(monthSummary(state, m).byCategory)) {
      if (v > 0) totals[c] = (totals[c] ?? 0) + v;
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([c, v]) => [c, Math.round(v / prior.length)]));
}

/** Włącza lub wyłącza podpowiedzi AI. */
export function setAiEnabled(state, enabled) {
  return { ...state, settings: { ...state.settings, aiEnabled: enabled === true } };
}

/** Ponowne przypisanie kategorii (np. po zmianie ustawień); ręczne wybory zostają. */
export function recategorize(state) {
  const transactions = state.transactions.map((t) => {
    if (t.manual) return t;
    const { category, needsReview, source } = categorize(t, state.rules, ownerNames(state), state.aiRules);
    return { ...t, category, needsReview, source };
  });
  return { ...state, transactions };
}

/**
 * Podsumowanie miesiąca ("RRRR-MM"): wydatki per kategoria (liczby dodatnie;
 * zwroty pomniejszają kategorię), suma wydatków i przychód. Przelewy własne
 * nie liczą się ani do wydatków, ani do wpływów (osobno w `neutral`).
 */
export function monthSummary(state, month) {
  const byCategory = {};
  let income = 0;
  let neutral = 0;
  for (const t of state.transactions) {
    if (!t.date.startsWith(month)) continue;
    if (NEUTRAL.has(t.category)) {
      neutral += Math.abs(t.amount);
      continue;
    }
    if (t.category === 'Przychód') {
      income += t.amount;
      continue;
    }
    byCategory[t.category] = (byCategory[t.category] ?? 0) - t.amount;
  }
  for (const k of Object.keys(byCategory)) byCategory[k] = Math.round(byCategory[k] * 100) / 100;
  const spent = Math.round(Object.values(byCategory).reduce((a, b) => a + b, 0) * 100) / 100;
  return { month, byCategory, spent, income: Math.round(income * 100) / 100, neutral: Math.round(neutral * 100) / 100 };
}

/**
 * Jaką część wpływów miesiąca już wydano – do pierścienia na pulpicie.
 * null, gdy w miesiącu nie było wpływów (np. przed wypłatą albo na koncie,
 * na które nic nie wpływa) – wtedy nie ma z czym porównać.
 * @param {{spent: number, income: number}} summary wynik monthSummary
 */
export function spendingRatio(summary) {
  if (!(summary.income > 0) || summary.spent < 0) return null;
  const ratio = summary.spent / summary.income;
  return {
    ratio,
    percent: Math.round(ratio * 100),
    left: Math.round((summary.income - summary.spent) * 100) / 100,
    level: ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok'
  };
}

/** Miesiące z danymi, od najnowszego. */
export function months(state) {
  return [...new Set(state.transactions.map((t) => t.date.slice(0, 7)))].sort().reverse();
}

/** Kopia zapasowa jako tekst JSON. Kod dostępu do AI nie trafia do kopii. */
export function exportBackup(state) {
  const settings = { ...state.settings, aiToken: '' };
  return JSON.stringify({ app: 'dinero', exportedAt: new Date().toISOString(), ...state, settings }, null, 2);
}

/** Odtworzenie z kopii; rzuca błąd przy pliku, który nie jest kopią z tej aplikacji. */
export function importBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'dinero') throw new Error('To nie jest kopia zapasowa tej aplikacji');
  const { app, exportedAt, ...rest } = data;
  return validateState(rest);
}
