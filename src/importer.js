// Jedno wejście do importu: bajty pliku → transakcje + to, co rozpoznano.

import { decodeBytes, detectDelimiter, parseCsv } from './csv.js';
import { findHeaderRow, detectColumns, toTransactions } from './detect.js';

/**
 * @param {ArrayBuffer|Uint8Array} bytes zawartość pliku CSV
 * @param {object} [mapping] ręczne mapowanie kolumn; bez niego – wykryte
 */
export function readStatement(bytes, mapping) {
  const { text, encoding } = decodeBytes(bytes);
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const headerIndex = findHeaderRow(rows);
  const detected = detectColumns(rows, headerIndex);
  const used = mapping ?? detected;
  const transactions = toTransactions(rows, headerIndex, used);
  const width = Math.max(0, ...rows.slice(Math.max(0, headerIndex), headerIndex + 20).map((r) => r.length));
  const headers =
    headerIndex >= 0
      ? rows[headerIndex].map((h, i) => h || `Kolumna ${i + 1}`)
      : Array.from({ length: width }, (_, i) => `Kolumna ${i + 1}`);
  return { encoding, delimiter, rows, headerIndex, headers, detected, mapping: used, transactions };
}
