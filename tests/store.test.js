import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readStatement } from '../src/importer.js';
import { categorize, merchantKey } from '../src/categorize.js';
import {
  emptyState, mergeTransactions, setCategory, monthSummary, months,
  loadState, saveState, exportBackup, importBackup, STORAGE_KEY
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
