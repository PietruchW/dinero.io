// Podpowiedzi kategorii od AI. Wysyłamy wyłącznie nazwę sklepu i kwotę –
// bez dat, numerów kont, tytułów i bez przelewów (do osób też nie).
// Wynik zapisujemy jako reguły per sklep, więc ten sam sklep nie idzie do AI drugi raz.

import { CATEGORIES, merchantKey } from './categorize.js';
import { normalize } from './detect.js';
import { recategorize, monthSummary, setCategory, months as monthList } from './store.js';

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
 * Bez tytułów, numerów kont i identyfikatorów – każda transakcja ma tylko numer porządkowy
 * („t1”, „t2”…), po którym czat może zaproponować zmianę kategorii. Mapa numerów na
 * transakcje (`refs`) zostaje w telefonie – przed wysłaniem trzeba ją odjąć.
 */
export function buildChatContext(state, monthsBack = 3, today = new Date().toISOString().slice(0, 10)) {
  const all = monthList(state);
  const chosen = all.slice(0, Math.max(1, monthsBack)).sort();
  const summary = {};
  for (const m of chosen) {
    const s = monthSummary(state, m);
    summary[m] = { spent: s.spent, income: s.income, saved: s.saved, byCategory: s.byCategory };
  }
  const inRange = new Set(chosen);
  const picked = state.transactions
    .filter((t) => inRange.has(t.date.slice(0, 7)) && t.category !== 'Przelewy własne')
    .slice(0, CHAT_MAX_TX);
  const refs = {};
  const transactions = picked.map((t, i) => {
    const ref = `t${i + 1}`;
    refs[ref] = t.id;
    return [
      t.date,
      t.amount,
      isTransfer(t) ? (t.amount > 0 ? 'przelew przychodzący' : 'przelew wychodzący') : t.name,
      t.category,
      ref
    ];
  });
  return { today, from: chosen[0] ?? '', to: chosen[chosen.length - 1] ?? '', summary, transactions, refs };
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
      // Tylko rola i treść – propozycje zmian (z identyfikatorami) zostają w telefonie.
      body: JSON.stringify({ messages: messages.slice(-20).map(({ role, content }) => ({ role, content })), context }),
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

const CHANGES_BLOCK = /<zmiany>([\s\S]*?)(?:<\/zmiany>|$)/i;
const MAX_CHANGES = 300;

/**
 * Rozdziela odpowiedź czatu na tekst i propozycje zmian kategorii. Czat dopisuje
 * je na końcu jako blok <zmiany>[{"ref":"t12","kategoria":"Edukacja"}]</zmiany>.
 * Zostają tylko zmiany dla znanych numerów, na istniejące kategorie i inne niż obecna.
 * @param {string} reply
 * @param {Record<string, string>} refs numer z kontekstu → id transakcji
 * @returns {{text: string, changes: {id: string, category: string}[]}}
 */
export function parseChatReply(reply, refs, state) {
  const match = reply.match(CHANGES_BLOCK);
  if (!match) return { text: reply.trim(), changes: [] };
  const text = reply.replace(match[0], '').trim();
  let list = [];
  try {
    list = JSON.parse(match[1].trim());
  } catch {
    list = [];
  }
  const byId = new Map(state.transactions.map((t) => [t.id, t]));
  const seen = new Set();
  const changes = [];
  for (const c of Array.isArray(list) ? list : []) {
    const ref = typeof c?.ref === 'string' && /^t\d{1,5}$/.test(c.ref) ? c.ref : null;
    const id = ref && Object.hasOwn(refs, ref) ? refs[ref] : null;
    const category = c?.kategoria ?? c?.category;
    const tx = id ? byId.get(id) : null;
    if (!tx || seen.has(id) || !CATEGORIES.includes(category) || tx.category === category) continue;
    seen.add(id);
    changes.push({ id, category });
    if (changes.length >= MAX_CHANGES) break;
  }
  return { text: text || (changes.length ? 'Proponuję takie zmiany kategorii:' : ''), changes };
}

/**
 * Zatwierdzone propozycje z czatu – każda jak ręczna zmiana kategorii.
 * Transakcje, których już nie ma, są pomijane.
 * @returns {{state: object, applied: number}}
 */
export function applyChatChanges(state, changes, remember = false) {
  let next = state;
  let applied = 0;
  for (const { id, category } of changes) {
    if (!next.transactions.some((t) => t.id === id) || !CATEGORIES.includes(category)) continue;
    next = setCategory(next, id, category, remember);
    applied += 1;
  }
  return { state: next, applied };
}

export const CHAT_KEY = 'dinero.chat.v1';

/** Historia czatu – osobno od danych, tylko w tym telefonie, najwyżej 30 wiadomości. */
export function loadChat(storage) {
  try {
    const data = JSON.parse(storage.getItem(CHAT_KEY) ?? '[]');
    if (!Array.isArray(data)) return [];
    return data
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => {
        const changes = Array.isArray(m.changes)
          ? m.changes.filter((c) => c && typeof c.id === 'string' && CATEGORIES.includes(c.category))
          : [];
        if (m.role !== 'assistant' || !changes.length) return { role: m.role, content: m.content };
        const status = ['pending', 'applied', 'rejected'].includes(m.status) ? m.status : 'pending';
        return { role: m.role, content: m.content, changes, status, ...(m.applied ? { applied: m.applied } : {}) };
      });
  } catch {
    return [];
  }
}

export function saveChat(storage, messages) {
  storage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-30)));
}
