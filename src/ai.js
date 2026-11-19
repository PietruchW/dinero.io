// Podpowiedzi kategorii od AI. Wysyłamy wyłącznie nazwę sklepu i kwotę –
// bez dat, numerów kont, tytułów i bez przelewów (do osób też nie).
// Wynik zapisujemy jako reguły per sklep, więc ten sam sklep nie idzie do AI drugi raz.

import { CATEGORIES, merchantKey } from './categorize.js';
import { normalize } from './detect.js';
import { recategorize, monthSummary, months as monthList } from './store.js';
import { NEUTRAL } from './categorize.js';

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
  401: 'Nieprawidłowy kod dostępu do AI. Sprawdź go w Ustawieniach.',
  403: 'Pośrednik AI odrzucił zapytanie (zły adres aplikacji).',
  429: 'Za dużo zapytań do AI. Spróbuj za minutę.',
  503: 'Pośrednik AI nie jest jeszcze skonfigurowany (klucz lub kody dostępu).'
};

/**
 * Pyta pośrednika o kategorie.
 * @param {string} url adres Workera
 * @param {{id: string, name: string, amount: number}[]} items
 * @param {string} token kod dostępu z Ustawień
 */
export async function requestCategories(url, items, token, fetchImpl = fetch, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/$/, '')}/categorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

/** Nowy losowy kod dostępu (ok. 144 bity losowości). */
export function generateAccessCode(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(18);
  cryptoImpl.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `dn-${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export const CHAT_MAX_TX = 2000;

/**
 * Dane do czatu z ostatnich `monthsBack` miesięcy (licząc od najnowszego miesiąca z danymi).
 * Bez przelewów własnych. Przelewy (np. do znajomych) bez nazwy odbiorcy – tylko kierunek.
 * Bez tytułów, numerów kont i identyfikatorów.
 */
export function buildChatContext(state, monthsBack = 3, today = new Date().toISOString().slice(0, 10)) {
  const all = monthList(state);
  const chosen = all.slice(0, Math.max(1, monthsBack)).sort();
  const summary = {};
  for (const m of chosen) {
    const s = monthSummary(state, m);
    summary[m] = { spent: s.spent, income: s.income, byCategory: s.byCategory };
  }
  const inRange = new Set(chosen);
  const transactions = state.transactions
    .filter((t) => inRange.has(t.date.slice(0, 7)) && !NEUTRAL.has(t.category))
    .slice(0, CHAT_MAX_TX)
    .map((t) => [
      t.date,
      t.amount,
      isTransfer(t) ? (t.amount > 0 ? 'przelew przychodzący' : 'przelew wychodzący') : t.name,
      t.category
    ]);
  return { today, from: chosen[0] ?? '', to: chosen[chosen.length - 1] ?? '', summary, transactions };
}

/**
 * Wysyła rozmowę do pośrednika i zwraca odpowiedź AI.
 * @param {{role: 'user'|'assistant', content: string}[]} messages
 */
export async function requestChat(url, token, messages, context, fetchImpl = fetch, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/$/, '')}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: messages.slice(-20), context }),
      signal: controller.signal
    });
  } catch {
    throw new Error('Brak połączenia z AI. Sprawdź internet i spróbuj ponownie.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(ERRORS[res.status] ?? 'AI chwilowo nie odpowiada. Spróbuj później.');
  const data = await res.json();
  if (typeof data.reply !== 'string' || !data.reply) throw new Error('AI nie odpowiedziało. Spróbuj ponownie.');
  return data.reply;
}

export const CHAT_KEY = 'dinero.chat.v1';

/** Historia czatu – osobno od danych, tylko w tym telefonie, najwyżej 30 wiadomości. */
export function loadChat(storage) {
  try {
    const data = JSON.parse(storage.getItem(CHAT_KEY) ?? '[]');
    return Array.isArray(data)
      ? data.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
  } catch {
    return [];
  }
}

export function saveChat(storage, messages) {
  storage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-30)));
}
