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
  name: ['dane kontrahenta', 'kontrahent', 'nadawca / odbiorca', 'nadawca/odbiorca', 'nazwa odbiorcy', 'dane odbiorcy',
    'odbiorca', 'nazwa', 'merchant', 'payee'],
  title: ['tytul', 'opis transakcji', 'opis operacji', 'opis', 'szczegoly', 'description'],
  currency: ['waluta', 'currency']
};

// Jak kolumnę kontrahenta wybierały wersje przed 20.11.2026 – przy osobnych
// kolumnach „Nazwa nadawcy” i „Nazwa odbiorcy” (Alior) brały nadawcę. Potrzebne,
// żeby ponowny import starego pliku rozpoznał już wczytane transakcje.
const LEGACY_NAME_HINTS = ['dane kontrahenta', 'kontrahent', 'nadawca / odbiorca', 'nadawca/odbiorca', 'odbiorca', 'nazwa',
  'merchant', 'payee'];

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
 * @returns {{date: number|null, amount: number|null, name: number|null, title: number|null, currency: number|null,
 *   sender?: number|null, account?: number|null, status?: number|null, type?: number|null,
 *   legacyName?: number|null}}
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
    // Kolumny dodatkowe – tylko przy dokładnej nazwie, żeby nie pomylić
    // np. „Nr rachunku” kontrahenta z własnym kontem.
    const exact = (names) => {
      const idx = headers.findIndex((h, i) => !used.has(i) && names.includes(h));
      if (idx === -1) return null;
      used.add(idx);
      return idx;
    };
    const sender = exact(['nadawca', 'nazwa nadawcy', 'dane nadawcy']);
    const account = exact(['produkt']);
    const status = exact(['status', 'status transakcji', 'status operacji']);
    const type = exact(['typ transakcji', 'typ operacji']);
    const legacy = findColumn(headers, LEGACY_NAME_HINTS, new Set([date, amount].filter((i) => i !== null)));
    const legacyName = legacy !== name ? legacy : null;
    return { date, amount, name, title, currency, sender, account, status, type, legacyName };
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

// Numer karty zamaskowany przez bank („123456------1234”) i numer rachunku
// (26 cyfr, z „PL” lub bez, ze spacjami lub bez).
const CARD_NUMBER = /\b\d{4,6}[-*xX•]{4,}\d{4}\b/g;
const ACCOUNT_NUMBER = /\b(?:[A-Z]{2})?\d{2}(?: ?\d{4}){6}\b/g;

/** Usuwa z tekstu numery kart i rachunków – nie są potrzebne i nie powinny trafić do AI. */
export function scrubNumbers(text) {
  return String(text ?? '')
    .replace(CARD_NUMBER, ' ')
    .replace(ACCOUNT_NUMBER, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function lines(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Nazwa kontrahenta z pola, w którym bank trzyma numer konta, nazwę i adres
 * w osobnych liniach (np. BNP). Bierzemy pierwszą linię, która nie jest numerem.
 */
export function cleanParty(text) {
  for (const line of lines(text)) {
    const clean = scrubNumbers(line);
    if (clean) return clean;
  }
  return '';
}

/**
 * Czytelna nazwa konta z kolumny „Produkt”: nazwa produktu i 4 ostatnie
 * cyfry numeru, np. „Konto Osobiste •1234”. Pełny numer nie jest zapisywany.
 */
export function accountLabel(text) {
  const { name, last4 } = accountParts(text);
  if (name && last4) return `${name} •${last4}`;
  return name || (last4 ? `Rachunek •${last4}` : '');
}

/**
 * Nazwa konta do wyświetlania. Rachunek rozpoznajemy po numerze – karta
 * podpięta do konta („Karta Otwarta na Dzisiaj”) to to samo konto co
 * „Konto Osobiste” z tym samym numerem.
 * @param {string} label nazwa wpisana przy imporcie
 * @param {string} product zawartość kolumny „Produkt”
 */
export function accountDisplay(label, product) {
  const { name, last4 } = accountParts(product);
  if (last4) return `${label || 'Rachunek'} •${last4}`;
  return [label, name].filter(Boolean).join(' · ');
}

function accountParts(text) {
  let name = '';
  let last4 = '';
  for (const line of lines(text)) {
    const digits = line.replace(/\s/g, '');
    if (/^(?:[A-Z]{2})?\d{10,34}$/i.test(digits)) {
      if (!last4) last4 = digits.slice(-4);
    } else if (!name) {
      name = scrubNumbers(line);
    }
  }
  return { name, last4 };
}

// Opis płatności kartą w BNP: numer karty, pole 20 znaków z nazwiskiem
// posiadacza, miasto, sklep, kraj, kwota, waluta i data, np.
// „123456------7890 JAN KOWALSKI         Gdansk LIDL WARSZAWSKA POL 114,46 PLN 2026-11-14”.
const CARD_DESC = /^(?:\d{4,6}[-*xX•]{4,}\d{4}|\d{4}-\d{2}-\d{2}) (.{20}) (.+?)(?: [A-Z]{3} -?[\d.,]+ [A-Z]{3} \d{4}-\d{2}-\d{2})?$/;

/**
 * Nazwa sklepu z opisu płatności kartą (bez numeru karty, nazwiska
 * posiadacza, miasta i kwoty). null, gdy opis ma inny układ.
 */
export function cardMerchant(text) {
  const m = String(text ?? '').trim().match(CARD_DESC);
  if (!m) return null;
  const words = m[2].trim().split(/\s+/);
  // Pierwsze słowo to miasto – zostawiamy je tylko, gdy nic poza nim nie ma.
  return scrubNumbers(words.length > 1 ? words.slice(1).join(' ') : words[0]);
}

// Operacje samego banku: jako „kontrahenta” bierzemy typ operacji, żeby
// odsetki, prowizje i raty nie zlały się w jeden „sklep” o nazwie banku.
const BANK_TYPES = /^(odsetki|prowizj|oplat|operacja kredytowa)/;

// Statusy operacji, które nie zmieniły salda.
const SKIPPED_STATUS = /odrzuc|anulow|niezrealiz|odmow/;

/**
 * Zamienia wiersze wyciągu na transakcje. Pomija wiersze bez daty lub kwoty,
 * z kwotą 0 i operacje odrzucone. Identyfikator liczony z daty, kwoty,
 * kontrahenta, tytułu i konta – ten sam plik wczytany drugi raz da te same ID.
 * @param {string[][]} rows
 * @param {number} headerIndex
 * @param {object} mapping
 * @param {{label?: string}} [options] nazwa konta wpisana przy imporcie
 */
export function toTransactions(rows, headerIndex, mapping, options = {}) {
  if (mapping.date == null || mapping.amount == null) return [];
  const label = String(options.label ?? '').trim().slice(0, 40);
  const seen = new Map();
  const seenLegacy = new Map();
  const seenOld = new Map();
  const out = [];
  const cell = (r, key) => (mapping[key] != null ? r[mapping[key]] ?? '' : '');
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const date = parseDate(r[mapping.date]);
    const amount = parseAmount(r[mapping.amount]);
    if (date === null || amount === null || amount === 0) continue;
    if (mapping.status != null && SKIPPED_STATUS.test(normalize(cell(r, 'status')))) continue;
    // Przy wpływie kontrahentem jest nadawca, przy wydatku – odbiorca.
    const rawName = amount > 0 && mapping.sender != null && cell(r, 'sender') ? cell(r, 'sender') : cell(r, 'name');
    const rawTitle = cell(r, 'title');
    const currency = cell(r, 'currency') || 'PLN';
    // ID z surowych danych – tak jak w poprzednich wersjach, żeby ponowny
    // import starego pliku nie zrobił duplikatów.
    const base = `${date}|${amount.toFixed(2)}|${normalize(rawName)}|${normalize(rawTitle)}`;
    // Klucz do ID z nazwy produktu i numeru – tak jak od początku, żeby
    // ponowny import nie zrobił duplikatów. Wyświetlana nazwa – po numerze.
    const product = accountLabel(cell(r, 'account'));
    const account = accountDisplay(label, cell(r, 'account'));
    // Z kolumny „Produkt” klucz konta jest stały; bez niej – nazwa z importu.
    const accountKey = product ? normalize(product) : normalize(label);
    const key = accountKey ? `${accountKey}|${base}` : base;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    let name = cleanParty(rawName);
    let title = lines(rawTitle).map(scrubNumbers).filter(Boolean).join(' ');
    const type = String(cell(r, 'type')).trim();
    const card = cardMerchant(lines(rawTitle)[0]);
    if (type && BANK_TYPES.test(normalize(type))) {
      name = type;
    } else if (!name && card) {
      name = card;
      title = '';
    }
    const tx = { id: hash(`${key}#${n}`), date, amount, name: name || title, title: name ? title : '', currency };
    if (account) tx.account = account;
    // Identyfikatory, jakie ta transakcja mogła dostać w starszych wersjach –
    // do rozpoznania już wczytanych (bez duplikatów, z poprawą nazwy i konta).
    const legacyIds = [];
    if (accountKey) {
      // Przed dodaniem kont: bez klucza konta.
      const m = (seenLegacy.get(base) ?? 0) + 1;
      seenLegacy.set(base, m);
      legacyIds.push(hash(`${base}#${m}`));
    }
    if (mapping.legacyName != null) {
      // Przed 20.11.2026: kontrahent z innej kolumny (np. nadawca zamiast odbiorcy).
      const oldBase = `${date}|${amount.toFixed(2)}|${normalize(r[mapping.legacyName] ?? '')}|${normalize(rawTitle)}`;
      const m = (seenOld.get(oldBase) ?? 0) + 1;
      seenOld.set(oldBase, m);
      legacyIds.push(hash(`${oldBase}#${m}`));
    }
    const others = [...new Set(legacyIds)].filter((id) => id !== tx.id);
    if (others.length) tx.legacyIds = others;
    out.push(tx);
  }
  return out;
}
