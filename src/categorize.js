// Przypisywanie kategorii: najpierw reguły użytkowniczki („Zapamiętaj dla…”),
// potem wbudowane słowa kluczowe. Wszystko lokalnie, bez sieci.

import { normalize } from './detect.js';

export const CATEGORIES = [
  'Jedzenie',
  'Wyjścia',
  'Zakupy',
  'Transport',
  'Kosmetyki i zdrowie',
  'Rachunki',
  'Subskrypcje',
  'Inne',
  'Przelewy własne',
  'Przychód'
];

// Kategorie, które nie są ani wydatkiem, ani wpływem (pieniądze tylko
// przechodzą między własnymi kontami).
export const NEUTRAL = new Set(['Przelewy własne']);

// Opisy, którymi banki oznaczają przelew między własnymi rachunkami.
const OWN_TRANSFER = ['przelew wlasny', 'przelew wewnetrzny', 'przelew miedzy rachunkami', 'przelew miedzy wlasnymi',
  'przeksiegowanie', 'transfer wlasny'];

// Kolejność ma znaczenie: bardziej szczegółowe wpisy (np. „uber eats”)
// muszą stać przed ogólnymi („uber”). Słowa po normalizacji (bez ogonków).
const KEYWORDS = [
  ['Wyjścia', ['uber eats', 'pyszne', 'glovo', 'wolt', 'bolt food', 'mcdonald', 'kfc', 'burger king', 'starbucks',
    'costa coffee', 'restauracja', 'pizz', 'sushi', 'kebab', 'kawiarnia', 'cafe', 'bistro', 'pub ', 'helios',
    'multikino', 'cinema city', 'ebilet']],
  ['Subskrypcje', ['netflix', 'spotify', 'apple.com', 'icloud', 'youtube', 'google one', 'disney', 'hbo', 'canal+',
    'chatgpt', 'openai', 'anthropic', 'claude.ai', 'amazon prime', 'audible', 'legimi', 'empik go', 'tidal', 'skyshowtime']],
  ['Jedzenie', ['lidl', 'biedronka', 'kaufland', 'aldi', 'auchan', 'carrefour', 'netto', 'zabka', 'dino', 'stokrotka',
    'frisco', 'lewiatan', 'polomarket', 'spar', 'intermarche', 'delikatesy', 'piekarnia', 'mieso', 'warzywa']],
  ['Kosmetyki i zdrowie', ['rossmann', 'hebe', 'sephora', 'douglas', 'super-pharm', 'superpharm', 'natura', 'notino',
    'inglot', 'apteka', 'doz', 'medicover', 'luxmed', 'lux med', 'enel-med', 'dentyst', 'fryzjer', 'kosmetycz']],
  ['Transport', ['orlen', 'bp ', 'shell', 'circle k', 'moya', 'amic', 'lotos', 'bolt', 'uber', 'freenow', 'free now',
    'pkp', 'intercity', 'skm', 'ztm', 'mpk', 'jakdojade', 'parking', 'skycash', 'koleo', 'flixbus']],
  ['Rachunki', ['orange', 'play ', 'p4 sp', 't-mobile', 'plus ', 'polkomtel', 'energa', 'pge', 'tauron', 'enea',
    'pgnig', 'upc', 'netia', 'vectra', 'czynsz', 'wspolnota', 'spoldzielnia']],
  ['Zakupy', ['allegro', 'zalando', 'amazon', 'h&m', 'zara', 'reserved', 'sinsay', 'mohito', 'pepco', 'action ', 'ikea',
    'jysk', 'ccc', 'decathlon', 'media expert', 'rtv euro', 'mediamarkt', 'shein', 'temu', 'aliexpress', 'vinted',
    'empik', 'smyk', 'tk maxx', 'deichmann', 'leroy', 'castorama', 'obi ']]
];

/**
 * Klucz sklepu do reguł „Zapamiętaj dla…”: pierwsze dwa znaczące słowa
 * nazwy kontrahenta, bez cyfr i form prawnych. „LIDL SP. Z O.O. 1234
 * GDANSK” → „lidl gdansk”.
 * @param {string} name
 */
export function merchantKey(name) {
  const stop = new Set(['sp', 'z', 'o', 'oo', 'sa', 's', 'k', 'spk', 'ul', 'pl', 'polska', 'poland', 'sklep', 'nr']);
  const words = normalize(name)
    .replace(/[^a-z\s&+-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w));
  return words.slice(0, 2).join(' ');
}

// Słowo musi zaczynać się na granicy wyrazu: „pizz” pasuje do „pizzeria”,
// ale „pge” nie pasuje do środka innego słowa.
function hasWord(haystack, word) {
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(word, from);
    if (idx === -1) return false;
    if (idx === 0 || !/[a-z0-9]/.test(haystack[idx - 1])) return true;
    from = idx + 1;
  }
}

/**
 * Czy kontrahent to właścicielka konta: wszystkie słowa któregoś z podanych
 * imion i nazwisk występują w nazwie (w dowolnej kolejności, bez ogonków),
 * np. „Anna Nowak” pasuje do „NOWAK ANNA MARIA UL. …”.
 * @param {string} name
 * @param {string[]} ownerNames
 */
export function isOwner(name, ownerNames = []) {
  const words = new Set(normalize(name).split(/[^a-z0-9]+/).filter(Boolean));
  return ownerNames.some((owner) => {
    const parts = normalize(owner).split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    return parts.length >= 2 && parts.every((p) => words.has(p));
  });
}

/**
 * Kategoria dla transakcji.
 * @param {{name: string, title?: string, amount: number}} tx
 * @param {Record<string, string>} userRules klucz sklepu → kategoria
 * @param {string[]} ownerNames imiona i nazwiska właścicielki kont
 * @param {Record<string, string>} aiRules klucz sklepu → kategoria podpowiedziana przez AI
 * @returns {{category: string, needsReview: boolean, source: 'user'|'owner'|'keyword'|'ai'|'default'}}
 */
export function categorize(tx, userRules = {}, ownerNames = [], aiRules = {}) {
  const key = merchantKey(tx.name);
  if (key && userRules[key]) {
    return { category: userRules[key], needsReview: false, source: 'user' };
  }
  const haystack = ` ${normalize(`${tx.name} ${tx.title ?? ''}`)} `;
  if (isOwner(tx.name, ownerNames) || OWN_TRANSFER.some((w) => hasWord(haystack, w))) {
    return { category: 'Przelewy własne', needsReview: false, source: 'owner' };
  }
  for (const [category, words] of KEYWORDS) {
    if (words.some((w) => hasWord(haystack, w))) {
      // Kwota dodatnia u sklepu to zwrot – zostaje w kategorii sklepu.
      return { category, needsReview: false, source: 'keyword' };
    }
  }
  if (key && aiRules[key]) {
    // „Inne” od AI znaczy „nie wiem” – transakcja zostaje do sprawdzenia przez człowieka.
    return { category: aiRules[key], needsReview: aiRules[key] === 'Inne', source: 'ai' };
  }
  if (tx.amount > 0) return { category: 'Przychód', needsReview: false, source: 'default' };
  return { category: 'Inne', needsReview: true, source: 'default' };
}
