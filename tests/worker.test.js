import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, validateItems, parseResults } from '../worker/src/index.js';

const ORIGIN = 'https://pietruchw.github.io';
const env = { ANTHROPIC_API_KEY: 'test-key', ALLOWED_ORIGIN: ORIGIN, MODEL: 'test-model' };
const items = [
  { id: 'zdunek mamuszki', name: 'Zdunek Mamuszki Gdansk', amount: -1772.01 },
  { id: 'cafe x', name: 'Cafe X', amount: -14 }
];

function req(body, { origin = ORIGIN, method = 'POST', path = '/categorize' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return new Request(`https://dinero-ai.example.workers.dev${path}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
}

function fakeClaude(text, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  };
}

test('worker: poprawne zapytanie zwraca tylko kategorie z listy', async () => {
  const calls = [];
  const answer = '{"results":[{"id":"zdunek mamuszki","category":"Transport"},{"id":"cafe x","category":"Kawa"},{"id":"obcy","category":"Zakupy"}]}';
  const res = await handle(req({ items }), env, fakeClaude(answer, calls));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await res.json(), { results: [{ id: 'zdunek mamuszki', category: 'Transport' }] });
  // Do API idzie klucz z sekretu i model z konfiguracji; w treści tylko nazwy i kwoty.
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, 'test-model');
  assert.deepEqual(JSON.parse(sent.messages[0].content), { items });
});

test('worker: obcy Origin i brak Origin są odrzucane bez wywołania API', async () => {
  const calls = [];
  for (const origin of ['https://evil.example', null]) {
    const res = await handle(req({ items }, { origin }), env, fakeClaude('{}', calls));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(calls.length, 0);
});

test('worker: preflight, zła ścieżka, zła metoda', async () => {
  assert.equal((await handle(req(null, { method: 'OPTIONS' }), env)).status, 204);
  assert.equal((await handle(req({ items }, { path: '/' }), env)).status, 404);
  assert.equal((await handle(req(null, { method: 'GET' }), env)).status, 405);
});

test('worker: limit zapytań i brak klucza', async () => {
  const limited = { ...env, LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await handle(req({ items }), limited, fakeClaude('{}'))).status, 429);
  assert.equal((await handle(req({ items }), { ...env, ANTHROPIC_API_KEY: '' }, fakeClaude('{}'))).status, 503);
});

test('worker: błąd API nie wycieka treścią', async () => {
  const failing = async () => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 });
  const res = await handle(req({ items }), env, failing);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'upstream_error', status: 401 });
});

test('validateItems: limity i typy', () => {
  assert.equal(validateItems({ items: [] }), null);
  assert.equal(validateItems({ items: Array.from({ length: 41 }, (_, i) => ({ id: `${i}`, name: 'x', amount: 1 })) }), null);
  assert.equal(validateItems({ items: [{ id: 'a', name: 'x', amount: 'dużo' }] }), null);
  assert.equal(validateItems({ items: [{ id: 'a', name: '   ', amount: 1 }] }), null);
  const long = validateItems({ items: [{ id: 'a', name: 'x'.repeat(500), amount: -1.239 }] });
  assert.equal(long[0].name.length, 120);
  assert.equal(long[0].amount, -1.24);
});

test('parseResults: odporność na śmieci wokół JSON', () => {
  assert.deepEqual(parseResults('Oto wynik: {"results":[{"id":"cafe x","category":"Wyjścia"}]} Gotowe.', items),
    [{ id: 'cafe x', category: 'Wyjścia' }]);
  assert.deepEqual(parseResults('nie wiem', items), []);
  assert.deepEqual(parseResults('{"results": "nie"}', items), []);
});
