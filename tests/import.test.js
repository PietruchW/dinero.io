import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBytes, detectDelimiter, parseCsv } from '../src/csv.js';
import { parseAmount, parseDate, findHeaderRow, detectColumns, toTransactions } from '../src/detect.js';
import { readStatement, readFile } from '../src/importer.js';
import { cleanParty, accountLabel, accountDisplay, scrubNumbers, cardMerchant } from '../src/detect.js';
import { isZip, isLegacyXls } from '../src/xlsx.js';

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
  assert.deepEqual(cols, {
    date: 0, amount: 8, name: 2, title: 3, currency: 9, sender: null, account: null, status: null, type: null
  });
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

test('identyfikatory z CSV bez nazwy konta są takie jak przed dodaniem kont', () => {
  // Zapisane z wersji sprzed kont – zmiana tutaj = duplikaty u użytkowniczki.
  const ids = readStatement(fixture('ing-like-cp1250.csv')).transactions.map((t) => t.id);
  assert.deepEqual(ids, ['139lhzm', '1hn10dk', '1kk9knk', '1le8dqh', '1sci0sb', 'fmj8wa', 'usank3', '10cq4t8', '1pimsrg']);
});

test('nazwa konta przy imporcie: inne ID, stare ID zapamiętane do scalania', () => {
  const plain = readStatement(fixture('ing-like-cp1250.csv')).transactions;
  const ing = readStatement(fixture('ing-like-cp1250.csv'), undefined, 'ING').transactions;
  const other = readStatement(fixture('ing-like-cp1250.csv'), undefined, 'Wspólne').transactions;
  assert.ok(ing.every((t) => t.account === 'ING'));
  assert.deepEqual(ing.map((t) => t.legacyId), plain.map((t) => t.id));
  assert.notDeepEqual(ing.map((t) => t.id), plain.map((t) => t.id));
  assert.notDeepEqual(ing.map((t) => t.id), other.map((t) => t.id));
  // Wielkość liter w nazwie konta nie zmienia ID.
  const lower = readStatement(fixture('ing-like-cp1250.csv'), undefined, 'ing').transactions;
  assert.deepEqual(lower.map((t) => t.id), ing.map((t) => t.id));
});

test('czyszczenie numerów kont i kart', () => {
  assert.equal(cleanParty('PL61109010140000071219812874\nAllegro Sp. z o.o.\nul. Testowa 1'), 'Allegro Sp. z o.o.');
  assert.equal(cleanParty('61 1090 1014 0000 0712 1981 2874\nJAN KOWALSKI'), 'JAN KOWALSKI');
  assert.equal(cleanParty('11111111111111111111111111'), '');
  assert.equal(scrubNumbers('Spłata 33 3333 3333 3333 3333 3333 3333 rata'), 'Spłata rata');
  assert.equal(scrubNumbers('123456------7890 ZABKA'), 'ZABKA');
  assert.equal(accountLabel('Konto Osobiste\n11111111111111111111110001'), 'Konto Osobiste •0001');
  assert.equal(accountLabel('11111111111111111111110002'), 'Rachunek •0002');
  assert.equal(accountLabel(''), '');
});

test('płatność kartą BNP: sklep bez nazwiska posiadacza, miasta i kwoty', () => {
  assert.equal(cardMerchant('123456------7890 JAN KOWALSKI         Gdansk LIDL WARSZAWSKA POL 114,46 PLN 2026-11-14'),
    'LIDL WARSZAWSKA');
  assert.equal(cardMerchant('123456------7890 KATARZYNA WISNIEWSKA GDANSK JYSK P431 GDANSK POL 1199,00 PLN 2026-10-10'),
    'JYSK P431 GDANSK');
  assert.equal(cardMerchant('Zakupy w sklepie'), null);
});

test('rozpoznaje Excel i stary .xls', () => {
  assert.ok(isZip(fixture('bnp-like.xlsx')));
  assert.ok(!isZip(fixture('ing-like-cp1250.csv')));
  assert.ok(isLegacyXls(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])));
});

test('stary .xls: czytelny komunikat zamiast błędu', async () => {
  await assert.rejects(readFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), /xlsx/);
});

test('wyciąg BNP (.xlsx): kolumny, konta, kontrahenci, odrzucone', async () => {
  const r = await readFile(fixture('bnp-like.xlsx'));
  assert.equal(r.encoding, 'Excel');
  assert.deepEqual(
    { date: r.mapping.date, amount: r.mapping.amount, name: r.mapping.name, title: r.mapping.title,
      sender: r.mapping.sender, account: r.mapping.account, status: r.mapping.status, type: r.mapping.type },
    { date: 0, amount: 3, name: 6, title: 7, sender: 5, account: 8, status: 12, type: 9 }
  );
  assert.deepEqual(r.accounts, ['Rachunek •0001', 'Rachunek •0002']);
  const txs = r.transactions;
  // Odrzucona płatność nie wchodzi.
  assert.equal(txs.length, 9);
  assert.ok(!txs.some((t) => t.name.includes('ODRZUCONY')));
  const by = (date, amount) => txs.filter((t) => t.date === date && t.amount === amount);
  // Płatność kartą: sam sklep, bez numeru karty, nazwiska posiadaczki i miasta.
  assert.equal(by('2026-10-31', -23.5)[0].name, 'ZABKA Z1234');
  assert.equal(by('2026-10-31', -23.5)[0].title, '');
  assert.equal(by('2026-10-30', -149.99)[0].name, 'Allegro Sp. z o.o.');
  assert.equal(by('2026-10-29', -200)[0].name, 'PAYPO SP. Z O.O.');
  assert.equal(by('2026-10-29', -200)[0].title, 'Spłata');
  // Przy wpływie kontrahentem jest nadawca.
  assert.equal(by('2026-10-28', 6450)[0].name, 'FIRMA TESTOWA SA');
  // Operacja banku: typ jako nazwa.
  assert.equal(by('2026-10-26', 1.23)[0].name, 'Odsetki');
  // Ta sama płatność na dwóch kontach to dwie transakcje.
  const zabki = by('2026-10-24', -23.5);
  assert.equal(zabki.length, 2);
  assert.notEqual(zabki[0].id, zabki[1].id);
  // Żadnych numerów kont ani kart w nazwach i tytułach.
  assert.ok(txs.every((t) => !/\d{10,}|\d{4,6}-{3,}\d{4}/.test(`${t.name} ${t.title}`)));
  assert.ok(!txs.some((t) => t.amount < 0 && t.name === 'ANNA NOWAK' && t.title === ''));
  // Ten sam plik drugi raz – te same ID.
  const again = await readFile(fixture('bnp-like.xlsx'));
  assert.deepEqual(again.transactions.map((t) => t.id), txs.map((t) => t.id));
});

test('xlsx: wspólna tablica tekstów, formatowanie, encje, style dat, arkusz o innej nazwie', async () => {
  const { readXlsx } = await import('../src/xlsx.js');
  const rows = await readXlsx(fixture('shared-strings.xlsx'));
  assert.deepEqual(rows, [
    ['Data transakcji', 'Kwota', 'Odbiorca', 'Opis'],
    ['2026-10-31', '-1234.5', 'Sklep "Pod Lipą" & Syn', 'Linia 1\r\nLinia 2'],
    ['2026-11-01', '12', 'Inline'],
    []
  ]);
});

test('konto po numerze: karta i konto z tym samym numerem to jedno konto', () => {
  assert.equal(accountDisplay('BNP', 'Konto Osobiste\n11111111111111111111115424'), 'BNP •5424');
  assert.equal(accountDisplay('BNP', 'Karta Otwarta na Dzisiaj\n11111111111111111111115424'), 'BNP •5424');
  assert.equal(accountDisplay('BNP', '11111111111111111111115424'), 'BNP •5424');
  assert.equal(accountDisplay('', 'Konto Osobiste\n11111111111111111111115424'), 'Rachunek •5424');
  assert.equal(accountDisplay('ING', ''), 'ING');
  assert.equal(accountDisplay('BNP', 'Konto Osobiste'), 'BNP · Konto Osobiste');
});

test('ID z pliku BNP są stałe (zmiana = duplikaty u użytkowniczki)', async () => {
  const r = await readFile(fixture('bnp-like.xlsx'), 'BNP');
  assert.deepEqual(r.transactions.map((t) => t.id),
    ['zeb71j', '1eh588c', '1woxh9u', '1ge0klb', 'a44mif', 'u6h15s', '18tgpz', '7re6e9', '1mt5mgt']);
  assert.deepEqual(r.accounts, ['BNP •0001', 'BNP •0002']);
});
