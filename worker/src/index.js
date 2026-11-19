// Pośrednik AI dla Dinero (Cloudflare Worker).
// Przyjmuje listę nierozpoznanych sklepów z aplikacji, pyta Claude o kategorie
// i zwraca tylko nazwy kategorii. Klucz API jest sekretem Workera (nigdy w repo).
// Dostęp tylko z kodem (sekret APP_TOKENS) – adres Workera jest jawny, kody nie.
// Worker niczego nie zapisuje i nie loguje treści zapytań.

export const CATEGORIES = [
  'Jedzenie',
  'Wyjścia',
  'Zakupy',
  'Transport',
  'Podróże',
  'Kosmetyki i zdrowie',
  'Rachunki',
  'Subskrypcje',
  'Inne'
];

const MAX_ITEMS = 40;
const MAX_NAME = 120;
const MAX_BODY = 20000;

const SYSTEM_PROMPT = `Jesteś klasyfikatorem transakcji z polskich wyciągów bankowych.
Dla każdej pozycji (nazwa sklepu lub firmy i kwota w PLN) wybierz dokładnie jedną kategorię z listy:
- Jedzenie: supermarkety, sklepy spożywcze, piekarnie, targi
- Wyjścia: restauracje, kawiarnie, bary, jedzenie na wynos i dostawy, kino, teatr, koncerty, rozrywka
- Zakupy: ubrania, elektronika, dom i wyposażenie, sklepy internetowe, prezenty
- Transport: codzienne dojazdy – paliwo, serwis i części samochodowe, myjnie, parkingi, komunikacja miejska, taksówki
- Podróże: wyjazdy i urlopy – linie lotnicze, hotele, noclegi, biura podróży, wypożyczalnie aut za granicą
- Kosmetyki i zdrowie: drogerie, apteki, lekarze, dentysta, fryzjer, kosmetyczka, siłownia
- Rachunki: prąd, gaz, internet, telefon, czynsz, ubezpieczenia
- Subskrypcje: serwisy streamingowe, aplikacje, abonamenty cyfrowe
- Inne: wszystko pozostałe albo gdy nie masz pewności
Nie zgaduj na siłę – przy wątpliwości wybierz „Inne”.
Odpowiedz wyłącznie obiektem JSON bez komentarzy, w formacie:
{"results":[{"id":"<id z wejścia>","category":"<kategoria z listy>"}]}`;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(body), { status, headers });
}

/** Porównanie w stałym czasie (nie zdradza, ile znaków kodu się zgadza). */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Kody dostępu z sekretu APP_TOKENS (oddzielone przecinkami, min. 16 znaków).
 * Zwraca 'ok', 'missing_config' albo 'denied'.
 */
export function checkAccess(request, env) {
  const tokens = String(env.APP_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length >= 16);
  if (tokens.length === 0) return 'missing_config';
  const header = request.headers.get('Authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!given) return 'denied';
  let ok = false;
  for (const t of tokens) ok = safeEqual(t, given) || ok;
  return ok ? 'ok' : 'denied';
}

/** Sprawdza i czyści wejście. Zwraca listę pozycji albo null przy złym formacie. */
export function validateItems(data) {
  if (!data || !Array.isArray(data.items) || data.items.length === 0 || data.items.length > MAX_ITEMS) return null;
  const items = [];
  for (const it of data.items) {
    if (!it || typeof it.id !== 'string' || typeof it.name !== 'string' || typeof it.amount !== 'number') return null;
    if (it.id.length === 0 || it.id.length > 80 || !Number.isFinite(it.amount)) return null;
    const name = it.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_NAME);
    if (!name) return null;
    items.push({ id: it.id, name, amount: Math.round(it.amount * 100) / 100 });
  }
  return items;
}

/** Wyciąga wyniki z odpowiedzi modelu; ignoruje nieznane id i kategorie spoza listy. */
export function parseResults(text, items) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!data || !Array.isArray(data.results)) return [];
  const ids = new Set(items.map((i) => i.id));
  const seen = new Set();
  const out = [];
  for (const r of data.results) {
    if (!r || !ids.has(r.id) || seen.has(r.id) || !CATEGORIES.includes(r.category)) continue;
    seen.add(r.id);
    out.push({ id: r.id, category: r.category });
  }
  return out;
}

/**
 * Obsługa zapytania. `fetchImpl` podmieniany w testach.
 * @param {Request} request
 * @param {{ANTHROPIC_API_KEY: string, ALLOWED_ORIGIN: string, MODEL?: string, LIMITER?: {limit(o: {key: string}): Promise<{success: boolean}>}}} env
 */
export async function handle(request, env, fetchImpl = fetch) {
  const origin = request.headers.get('Origin');
  const allowed = origin && origin === env.ALLOWED_ORIGIN ? origin : null;
  const url = new URL(request.url);

  if (url.pathname !== '/categorize') return json(404, { error: 'not_found' }, allowed);
  if (!allowed) return json(403, { error: 'forbidden' }, null);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(allowed) });
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, allowed);
  if (!env.ANTHROPIC_API_KEY) return json(503, { error: 'not_configured' }, allowed);

  const access = checkAccess(request, env);
  if (access === 'missing_config') return json(503, { error: 'not_configured' }, allowed);
  if (access === 'denied') return json(401, { error: 'unauthorized' }, allowed);

  if (env.LIMITER) {
    const key = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.LIMITER.limit({ key });
    if (!success) return json(429, { error: 'too_many_requests' }, allowed);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'too_large' }, allowed);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json(400, { error: 'bad_json' }, allowed);
  }
  const items = validateItems(data);
  if (!items) return json(400, { error: 'bad_items' }, allowed);

  let upstream;
  try {
    upstream = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: env.MODEL || 'claude-sonnet-5-5',
        // Sonnet 5.5 nie przyjmuje temperature/top_p/top_k (błąd 400).
        // Klasyfikacja nie wymaga głębokiego myślenia – niski „effort” jest szybszy i tańszy.
        max_tokens: 4000,
        output_config: { effort: 'low' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ items }) }]
      })
    });
  } catch {
    return json(502, { error: 'upstream_unreachable' }, allowed);
  }
  if (!upstream.ok) {
    // Do aplikacji idzie tylko kod i typ błędu API – bez treści komunikatu.
    let type = null;
    try {
      type = (await upstream.json())?.error?.type ?? null;
    } catch {
      type = null;
    }
    return json(502, { error: 'upstream_error', status: upstream.status, type }, allowed);
  }
  const body = await upstream.json();
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return json(200, { results: parseResults(text, items) }, allowed);
}

export default {
  fetch(request, env) {
    return handle(request, env);
  }
};
