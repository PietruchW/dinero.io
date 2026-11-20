import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readStatement, readFile } from '../src/importer.js';
import { categorize, merchantKey } from '../src/categorize.js';
import {
  emptyState, mergeTransactions, setCategory, monthSummary, months,
  loadState, saveState, exportBackup, importBackup, STORAGE_KEY, setOwnerNames, recategorize, accounts, forAccount,
  spendingRatio, setBudgets, budgetRows, averageSpending, EXPENSE_CATEGORIES
} from '../src/store.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    data
  };
}

test('categorize: słowa kluczowe, kolejność i zwroty', () => {
  assert.equal(categorize({ name: 'LIDL SP. Z O.O.', amount: -10 }).category, 'Jedzenie');
  assert.equal(categorize({ name: 'UBER EATS', amount: -10 }).category, 'Wyjścia');
  assert.equal(categorize({ name: 'UBER *TRIP', amount: -10 }).category, 'Transport');
  assert.equal(categorize({ name: 'ZALANDO SE', amount: 59.9 }).category, 'Zakupy');
  assert.equal(categorize({ name: 'Firma X', amount: 100 }).category, 'Przychód');
  const unknown = categorize({ name: 'Anna Nowak', amount: -50 });
  assert.equal(unknown.category, 'Inne');
  assert.equal(unknown.needsReview, true);
  // „pge” nie może pasować do środka innego słowa.
  assert.equal(categorize({ name: 'SKEPGEX', amount: -5 }).category, 'Inne');
});

test('merchantKey: ignoruje cyfry i formy prawne', () => {
  assert.equal(merchantKey('LIDL SP. Z O.O. SP.K. GDAŃSK'), 'lidl gdansk');
  assert.equal(merchantKey('ROSSMANN 123 GDANSK'), 'rossmann gdansk');
  assert.equal(merchantKey('Zalando SE'), 'zalando se');
});

test('import dwa razy tego samego pliku nie dubluje danych', () => {
  const { transactions } = readStatement(fixture('ing-like-cp1250.csv'));
  const first = mergeTransactions(emptyState(), transactions);
  assert.equal(first.added, 9);
  const second = mergeTransactions(first.state, transactions);
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 9);
  assert.equal(second.state.transactions.length, 9);
});

test('setCategory z zapamiętaniem przestawia sklep i przyszłe importy', () => {
  const { transactions } = readStatement(fixture('ing-like-cp1250.csv'));
  let { state } = mergeTransactions(emptyState(), transactions);
  const kawa = state.transactions.find((t) => t.name === 'Kawiarnia Pod Lipą');
  assert.equal(kawa.category, 'Wyjścia');
  const blik = state.transactions.find((t) => t.name === 'Anna Nowak');
  assert.equal(blik.category, 'Inne');
  assert.equal(blik.needsReview, true);
  state = setCategory(state, blik.id, 'Wyjścia', true);
  const changed = state.transactions.find((t) => t.id === blik.id);
  assert.equal(changed.category, 'Wyjścia');
  assert.equal(changed.needsReview, false);
  assert.equal(changed.manual, true);
  assert.equal(state.rules['anna nowak'], 'Wyjścia');
  // Kolejny import od tej osoby trafia od razu do zapamiętanej kategorii.
  assert.equal(categorize({ name: 'ANNA NOWAK', amount: -20 }, state.rules).category, 'Wyjścia');
  // Bez zapamiętania reguła nie powstaje.
  const kawy = state.transactions.filter((t) => t.name === 'Kawiarnia Pod Lipą');
  state = setCategory(state, kawy[0].id, 'Jedzenie', false);
  assert.equal(state.rules['kawiarnia pod'], undefined);
  assert.equal(state.transactions.find((t) => t.id === kawy[1].id).category, 'Wyjścia');
  assert.throws(() => setCategory(state, blik.id, 'Nie ma takiej'));
});

test('monthSummary: wydatki, zwroty i przychód', () => {
  const { transactions } = readStatement(fixture('ing-like-cp1250.csv'));
  const { state } = mergeTransactions(emptyState(), transactions);
  const s = monthSummary(state, '2026-10');
  assert.equal(s.income, 6450);
  // Zakupy: 189,00 − zwrot 59,90.
  assert.equal(s.byCategory['Zakupy'], 129.1);
  assert.equal(s.byCategory['Jedzenie'], 86.4);
  assert.equal(s.spent, 86.4 + 129.1 + 28 + 50 + 62 + 23.5);
  assert.deepEqual(months(state), ['2026-10']);
});

test('zapis i odczyt stanu; uszkodzony zapis daje pusty stan', () => {
  const storage = memoryStorage();
  const { transactions } = readStatement(fixture('ing-like-cp1250.csv'));
  const { state } = mergeTransactions(emptyState(), transactions);
  saveState(storage, state);
  assert.equal(loadState(storage).transactions.length, 9);
  const broken = memoryStorage({ [STORAGE_KEY]: '{nie json' });
  assert.deepEqual(loadState(broken), emptyState());
});

test('kopia zapasowa: eksport, import i odrzucenie obcego pliku', () => {
  const { transactions } = readStatement(fixture('ing-like-cp1250.csv'));
  const { state } = mergeTransactions(emptyState(), transactions);
  const restored = importBackup(exportBackup(state));
  assert.equal(restored.transactions.length, 9);
  assert.throws(() => importBackup('{"app":"inna"}'));
  assert.throws(() => importBackup('{"app":"dinero","version":1,"transactions":[{"id":1}]}'));
});

test('przelewy własne: rozpoznanie po opisie i po imieniu i nazwisku', async () => {
  const { isOwner } = await import('../src/categorize.js');
  assert.equal(categorize({ name: 'Anna Nowak', title: 'Przelew własny', amount: -500 }).category, 'Przelewy własne');
  assert.equal(categorize({ name: 'X', title: 'Przelew wewnętrzny', amount: 300 }).category, 'Przelewy własne');
  assert.equal(isOwner('NOWAK ANNA MARIA UL. DŁUGA 1', ['Anna Nowak']), true);
  assert.equal(isOwner('Firma Anny Nowak', ['Anna Nowak']), false);
  assert.equal(isOwner('Anna Kowalska', ['Anna Nowak']), false);
  // Samo imię to za mało – zbyt łatwo o pomyłkę.
  assert.equal(isOwner('Anna', ['Anna']), false);
  const owner = categorize({ name: 'ANNA NOWAK', title: 'Przelew wychodzący', amount: -1000 }, {}, ['Anna Nowak']);
  assert.equal(owner.category, 'Przelewy własne');
  assert.equal(owner.needsReview, false);
});

test('przelewy własne nie liczą się do wydatków ani wpływów', () => {
  const tx = [
    { id: 'a', date: '2026-11-10', amount: -100, name: 'Lidl', title: '' },
    { id: 'b', date: '2026-11-11', amount: -5000, name: 'Anna Nowak', title: 'Przelew wychodzący' },
    { id: 'c', date: '2026-11-11', amount: 5000, name: 'Anna Nowak', title: 'Przelew przychodzący' },
    { id: 'd', date: '2026-11-12', amount: 4000, name: 'Pracodawca SA', title: 'Wynagrodzenie' }
  ];
  let { state } = mergeTransactions(emptyState(), tx);
  assert.equal(monthSummary(state, '2026-11').spent, 5100);
  state = setOwnerNames(state, [' Anna Nowak ', '', 'Anna Nowak']);
  assert.deepEqual(state.settings.ownerNames, ['Anna Nowak']);
  const s = monthSummary(state, '2026-11');
  assert.equal(s.spent, 100);
  assert.equal(s.income, 4000);
  assert.equal(s.neutral, 10000);
});

test('ponowne przeliczenie kategorii nie rusza ręcznych wyborów', () => {
  const tx = [{ id: 'b', date: '2026-11-11', amount: -50, name: 'Anna Nowak', title: '' }];
  let { state } = mergeTransactions(emptyState(), tx);
  state = setCategory(state, 'b', 'Wyjścia', false);
  state = setOwnerNames(state, ['Anna Nowak']);
  assert.equal(state.transactions[0].category, 'Wyjścia');
  assert.equal(recategorize(state).transactions[0].category, 'Wyjścia');
});

test('zapis z poprzedniej wersji (bez ustawień) wczytuje się bez utraty danych', () => {
  const old = { version: 1, transactions: [{ id: 'x', date: '2026-10-01', amount: -5, name: 'Lidl', title: '',
    currency: 'PLN', category: 'Jedzenie', needsReview: false, manual: false }], rules: {}, budgets: {}, goals: [] };
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(old) });
  const loaded = loadState(storage);
  assert.equal(loaded.transactions.length, 1);
  assert.deepEqual(loaded.settings, { ownerNames: [], aiEnabled: false, aiToken: '', chatEnabled: false, chatMonths: 3 });
  assert.deepEqual(loaded.aiRules, {});
});

test('kategoria Podróże: linie lotnicze i noclegi, ale nie stacja Lotos', () => {
  assert.equal(categorize({ name: 'RYANAIR DESIGNATED ACTIVI', amount: -766 }).category, 'Podróże');
  assert.equal(categorize({ name: 'Hotel at Booking.com Amsterdam NL', amount: -292 }).category, 'Podróże');
  assert.equal(categorize({ name: 'ETIHADAIR6072417098093', amount: -11081 }).category, 'Podróże');
  assert.equal(categorize({ name: 'LOTOS STACJA 12', amount: -200 }).category, 'Transport');
  assert.equal(categorize({ name: 'Airbnb * HMXYZ', amount: -900 }).category, 'Podróże');
});

test('kategoria Długi: raty, PayPo, odsetki; wpływ z odsetkami to przychód', () => {
  const cat = (name, amount, title = '') => categorize({ name, title, amount }).category;
  assert.equal(cat('PAYPO SP. Z O.O.', -200), 'Długi');
  assert.equal(cat('Klarna AB', -89.9), 'Długi');
  assert.equal(cat('PayPo', -50, 'Allegro zamówienie 123'), 'Długi');
  assert.equal(cat('Bank', -312.4, 'Spłata raty kredytu'), 'Długi');
  assert.equal(cat('Odsetki', -120), 'Długi');
  assert.equal(cat('Operacja kredytowa', -1800, 'Kredyt B123 Spłata kapitału wymagalnego'), 'Długi');
  assert.equal(cat('Odsetki', 1.23), 'Przychód');
  assert.equal(cat('Prowizje i opłaty', -8), 'Rachunki');
  // Nazwisko „Ratajczak” to nie rata.
  assert.equal(cat('Jan Ratajczak', -50), 'Inne');
});

test('wyciąg z dwóch kont w jednym pliku: przelew między nimi jest neutralny', async () => {
  const r = await readFile(fixture('bnp-like.xlsx'));
  const state = mergeTransactions(setOwnerNames(emptyState(), ['Anna Nowak']), r.transactions).state;
  assert.ok(state.transactions.every((t) => t.legacyId === undefined));
  const own = state.transactions.filter((t) => t.category === 'Przelewy własne');
  assert.equal(own.length, 2);
  assert.deepEqual(accounts(state), ['Konto Osobiste •0001', 'Konto Oszczędnościowe •0002']);
  const savings = forAccount(state, 'Konto Oszczędnościowe •0002');
  assert.ok(savings.transactions.every((t) => t.account === 'Konto Oszczędnościowe •0002'));
  assert.equal(monthSummary(savings, '2026-10').spent, 23.5);
  assert.equal(forAccount(state, null), state);
});

test('ponowny import z nazwą konta: bez duplikatów, stare transakcje dostają konto', () => {
  const before = mergeTransactions(emptyState(), readStatement(fixture('ing-like-cp1250.csv')).transactions).state;
  const ing = readStatement(fixture('ing-like-cp1250.csv'), undefined, 'ING').transactions;
  const { state, added, duplicates } = mergeTransactions(before, ing);
  assert.equal(added, 0);
  assert.equal(duplicates, ing.length);
  assert.ok(state.transactions.every((t) => t.account === 'ING'));
  // Identyfikatory zostają stare – reguły i ręczne kategorie dalej pasują.
  assert.deepEqual(state.transactions.map((t) => t.id).sort(), before.transactions.map((t) => t.id).sort());
  // Ten sam plik jako inne konto to nowe transakcje.
  const other = mergeTransactions(state, readStatement(fixture('ing-like-cp1250.csv'), undefined, 'Wspólne').transactions);
  assert.equal(other.added, ing.length);
  assert.deepEqual(accounts(other.state), ['ING', 'Wspólne']);
});

test('pierścień: część wpływów wydana, progi i brak wpływów', () => {
  assert.equal(spendingRatio({ spent: 500, income: 0 }), null);
  assert.deepEqual(spendingRatio({ spent: 2160, income: 3000 }), { ratio: 0.72, percent: 72, left: 840, level: 'ok' });
  assert.equal(spendingRatio({ spent: 2400, income: 3000 }).level, 'warn');
  const over = spendingRatio({ spent: 3340, income: 3000 });
  assert.equal(over.level, 'over');
  assert.equal(over.left, -340);
  assert.equal(over.percent, 111);
});

test('limity: zapis, usuwanie, tylko kategorie wydatków; przetrwają zapis i kopię', () => {
  let state = setBudgets(emptyState(), { 'Jedzenie': 1200.456, 'Wyjścia': 400, 'Przychód': 100, 'Nieznana': 5 });
  assert.deepEqual(state.budgets, { 'Jedzenie': 1200.46, 'Wyjścia': 400 });
  state = setBudgets(state, { 'Wyjścia': null, 'Zakupy': 0, 'Jedzenie': 900 });
  assert.deepEqual(state.budgets, { 'Jedzenie': 900 });
  assert.ok(!EXPENSE_CATEGORIES.includes('Przychód') && !EXPENSE_CATEGORIES.includes('Przelewy własne'));
  assert.ok(EXPENSE_CATEGORIES.includes('Długi'));
  const storage = memoryStorage();
  saveState(storage, state);
  assert.deepEqual(loadState(storage).budgets, { 'Jedzenie': 900 });
  assert.deepEqual(importBackup(exportBackup(state)).budgets, { 'Jedzenie': 900 });
});

test('limity: śmieci w zapisie są pomijane, reszta danych zostaje', () => {
  const storage = memoryStorage();
  const state = mergeTransactions(emptyState(), readStatement(fixture('ing-like-cp1250.csv')).transactions).state;
  saveState(storage, { ...state, budgets: { 'Jedzenie': 500, 'Zakupy': -3, 'Wyjścia': '200', 'Przychód': 10 } });
  const loaded = loadState(storage);
  assert.deepEqual(loaded.budgets, { 'Jedzenie': 500 });
  assert.equal(loaded.transactions.length, state.transactions.length);
});

test('budgetRows: progi, kategorie z limitem bez wydatków, kolejność', () => {
  const summary = { byCategory: { 'Jedzenie': 850, 'Wyjścia': 320, 'Zakupy': 1200, 'Inne': 40, 'Transport': -15 } };
  const rows = budgetRows(summary, { 'Jedzenie': 1000, 'Wyjścia': 300, 'Zakupy': 2000, 'Subskrypcje': 100 });
  assert.deepEqual(rows.map((r) => r.category), ['Zakupy', 'Jedzenie', 'Wyjścia', 'Inne', 'Subskrypcje']);
  const by = Object.fromEntries(rows.map((r) => [r.category, r]));
  assert.equal(by['Zakupy'].level, 'ok');
  assert.equal(by['Jedzenie'].level, 'warn');
  assert.equal(by['Jedzenie'].left, 150);
  assert.equal(by['Wyjścia'].level, 'over');
  assert.equal(by['Wyjścia'].left, -20);
  assert.equal(by['Inne'].limit, null);
  assert.equal(by['Subskrypcje'].spent, 0);
  assert.equal(by['Subskrypcje'].level, 'ok');
});

test('averageSpending: średnia z pełnych miesięcy przed wybranym', () => {
  const tx = (id, date, amount, category) =>
    ({ id, date, amount, name: 'X', title: '', currency: 'PLN', category, needsReview: false, source: 'keyword', manual: false });
  const state = { ...emptyState(), transactions: [
    tx('a', '2026-11-05', -999, 'Jedzenie'),
    tx('b', '2026-10-05', -300, 'Jedzenie'), tx('c', '2026-09-05', -500, 'Jedzenie'),
    tx('d', '2026-08-05', -400, 'Jedzenie'), tx('e', '2026-07-05', -9000, 'Jedzenie'),
    tx('f', '2026-10-06', -90, 'Wyjścia')
  ] };
  assert.deepEqual(averageSpending(state, '2026-11'), { 'Jedzenie': 400, 'Wyjścia': 30 });
  assert.deepEqual(averageSpending(state, '2026-07'), {});
});
