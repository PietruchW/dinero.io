// Podpowiedzi kategorii od AI. Wysyłamy wyłącznie nazwę sklepu i kwotę –
// bez dat, numerów kont, tytułów i bez przelewów (do osób też nie).
// Wynik zapisujemy jako reguły per sklep, więc ten sam sklep nie idzie do AI drugi raz.

import { CATEGORIES, merchantKey } from './categorize.js';
import { normalize } from './detect.js';
import { recategorize } from './store.js';

const AI_CATEGORIES = new Set(CATEGORIES.filter((c) => c !== 'Przychód' && c !== 'Przelewy własne'));
export const MAX_ITEMS = 40;

function isTransfer(tx) {
  return /\bprzelew/.test(normalize(`${tx.name} ${tx.title ?? ''}`));
}

/**
 * Sklepy do wysłania: nierozpoznane wydatki, bez przelewów i bez sklepów,
 * dla których jest już reguła. Każdy sklep raz.
 * @returns {{id: string, name: string, amount: number}[]}
 */
export function selectForAI(state, max = MAX_ITEMS) {
  const seen = new Set();
  const items = [];
  for (const t of state.transactions) {
    if (items.length >= max) break;
    if (!t.needsReview || t.manual || t.amount >= 0 || isTransfer(t)) continue;
    const key = merchantKey(t.name);
    if (!key || seen.has(key) || state.rules[key] || state.aiRules?.[key]) continue;
    seen.add(key);
    items.push({ id: key, name: t.name, amount: t.amount });
  }
  return items;
}

/**
 * Zapisuje podpowiedzi jako reguły AI i przelicza kategorie.
 * Kategoria „Inne” też jest zapisywana – żeby nie pytać ponownie o ten sam sklep.
 * @param {{id: string, category: string}[]} results
 * @returns {{state: object, applied: number}}
 */
export function applyAIResults(state, results) {
  const aiRules = { ...(state.aiRules ?? {}) };
  let applied = 0;
  for (const r of results) {
    if (!r || typeof r.id !== 'string' || !AI_CATEGORIES.has(r.category)) continue;
    aiRules[r.id] = r.category;
    if (r.category !== 'Inne') applied += 1;
  }
  return { state: recategorize({ ...state, aiRules }), applied };
}

const ERRORS = {
  403: 'Pośrednik AI odrzucił zapytanie (zły adres aplikacji).',
  429: 'Za dużo zapytań do AI. Spróbuj za minutę.',
  503: 'Pośrednik AI nie ma jeszcze ustawionego klucza.'
};

/**
 * Pyta pośrednika o kategorie.
 * @param {string} url adres Workera
 * @param {{id: string, name: string, amount: number}[]} items
 */
export async function requestCategories(url, items, fetchImpl = fetch, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/$/, '')}/categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
      signal: controller.signal
    });
  } catch {
    throw new Error('Brak połączenia z AI. Sprawdź internet i spróbuj ponownie.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(ERRORS[res.status] ?? 'AI chwilowo nie odpowiada. Spróbuj później.');
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}
