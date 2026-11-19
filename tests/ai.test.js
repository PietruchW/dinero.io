import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectForAI, applyAIResults, requestCategories, generateAccessCode } from '../src/ai.js';
import { exportBackup, importBackup, setAiToken } from '../src/store.js';
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
    assert.equal(init.headers.Authorization, 'Bearer kod-123');
    assert.deepEqual(JSON.parse(init.body), { items: [{ id: 'a', name: 'A', amount: -1 }] });
    return new Response('{"results":[{"id":"a","category":"Zakupy"}]}', { status: 200 });
  };
  assert.deepEqual(await requestCategories('https://ai.example/', [{ id: 'a', name: 'A', amount: -1 }], 'kod-123', ok),
    [{ id: 'a', category: 'Zakupy' }]);
  const limited = async () => new Response('{}', { status: 429 });
  await assert.rejects(requestCategories('https://ai.example', [], 'k', limited), /Za dużo zapytań/);
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(requestCategories('https://ai.example', [], 'k', offline), /Brak połączenia/);
});

test('AI „Inne” zostawia transakcję do sprawdzenia, ale nie wysyła jej ponownie', () => {
  const { state } = applyAIResults(stateWith(tx), [{ id: 'zdunek mamuszki', category: 'Inne' }]);
  const z = state.transactions.find((t) => t.id === '1');
  assert.equal(z.category, 'Inne');
  assert.equal(z.needsReview, true);
  assert.equal(z.source, 'ai');
  assert.deepEqual(selectForAI(state), []);
});

test('kod dostępu: losowy, długi i poza kopią zapasową', async () => {
  const a = generateAccessCode();
  const b = generateAccessCode();
  assert.notEqual(a, b);
  assert.match(a, /^dn-[A-Za-z0-9_-]{24}$/);
  const state = setAiToken(stateWith(tx), `  ${a} `);
  assert.equal(state.settings.aiToken, a);
  const backup = exportBackup(state);
  assert.ok(!backup.includes(a));
  assert.equal(importBackup(backup).settings.aiToken, '');
  const unauthorized = async () => new Response('{}', { status: 401 });
  await assert.rejects(requestCategories('https://ai.example', [], 'zly', unauthorized), /kod dostępu/);
});

test('buildChatContext: okres, bez przelewów własnych, przelewy bez nazwisk', async () => {
  const { setOwnerNames } = await import('../src/store.js');
  const { buildChatContext } = await import('../src/ai.js');
  let state = stateWith([
    ...tx,
    { id: '7', date: '2026-08-01', amount: -10, name: 'LIDL', title: '' },
    { id: '8', date: '2026-11-15', amount: -500, name: 'Jan Kowalski', title: 'Przelew własny' }
  ]);
  state = setOwnerNames(state, ['Jan Kowalski']);
  const ctx = buildChatContext(state, 1, '2026-11-19');
  assert.equal(ctx.from, '2026-11');
  assert.equal(ctx.to, '2026-11');
  assert.equal(ctx.today, '2026-11-19');
  const names = ctx.transactions.map((t) => t[2]);
  assert.ok(!names.includes('Jan Kowalski'));
  assert.ok(!names.includes('Anna Nowak'));
  assert.ok(names.includes('przelew wychodzący'));
  assert.ok(!ctx.transactions.some((t) => t[0].startsWith('2026-08')));
  assert.equal(ctx.summary['2026-11'].byCategory['Jedzenie'], 86.4);
  const wider = buildChatContext(state, 6, '2026-11-19');
  assert.equal(wider.from, '2026-08');
});

test('requestChat i historia czatu', async () => {
  const { requestChat, loadChat, saveChat } = await import('../src/ai.js');
  const ok = async (url, init) => {
    assert.equal(url, 'https://ai.example/chat');
    assert.equal(init.headers.Authorization, 'Bearer k');
    return new Response('{"reply":"Najwięcej na jedzenie."}', { status: 200 });
  };
  assert.equal(await requestChat('https://ai.example', 'k', [{ role: 'user', content: 'Hej' }], {}, ok),
    'Najwięcej na jedzenie.');
  const empty = async () => new Response('{"reply":""}', { status: 200 });
  await assert.rejects(requestChat('https://ai.example', 'k', [], {}, empty), /nie odpowiedziało/);
  const data = {};
  const storage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
  saveChat(storage, Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}` })));
  assert.equal(loadChat(storage).length, 30);
  assert.deepEqual(loadChat({ getItem: () => '{zepsute' }), []);
});
