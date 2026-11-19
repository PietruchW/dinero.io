// Jedno wejście do importu: bajty pliku → transakcje + to, co rozpoznano.
// Obsługuje CSV (np. ING, Alior) i Excel .xlsx (np. BNP Paribas).

import { decodeBytes, detectDelimiter, parseCsv } from './csv.js';
import { findHeaderRow, detectColumns, toTransactions } from './detect.js';
import { isZip, isLegacyXls, readXlsx } from './xlsx.js';

/**
 * Rozpoznaje układ już odczytanych wierszy. Używane też przy zmianie
 * mapowania kolumn albo nazwy konta – bez ponownego czytania pliku.
 * @param {string[][]} rows
 * @param {object} [mapping] ręczne mapowanie kolumn; bez niego – wykryte
 * @param {{label?: string, encoding?: string, delimiter?: string}} [meta]
 */
export function analyzeRows(rows, mapping, meta = {}) {
  const headerIndex = findHeaderRow(rows);
  const detected = detectColumns(rows, headerIndex);
  const used = mapping ?? detected;
  const label = meta.label ?? '';
  const transactions = toTransactions(rows, headerIndex, used, { label });
  const width = Math.max(0, ...rows.slice(Math.max(0, headerIndex), headerIndex + 20).map((r) => r.length));
  const headers =
    headerIndex >= 0
      ? rows[headerIndex].map((h, i) => h || `Kolumna ${i + 1}`)
      : Array.from({ length: width }, (_, i) => `Kolumna ${i + 1}`);
  const accounts = [...new Set(transactions.map((t) => t.account).filter(Boolean))];
  return {
    encoding: meta.encoding ?? '', delimiter: meta.delimiter ?? '', label,
    rows, headerIndex, headers, detected, mapping: used, transactions, accounts
  };
}

/**
 * Plik CSV (synchronicznie).
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {object} [mapping]
 * @param {string} [label] nazwa konta wpisana przy imporcie
 */
export function readStatement(bytes, mapping, label = '') {
  const { text, encoding } = decodeBytes(bytes);
  const delimiter = detectDelimiter(text);
  return analyzeRows(parseCsv(text, delimiter), mapping, { encoding, delimiter, label });
}

/**
 * Dowolny obsługiwany plik: CSV albo Excel .xlsx.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {string} [label]
 */
export async function readFile(bytes, label = '') {
  if (isLegacyXls(bytes)) {
    throw new Error('To stary format Excela (.xls). Otwórz plik i zapisz go jako .xlsx albo pobierz z banku CSV.');
  }
  if (isZip(bytes)) {
    return analyzeRows(await readXlsx(bytes), undefined, { encoding: 'Excel', label });
  }
  return readStatement(bytes, undefined, label);
}
