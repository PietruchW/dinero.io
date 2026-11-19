// Rozpoznawanie układu wyciągu: wiersz nagłówka, kolumny, kwoty i daty.

/** Małe litery, bez polskich znaków i nadmiarowych spacji – do porównań. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Zamienia kwotę z wyciągu na liczbę. Obsługuje m.in. "-1 234,56",
 * "1.234,56", "-12.50", "+6 450,00 PLN". Zwraca null, gdy to nie kwota.
 * @param {string} raw
 * @returns {number|null}
 */
export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/[\s  ]/g, '')
    .replace(/[a-zA-Z]{3}$/u, '')
    .replace(/zł$/iu, '')
    .replace(/−/g, '-');
  if (!/^[+-]?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    if ((s.match(/,/g) || []).length > 1) return null;
    s = s.replace(',', '.');
  } else if (lastDot !== -1 && /^[+-]?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.split('.').join('');
  }
  if ((s.match(/\./g) || []).length > 1) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * Zamienia datę z wyciągu na "RRRR-MM-DD". Obsługuje formaty
 * 2026-10-31, 2026.10.31, 31.10.2026, 31-10-2026, 31/10/2026 (z godziną lub bez).
 * @param {string} raw
 * @returns {string|null}
 */
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let y;
  let m;
  let d;
  let match = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T].*)?$/);
  if (match) {
    [, y, m, d] = match;
  } else {
    match = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[ T].*)?$/);
    if (!match) return null;
    [, d, m, y] = match;
  }
  const yi = Number(y);
  const mi = Number(m);
  const di = Number(d);
  if (mi < 1 || mi > 12 || di < 1 || di > 31 || yi < 1990 || yi > 2100) return null;
  const date = new Date(Date.UTC(yi, mi - 1, di));
  if (date.getUTCMonth() !== mi - 1) return null;
  return `${yi}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
}

// Nazwy nagłówków spotykane w polskich bankach. Kolejność = priorytet.
const HEADER_HINTS = {
  date: ['data transakcji', 'data operacji', 'data zlecenia', 'data waluty', 'data ksiegowania', 'data', 'date'],
  amount: ['kwota transakcji', 'kwota operacji', 'kwota w walucie rachunku', 'kwota', 'amount'],
  name: ['dane kontrahenta', 'kontrahent', 'nadawca / odbiorca', 'nadawca/odbiorca', 'odbiorca', 'nazwa', 'merchant', 'payee'],
  title: ['tytul', 'opis transakcji', 'opis operacji', 'opis', 'szczegoly', 'description'],
  currency: ['waluta', 'currency']
};

// Kolumny, których nigdy nie bierzemy jako kwoty transakcji.
const AMOUNT_EXCLUDE = ['blokad', 'saldo', 'balance', 'w walucie obcej', 'platnosci w walucie'];

function findColumn(headers, hints, used, exclude = []) {
  for (const hint of hints) {
    const idx = headers.findIndex(
      (h, i) => !used.has(i) && (h === hint || h.startsWith(hint)) && !exclude.some((e) => h.includes(e))
    );
    if (idx !== -1) return idx;
  }
  for (const hint of hints) {
    const idx = headers.findIndex(
      (h, i) => !used.has(i) && h.includes(hint) && !exclude.some((e) => h.includes(e))
    );
    if (idx !== -1) return idx;
  }
  return null;
}

/**
 * Szuka wiersza nagłówka wśród pierwszych 40 wierszy: pierwszego,
 * który ma kolumnę z datą i kolumnę z kwotą. -1, gdy brak nagłówka.
 * @param {string[][]} rows
 */
export function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit; i += 1) {
    const headers = rows[i].map(normalize);
    const hasDate = headers.some((h) => h.startsWith('data') || h === 'date');
    const hasAmount = headers.some(
      (h) => (h.startsWith('kwota') || h === 'amount') && !AMOUNT_EXCLUDE.some((e) => h.includes(e))
    );
    if (hasDate && hasAmount) return i;
  }
  return -1;
}

/**
 * Ustala, które kolumny to data, kwota, kontrahent, tytuł i waluta.
 * Z nagłówkiem – po nazwach; bez nagłówka – po zawartości.
 * @param {string[][]} rows
 * @param {number} headerIndex
 * @returns {{date: number|null, amount: number|null, name: number|null, title: number|null, currency: number|null}}
 */
export function detectColumns(rows, headerIndex) {
  if (headerIndex >= 0) {
    const headers = rows[headerIndex].map(normalize);
    const used = new Set();
    const pick = (key, exclude) => {
      const idx = findColumn(headers, HEADER_HINTS[key], used, exclude);
      if (idx !== null) used.add(idx);
      return idx;
    };
    const date = pick('date');
    const amount = pick('amount', AMOUNT_EXCLUDE);
    const name = pick('name');
    const title = pick('title');
    const currency = amount !== null && normalize(rows[headerIndex][amount + 1]).startsWith('waluta')
      ? amount + 1
      : pick('currency');
    return { date, amount, name, title, currency };
  }
  return detectByContent(rows);
}

function detectByContent(rows) {
  const sample = rows.filter((r) => r.length > 2).slice(0, 50);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const share = (test) =>
    Array.from({ length: width }, (_, c) => {
      const values = sample.map((r) => r[c]).filter((v) => v != null && v !== '');
      if (values.length === 0) return 0;
      return values.filter(test).length / sample.length;
    });
  const dateShare = share((v) => parseDate(v) !== null);
  const amountShare = share((v) => parseAmount(v) !== null && parseDate(v) === null);
  const best = (scores, skip) => {
    let idx = null;
    let top = 0.5;
    scores.forEach((s, i) => {
      if (!skip.includes(i) && s > top) {
        top = s;
        idx = i;
      }
    });
    return idx;
  };
  const date = best(dateShare, []);
  const amount = best(amountShare, [date]);
  const textLen = Array.from({ length: width }, (_, c) =>
    c === date || c === amount
      ? -1
      : sample.reduce((sum, r) => sum + (/[a-z]/i.test(r[c] ?? '') ? (r[c] ?? '').length : 0), 0)
  );
  const name = textLen.some((l) => l > 0) ? textLen.indexOf(Math.max(...textLen)) : null;
  return { date, amount, name, title: null, currency: null };
}

/** Krótki, stały skrót tekstu (FNV-1a) – do identyfikatorów transakcji. */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Buduje listę transakcji z wierszy i mapowania kolumn. Pomija wiersze
 * bez poprawnej daty lub kwoty (np. stopki, blokady bez kwoty).
 * Identyczne transakcje z tego samego dnia dostają kolejne numery,
 * więc dwie takie same kawy nie zleją się w jedną, a ponowny import
 * tego samego pliku nie zdubluje danych.
 * @returns {{date: string, amount: number, name: string, title: string, currency: string, id: string}[]}
 */
export function toTransactions(rows, headerIndex, mapping) {
  if (mapping.date == null || mapping.amount == null) return [];
  const seen = new Map();
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const date = parseDate(r[mapping.date]);
    const amount = parseAmount(r[mapping.amount]);
    if (date === null || amount === null || amount === 0) continue;
    const name = (mapping.name != null ? r[mapping.name] : '') || '';
    const title = (mapping.title != null ? r[mapping.title] : '') || '';
    const currency = (mapping.currency != null ? r[mapping.currency] : '') || 'PLN';
    const base = `${date}|${amount.toFixed(2)}|${normalize(name)}|${normalize(title)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: hash(`${base}#${n}`), date, amount, name: name || title, title: name ? title : '', currency });
  }
  return out;
}
