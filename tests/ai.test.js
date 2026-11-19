import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectForAI, applyAIResults, requestCategories } from '../src/ai.js';
import { emptyState, mergeTransactions, setCategory, recategorize, monthSummary } from '../src/store.js';

function stateWith(tx) {
  return mergeTransactions(emptyState(), tx).state;
}

const tx = [
  { id: '1', date: '2026-11-14', amount: -1772.01, name: 'Zdunek Mamuszki Gdansk', title: '' },
  { id: '2', date: '2026-11-13', amount: -50, name: 'Zdunek Mamuszki Gdansk', title: '' },
  { id: '3', date: '2026-11-12', amount: -100, name: 'Anna Nowak', title: 'Przelew na telefon BLIK' },
  { id: '4', date: '2026-11-11', amount: -86.4, name: 'LIDL', title: '' },
  { id: '5', date: '2026-11-10', amount: 25, name: 'Nieznany Zwrot', title: '' },
  { id: '6', date: '2026-11-09', amount: -30, name: 'Cafe Bez Nazwy', title: '' }
];

test('selectForAI: tylko nierozpoznane wydatki, bez przelewów, każdy sklep raz', () => {
  // Lidl i „Cafe…” rozpoznają słowa kluczowe, przelew do osoby i zwrot nie idą do AI.
  assert.deepEqual(selectForAI(stateWith(tx)), [
    { id: 'zdunek mamuszki', name: 'Zdunek Mamuszki Gdansk', amount: -1772.01 }
  ]);
});

test('selectForAI: pomija sklepy z regułą użytkowniczki lub AI i ręczne zmiany', () => {
  let state = stateWith(tx);
  state = setCategory(state, '1', 'Transport', true);
  assert.deepEqual(selectForAI(state), []);
  assert.equal(selectForAI(stateWith(tx), 0).length, 0);
});

test('applyAIResults: reguły AI, przeliczenie, odrzucenie złych kategorii', () => {
  const { state, applied } = applyAIResults(stateWith(tx), [
    { id: 'zdunek mamuszki', category: 'Transport' },
    { id: 'cos', category: 'Przychód' },
    { id: 'inny', category: 'Nie ma' },
    null
  ]);
  assert.equal(applied, 1);
  assert.deepEqual(state.aiRules, { 'zdunek mamuszki': 'Transport' });
  const z = state.transactions.filter((t) => t.name.startsWith('Zdunek'));
  assert.ok(z.every((t) => t.category === 'Transport' && t.source === 'ai' && !t.needsReview));
  assert.equal(monthSummary(state, '2026-11').byCategory['Transport'], 1822.01);
  // Reguła AI przetrwa ponowne przeliczenie (np. przy starcie aplikacji).
  assert.equal(recategorize(state).transactions.find((t) => t.id === '1').category, 'Transport');
  // Ręczny wybór ma pierwszeństwo przed AI.
  const manual = setCategory(state, '1', 'Zakupy', false);
  assert.equal(recategorize(manual).transactions.find((t) => t.id === '1').category, 'Zakupy');
});

test('requestCategories: poprawna odpowiedź i błędy po polsku', async () => {
  const ok = async (url, init) => {
    assert.equal(url, 'https://ai.example/categorize');
    assert.deepEqual(JSON.parse(init.body), { items: [{ id: 'a', name: 'A', amount: -1 }] });
    return new Response('{"results":[{"id":"a","category":"Zakupy"}]}', { status: 200 });
  };
  assert.deepEqual(await requestCategories('https://ai.example/', [{ id: 'a', name: 'A', amount: -1 }], ok),
    [{ id: 'a', category: 'Zakupy' }]);
  const limited = async () => new Response('{}', { status: 429 });
  await assert.rejects(requestCategories('https://ai.example', [], limited), /Za dużo zapytań/);
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(requestCategories('https://ai.example', [], offline), /Brak połączenia/);
});
