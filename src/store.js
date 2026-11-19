// Stan aplikacji i jego zapis. Dane leżą wyłącznie w pamięci przeglądarki
// na urządzeniu użytkowniczki (localStorage). Nic nie jest wysyłane.

import { categorize, merchantKey, CATEGORIES, NEUTRAL } from './categorize.js';

export const STORAGE_KEY = 'dinero.v1';
const VERSION = 1;

export function emptyState() {
  return {
    version: VERSION, transactions: [], rules: {}, aiRules: {}, budgets: {}, goals: [],
    settings: { ownerNames: [], aiEnabled: false }
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
    transactions: data.transactions,
    rules: data.rules && typeof data.rules === 'object' ? data.rules : {},
    // Pola dodane po pierwszej wersji – stare zapisy ich nie mają.
    aiRules: cleanRules(data.aiRules),
    budgets: data.budgets && typeof data.budgets === 'object' ? data.budgets : {},
    goals: Array.isArray(data.goals) ? data.goals : [],
    settings: {
      ownerNames: Array.isArray(data.settings?.ownerNames)
        ? data.settings.ownerNames.filter((n) => typeof n === 'string')
        : [],
      aiEnabled: data.settings?.aiEnabled === true
    }
  };
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
 * @returns {{state: object, added: number, duplicates: number}}
 */
export function mergeTransactions(state, incoming) {
  const known = new Set(state.transactions.map((t) => t.id));
  const fresh = [];
  let duplicates = 0;
  for (const tx of incoming) {
    if (known.has(tx.id)) {
      duplicates += 1;
      continue;
    }
    known.add(tx.id);
    const { category, needsReview, source } = categorize(tx, state.rules, ownerNames(state), state.aiRules);
    fresh.push({ ...tx, category, needsReview, source, manual: false });
  }
  const transactions = [...state.transactions, ...fresh].sort((a, b) =>
    a.date === b.date ? 0 : a.date < b.date ? 1 : -1
  );
  return { state: { ...state, transactions }, added: fresh.length, duplicates };
}

/**
 * Zmienia kategorię transakcji. Z `remember` zapisuje regułę dla sklepu
 * i przestawia jego pozostałe transakcje, oprócz tych zmienionych ręcznie.
 */
export function setCategory(state, txId, category, remember = false) {
  if (!CATEGORIES.includes(category)) throw new Error(`Nieznana kategoria: ${category}`);
  const target = state.transactions.find((t) => t.id === txId);
  if (!target) return state;
  const key = merchantKey(target.name);
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

/** Miesiące z danymi, od najnowszego. */
export function months(state) {
  return [...new Set(state.transactions.map((t) => t.date.slice(0, 7)))].sort().reverse();
}

/** Kopia zapasowa jako tekst JSON. */
export function exportBackup(state) {
  return JSON.stringify({ app: 'dinero', exportedAt: new Date().toISOString(), ...state }, null, 2);
}

/** Odtworzenie z kopii; rzuca błąd przy pliku, który nie jest kopią z tej aplikacji. */
export function importBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'dinero') throw new Error('To nie jest kopia zapasowa tej aplikacji');
  const { app, exportedAt, ...rest } = data;
  return validateState(rest);
}
