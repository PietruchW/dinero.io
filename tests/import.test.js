import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBytes, detectDelimiter, parseCsv } from '../src/csv.js';
import { parseAmount, parseDate, findHeaderRow, detectColumns, toTransactions } from '../src/detect.js';
import { readStatement } from '../src/importer.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('parseAmount: polskie i angielskie formaty', () => {
  assert.equal(parseAmount('-1 234,56'), -1234.56);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('-12.50'), -12.5);
  assert.equal(parseAmount('+6 450,00 PLN'), 6450);
  assert.equal(parseAmount('6 450,00'), 6450);
  assert.equal(parseAmount('−12,00 zł'), -12);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('PLN'), null);
  assert.equal(parseAmount('2026-10-31'), null);
  assert.equal(parseAmount('1,2,3'), null);
});

test('parseDate: różne formaty, odrzuca bzdury', () => {
  assert.equal(parseDate('2026-10-31'), '2026-10-31');
  assert.equal(parseDate('31.10.2026'), '2026-10-31');
  assert.equal(parseDate('1-2-2026'), '2026-02-01');
  assert.equal(parseDate('2026.10.31 12:30'), '2026-10-31');
  assert.equal(parseDate('31.02.2026'), null);
  assert.equal(parseDate('Kwota'), null);
  assert.equal(parseDate(''), null);
});

test('parseCsv: cudzysłowy, podwójne cudzysłowy, nowa linia w polu', () => {
  const rows = parseCsv('a;"b;c";"d ""e"""\r\n"x\ny";2;3', ';');
  assert.deepEqual(rows, [['a', 'b;c', 'd "e"'], ['x\ny', '2', '3']]);
});

test('decodeBytes: rozpoznaje Windows-1250 i UTF-8', () => {
  const cp = decodeBytes(fixture('ing-like-cp1250.csv'));
  assert.equal(cp.encoding, 'windows-1250');
  assert.ok(cp.text.includes('Data księgowania'));
  const utf = decodeBytes(new TextEncoder().encode('﻿Zażółć;1'));
  assert.equal(utf.encoding, 'utf-8');
  assert.equal(utf.text, 'Zażółć;1');
});

test('wyciąg w stylu ING: nagłówek, kolumny i transakcje', () => {
  const { text } = decodeBytes(fixture('ing-like-cp1250.csv'));
  const delimiter = detectDelimiter(text);
  assert.equal(delimiter, ';');
  const rows = parseCsv(text, delimiter);
  const header = findHeaderRow(rows);
  assert.equal(header, 4);
  const cols = detectColumns(rows, header);
  assert.deepEqual(cols, { date: 0, amount: 8, name: 2, title: 3, currency: 9 });
  const txs = toTransactions(rows, header, cols);
  // Blokada bez kwoty transakcji (Rossmann) nie wchodzi.
  assert.equal(txs.length, 9);
  assert.ok(!txs.some((t) => t.name.startsWith('ROSSMANN')));
  assert.equal(txs[0].amount, -86.4);
  assert.equal(txs[0].date, '2026-10-31');
  assert.equal(txs[0].currency, 'PLN');
  // Dwie identyczne kawy to dwie transakcje.
  const kawy = txs.filter((t) => t.name === 'Kawiarnia Pod Lipą');
  assert.equal(kawy.length, 2);
  assert.notEqual(kawy[0].id, kawy[1].id);
});

test('identyfikatory są stałe między importami tego samego pliku', () => {
  const a = readStatement(fixture('ing-like-cp1250.csv'));
  const b = readStatement(fixture('ing-like-cp1250.csv'));
  assert.deepEqual(a.transactions.map((t) => t.id), b.transactions.map((t) => t.id));
});

test('plik bez nagłówka: kolumny z zawartości', () => {
  const result = readStatement(fixture('no-header-utf8.csv'));
  assert.equal(result.headerIndex, -1);
  assert.equal(result.mapping.date, 0);
  assert.equal(result.mapping.amount, 2);
  assert.equal(result.mapping.name, 1);
  assert.equal(result.transactions.length, 3);
  assert.equal(result.transactions[2].amount, 5000);
});

test('readStatement: ręczne mapowanie nadpisuje wykryte', () => {
  const auto = readStatement(fixture('ing-like-cp1250.csv'));
  const manual = readStatement(fixture('ing-like-cp1250.csv'), { ...auto.mapping, name: 3, title: null });
  assert.equal(manual.transactions[0].name, 'Płatność kartą 31.10.2026 Nr karty 4246xx0000');
});
