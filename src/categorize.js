// Przypisywanie kategorii: najpierw reguły użytkowniczki („Zapamiętaj dla…”),
// potem wbudowane słowa kluczowe. Wszystko lokalnie, bez sieci.

import { normalize } from './detect.js';

export const CATEGORIES = [
  'Jedzenie',
  'Wyjścia',
  'Zakupy',
  'Transport',
  'Podróże',
  'Kosmetyki i zdrowie',
  'Edukacja',
  'Rachunki',
  'Podatki i ZUS',
  'Długi',
  'Subskrypcje',
  'Inne',
  'Przelewy własne',
  'Oszczędności i inwestycje',
  'Przychód'
];

/** Pieniądze odłożone lub zainwestowane – widoczne, ale nie są wydatkiem. */
export const SAVINGS = 'Oszczędności i inwestycje';

// Kategorie, które nie są ani wydatkiem, ani wpływem: pieniądze przechodzą
// między własnymi kontami albo są odkładane (giełda krypto, maklerskie).
export const NEUTRAL = new Set(['Przelewy własne', 'Oszczędności i inwestycje']);

// Opisy, którymi banki oznaczają przelew między własnymi rachunkami.
const OWN_TRANSFER = ['przelew wlasny', 'przelew wewnetrzny', 'przelew miedzy rachunkami', 'przelew miedzy wlasnymi',
  'przeksiegowanie', 'transfer wlasny'];

// Pośrednicy płatności i płatności odroczone (PayPo, Klarna): prawdziwy sklep
// zwykle nie jest znany, a pieniądze idą na zakupy. Nie zapamiętujemy dla nich
// reguł – jedna zmiana przestawiłaby wszystkie płatności przez pośrednika.
const INTERMEDIARIES = ['paypo', 'klarna', 'twisto', 'spingo', 'payu', 'przelewy24', 'p24', 'tpay', 'dotpay',
  'autopay', 'blue media', 'bluemedia', 'paypro', 'cashbill', 'imoje', 'paynow', 'paypal', 'nuvei',
  'platnosc blik', 'transakcja blik', 'zakup blik'];

// Kolejność ma znaczenie: bardziej szczegółowe wpisy (np. „uber eats”)
// muszą stać przed ogólnymi („uber”). Słowa po normalizacji (bez ogonków).
const KEYWORDS = [
  ['Podatki i ZUS', ['urzad skarbowy', 'izba administracji skarbowej', 'mikrorachunek', 'zus', 'zaklad ubezpieczen spol',
    'krus', 'podatek', 'podatku', 'pit-', 'vat-7', 'vat7', 'cit-']],
  // Pierwsze, bo opis spłaty często zawiera nazwę sklepu („PayPo – Allegro”).
  ['Długi', ['splata kredytu', 'splata pozyczki', 'splata raty', 'splata karty',
    'splata zadluzenia', 'splata limitu', 'splata kapitalu', 'rata kredytu', 'rata pozyczki', 'odset', 'prow-kredyt',
    'provident', 'vivus', 'wonga',
    'smartney', 'ferratum', 'zaplo', 'netcredit', 'net credit', 'filarum', 'lendon', 'cofidis', 'santander consumer',
    'inbank', 'kredyt hipoteczny', 'rata hipoteczna']],
  // Wpłaty i wypłaty z giełd i kont inwestycyjnych – obie strony neutralne.
  ['Oszczędności i inwestycje', ['binance', 'okx', 'bybit', 'kraken', 'coinbase', 'zondacrypto', 'zonda crypto',
    'bitpanda', 'kanga exchange', 'xtb', 'dom maklerski', 'obligacj']],
  ['Edukacja', ['szkola jezyk', 'szkola jezykow', 'kurs ', 'kursy ', 'udemy', 'coursera', 'duolingo', 'babbel',
    'berlitz', 'british council', 'czesne', 'korepetycj', 'uczelni', 'uniwersytet', 'politechnik']],
  ['Wyjścia', ['uber eats', 'pyszne', 'glovo', 'wolt', 'bolt food', 'mcdonald', 'kfc', 'burger king', 'starbucks',
    'costa coffee', 'restauracja', 'pizz', 'sushi', 'kebab', 'kawiarnia', 'cafe', 'bistro', 'pub ', 'helios',
    'multikino', 'cinema city', 'ebilet']],
  ['Subskrypcje', ['netflix', 'spotify', 'apple.com', 'icloud', 'youtube', 'google one', 'disney', 'hbo', 'canal+',
    'chatgpt', 'openai', 'anthropic', 'claude.ai', 'amazon prime', 'prime video', 'audible', 'legimi', 'empik go', 'tidal', 'skyshowtime']],
  ['Jedzenie', ['lidl', 'biedronka', 'kaufland', 'aldi', 'auchan', 'carrefour', 'netto', 'zabka', 'dino', 'stokrotka',
    'frisco', 'lewiatan', 'polomarket', 'spar', 'intermarche', 'delikatesy', 'piekarnia', 'mieso', 'warzywa']],
  ['Podróże', ['booking.com', 'airbnb', 'ryanair', 'wizz air', 'wizzair', 'lot polish', 'pll lot', 'enter air',
    'lufthansa', 'klm', 'emirates', 'etihad', 'qatar airways', 'turkish airlines', 'easyjet', 'norwegian air',
    'hotel', 'hostel', 'expedia', 'agoda', 'trivago', 'esky', 'itaka', 'tui ', 'rainbow tours', 'coral travel',
    'wakacje.pl', 'travelplanet']],
  ['Kosmetyki i zdrowie', ['rossmann', 'hebe', 'sephora', 'douglas', 'super-pharm', 'superpharm', 'natura', 'notino',
    'inglot', 'apteka', 'doz', 'medicover', 'luxmed', 'lux med', 'enel-med', 'dentyst', 'fryzjer', 'kosmetycz']],
  ['Transport', ['orlen', 'bp ', 'shell', 'circle k', 'moya', 'amic', 'lotos', 'bolt', 'uber', 'freenow', 'free now',
    'pkp', 'intercity', 'skm', 'ztm', 'mpk', 'jakdojade', 'parking', 'skycash', 'koleo', 'flixbus']],
  ['Rachunki', ['orange', 'play ', 'p4 sp', 't-mobile', 'plus ', 'polkomtel', 'energa', 'pge', 'tauron', 'enea',
    'pgnig', 'upc', 'netia', 'vectra', 'czynsz', 'wspolnota', 'spoldzielnia', 'prowizj', 'oplata za prowadzenie',
    'oplata za karte', 'oplata miesieczna', 'miesieczna oplata', 'oplaty', 'ubezpieczen', 'splata skladki']],
  ['Zakupy', ['allegro', 'zalando', 'amazon', 'h&m', 'zara', 'reserved', 'sinsay', 'mohito', 'pepco', 'action ', 'ikea',
    'jysk', 'ccc', 'decathlon', 'media expert', 'rtv euro', 'mediamarkt', 'shein', 'temu', 'aliexpress', 'vinted',
    'empik', 'smyk', 'tk maxx', 'deichmann', 'leroy', 'castorama', 'obi ']],
  // Na końcu: pośrednicy płatności. Sklep z opisu (np. „PayU – Pyszne”) wygrywa wcześniej.
  ['Zakupy', INTERMEDIARIES]
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

/** Czy kontrahent to pośrednik płatności (PayU, PayPo, „Płatność BLIK”…). */
export function isIntermediary(name) {
  const haystack = ` ${normalize(name)} `;
  return INTERMEDIARIES.some((w) => hasWord(haystack, w));
}

/**
 * Klucz reguły „Zapamiętaj dla…”: osobny dla wydatków i wpływów od tego
 * samego kontrahenta (wpływy z prefiksem „+”). Reguła z wydatku nie może
 * zamienić wpływu (np. faktury) w ujemny wydatek.
 * @param {{name: string, amount: number}} tx
 */
export function ruleKey(tx) {
  if (isIntermediary(tx.name)) return '';
  const key = merchantKey(tx.name);
  return key && tx.amount > 0 ? `+${key}` : key;
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
  const rule = ruleKey(tx);
  // Przelew, w którym po drugiej stronie jest sama właścicielka, to zawsze
  // przelew własny – także gdy dla tej nazwy zapamiętano inną kategorię.
  // Inaczej reguła z jednego przelewu przestawiała wszystkie wpływy z jej
  // drugiego konta na kategorię wydatków (i wydatki wychodziły na minusie).
  if (isOwner(tx.name, ownerNames)) {
    return { category: 'Przelewy własne', needsReview: false, source: 'owner' };
  }
  if (rule && userRules[rule]) {
    return { category: userRules[rule], needsReview: false, source: 'user' };
  }
  const haystack = ` ${normalize(`${tx.name} ${tx.title ?? ''}`)} `;
  if (OWN_TRANSFER.some((w) => hasWord(haystack, w))) {
    return { category: 'Przelewy własne', needsReview: false, source: 'owner' };
  }
  for (const [category, words] of KEYWORDS) {
    // Wpływ z „odsetkami” to zarobek na oszczędnościach, nie dług;
    // wpływ od urzędu skarbowego to zwrot podatku, czyli przychód.
    if ((category === 'Długi' || category === 'Podatki i ZUS') && tx.amount > 0) continue;
    if (words.some((w) => hasWord(haystack, w))) {
      // Kwota dodatnia u sklepu to zwrot – zostaje w kategorii sklepu.
      return { category, needsReview: false, source: 'keyword' };
    }
  }
  // AI dostaje tylko wydatki, więc jego podpowiedzi dotyczą tylko wydatków.
  if (key && tx.amount < 0 && aiRules[key] && !isIntermediary(tx.name)) {
    // „Inne” od AI znaczy „nie wiem” – transakcja zostaje do sprawdzenia przez człowieka.
    return { category: aiRules[key], needsReview: aiRules[key] === 'Inne', source: 'ai' };
  }
  if (tx.amount > 0) return { category: 'Przychód', needsReview: false, source: 'default' };
  return { category: 'Inne', needsReview: true, source: 'default' };
}
