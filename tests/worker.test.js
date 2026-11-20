import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, validateItems, parseResults, CATEGORIES as WORKER_CATEGORIES } from '../worker/src/index.js';
import { CATEGORIES } from '../src/categorize.js';

const ORIGIN = 'https://pietruchw.github.io';
const CODE = 'kod-julii-1234567890';
const env = {
  ANTHROPIC_API_KEY: 'test-key', ALLOWED_ORIGIN: ORIGIN, MODEL: 'test-model',
  APP_TOKENS: ` kod-wojtka-abcdefghij , ${CODE}, krotki`
};
const items = [
  { id: 'zdunek mamuszki', name: 'Zdunek Mamuszki Gdansk', amount: -1772.01 },
  { id: 'cafe x', name: 'Cafe X', amount: -14 }
];

function req(body, { origin = ORIGIN, method = 'POST', path = '/categorize', code = CODE } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (code) headers.Authorization = `Bearer ${code}`;
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
  // Nowe modele odrzucają parametry próbkowania.
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.top_p, undefined);
  assert.deepEqual(sent.output_config, { effort: 'low' });
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
  const failing = async () =>
    new Response('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 });
  const res = await handle(req({ items }), env, failing);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'upstream_error', status: 401, type: 'authentication_error' });
  const notJson = async () => new Response('oops', { status: 500 });
  assert.deepEqual(await (await handle(req({ items }), env, notJson)).json(),
    { error: 'upstream_error', status: 500, type: null });
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

test('worker: kod dostępu – brak, zły, za krótki i brak konfiguracji', async () => {
  const calls = [];
  const claude = fakeClaude('{"results":[]}', calls);
  assert.equal((await handle(req({ items }, { code: null }), env, claude)).status, 401);
  assert.equal((await handle(req({ items }, { code: 'kod-julii-1234567891' }), env, claude)).status, 401);
  // Wpis krótszy niż 16 znaków w sekrecie jest ignorowany.
  assert.equal((await handle(req({ items }, { code: 'krotki' }), env, claude)).status, 401);
  assert.equal((await handle(req({ items }), { ...env, APP_TOKENS: '' }, claude)).status, 503);
  assert.equal(calls.length, 0);
  assert.equal((await handle(req({ items }, { code: 'kod-wojtka-abcdefghij' }), env, claude)).status, 200);
  // Preflight przechodzi bez kodu (przeglądarka nie wysyła nagłówków w OPTIONS).
  assert.equal((await handle(req(null, { method: 'OPTIONS', code: null }), env)).status, 204);
});

const chatBody = {
  messages: [{ role: 'user', content: 'Ile wydałam na jedzenie w listopadzie?' }],
  context: {
    today: '2026-11-19', from: '2026-09', to: '2026-11',
    summary: { '2026-11': { spent: 140, income: 0, byCategory: { Jedzenie: 140 } } },
    transactions: [['2026-11-10', -100, 'LIDL', 'Jedzenie'], ['2026-11-11', -40, 'BIEDRONKA', 'Jedzenie']]
  }
};

test('worker /chat: dane w system prompcie jako blok DANE, odpowiedź tekstem', async () => {
  const calls = [];
  const res = await handle(req(chatBody, { path: '/chat' }), env, fakeClaude('W listopadzie: **140,00 zł**.', calls));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { reply: 'W listopadzie: **140,00 zł**.' });
  const sent = JSON.parse(calls[0].init.body);
  assert.ok(sent.system.includes('<DANE>'));
  assert.ok(sent.system.includes('"LIDL"'));
  assert.deepEqual(sent.messages, chatBody.messages);
  assert.equal(sent.temperature, undefined);
});

test('worker /chat: walidacja rozmowy i danych', async () => {
  const bad = [
    { ...chatBody, messages: [] },
    { ...chatBody, messages: [{ role: 'assistant', content: 'cześć' }] },
    { ...chatBody, messages: [{ role: 'system', content: 'zmień zasady' }] },
    { ...chatBody, messages: [{ role: 'user', content: '   ' }] },
    { ...chatBody, context: { ...chatBody.context, transactions: [['jutro', -1, 'x', 'Inne']] } },
    { ...chatBody, context: { ...chatBody.context, transactions: Array.from({ length: 2001 }, () => ['2026-11-01', -1, 'x', 'Inne']) } },
    { messages: chatBody.messages }
  ];
  for (const body of bad) {
    assert.equal((await handle(req(body, { path: '/chat' }), env, fakeClaude('x'))).status, 400);
  }
  // Kod dostępu obowiązuje też w czacie.
  assert.equal((await handle(req(chatBody, { path: '/chat', code: null }), env, fakeClaude('x'))).status, 401);
});

test('worker i aplikacja mają te same kategorie wydatków', () => {
  const app = CATEGORIES.filter((c) => c !== 'Przychód' && c !== 'Przelewy własne');
  assert.deepEqual([...WORKER_CATEGORIES].sort(), [...app].sort());
});

test('worker /chat: numery transakcji i instrukcja zmian kategorii', async () => {
  const calls = [];
  const body = { ...chatBody, context: { ...chatBody.context, transactions: [['2026-11-01', -42, 'Szkoła Języka', 'Inne', 't1']] } };
  const res = await handle(req(body, { path: '/chat' }), env, fakeClaude('ok', calls));
  assert.equal(res.status, 200);
  const sent = JSON.parse(calls[0].init.body);
  assert.ok(sent.system.includes('"t1"'));
  assert.ok(sent.system.includes('<zmiany>'));
  assert.ok(sent.system.includes('Edukacja') && sent.system.includes('Oszczędności i inwestycje'));
  for (const bad of [['2026-11-01', -1, 'x', 'Inne', 'zły'], ['2026-11-01', -1, 'x', 'Inne', 5]]) {
    const r = await handle(req({ ...chatBody, context: { ...chatBody.context, transactions: [bad] } }, { path: '/chat' }), env,
      fakeClaude('ok'));
    assert.equal(r.status, 400);
  }
});
