// Odczyt plików CSV z banków: kodowanie, separator i rozbicie na wiersze.
// Czyste funkcje, bez DOM – używane w przeglądarce i w testach (Node).

/**
 * Zamienia bajty pliku na tekst. Polskie banki często eksportują CSV
 * w Windows-1250 zamiast UTF-8, więc najpierw próbujemy ścisłego UTF-8,
 * a przy błędzie przechodzimy na Windows-1250.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {{ text: string, encoding: string }}
 */
export function decodeBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(view);
    return { text: stripBom(text), encoding: 'utf-8' };
  } catch {
    const text = new TextDecoder('windows-1250').decode(view);
    return { text: stripBom(text), encoding: 'windows-1250' };
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Wybiera separator: ten z ; , i tabulatora, który daje najwięcej
 * linii o tej samej, większej niż 2 liczbie kolumn.
 * @param {string} text
 * @returns {string}
 */
export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 60);
  let best = ';';
  let bestScore = -1;
  for (const d of [';', ',', '\t']) {
    const counts = new Map();
    for (const line of lines) {
      const n = parseCsv(line, d)[0]?.length ?? 0;
      if (n > 2) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const score = Math.max(0, ...counts.values());
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Parser CSV zgodny z RFC 4180: pola w cudzysłowach, podwojone
 * cudzysłowy i znaki nowej linii wewnątrz pól.
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[][]}
 */
export function parseCsv(text, delimiter = ';') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}
