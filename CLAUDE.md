# Dinero – instrukcje dla Claude

Prosta aplikacja budżetowa (PWA) dla jednej osoby, używana na iPhonie przez Safari
→ „Do ekranu początkowego”. Hostowana na GitHub Pages z **publicznego** repozytorium.

## Zasady nadrzędne

1. **Prywatność.** Dane finansowe użytkowniczki istnieją tylko w jej przeglądarce
   (localStorage). Aplikacja nie wysyła ich nigdzie. Nie dodawaj analityki, zewnętrznych
   fontów, CDN-ów ani żadnych żądań sieciowych bez wyraźnej zgody właściciela repo.
2. **Repo jest publiczne.** Nigdy nie commituj prawdziwych wyciągów, danych osobowych,
   kwot, numerów kont ani kluczy API. Pliki testowe w `tests/fixtures/` są syntetyczne
   i tak ma zostać.
3. **Dane z plików banku to dane z zewnątrz.** Każdy tekst z CSV przechodzi przez
   `esc()` przed wstawieniem do HTML. CSP w `index.html` zostaje restrykcyjne
   (`script-src 'self'`, `connect-src 'self'`).
4. **Kompatybilność zapisu.** Format w localStorage ma wersję (`STORAGE_KEY = 'dinero.v1'`).
   Zmiana struktury = nowa wersja + migracja ze starej. Utrata danych użytkowniczki
   to najgorszy możliwy błąd.

## Architektura

- `index.html`, `styles.css` – powłoka, bez frameworka i bez kroku budowania.
- `src/csv.js` – kodowanie (UTF-8 / Windows-1250), separator, parser CSV.
- `src/detect.js` – wiersz nagłówka, kolumny, kwoty, daty, identyfikatory transakcji.
- `src/importer.js` – `readStatement(bytes, mapping?)`: jedno wejście do importu.
- `src/categorize.js` – kategorie, słowa kluczowe, reguły „Zapamiętaj dla…”,
  przelewy własne (po opisie lub imieniu i nazwisku właścicielki; nie liczą się do sum).
- `src/store.js` – stan, zapis, scalanie importów bez duplikatów, podsumowania, kopia zapasowa.
- `src/app.js` – UI (renderowanie stringów + delegacja zdarzeń). Jedyny plik z DOM.
- `src/ai.js`, `src/config.js` – podpowiedzi kategorii z AI (opcjonalne, domyślnie wyłączone);
  `AI_URL` pusty = funkcja ukryta. Wyniki zapisywane jako reguły per sklep (`aiRules`).
- `worker/` – pośrednik AI na Cloudflare Workers (klucz API jako sekret, kontrola Origin,
  limit zapytań). Instrukcja wdrożenia: `worker/README.md`.
- `sw.js` – service worker, „najpierw sieć”, offline z pamięci podręcznej.
  Nowy plik aplikacji = dopisz go do listy `SHELL`.

Moduły poza `app.js` są czyste (bez DOM) i testowane w Node.

## Workflow

- Gałąź → PR → zielone CI → przegląd → squash-merge do `main`. Bez pushy do `main`.
- W tym repo Claude sam pushuje gałąź, otwiera PR i scala go (squash) – ale dopiero
  po zielonym CI i własnym przejrzeniu zmian (decyzja właściciela repo z 19.11.2026).
  Nadal nigdy nie pushuje bezpośrednio do `main`.
- `npm test` (Node ≥ 20, wbudowany `node:test`, zero zależności) musi przechodzić.
- Zmiana UI: sprawdź w przeglądarce w widoku 390×844 przed PR.
- Wszystko po polsku: interfejs, komunikaty, komentarze w kodzie.

## Plan

1. ✅ Fundament: import CSV, kategorie, zapis lokalny, kopia zapasowa, PWA.
2. Ekrany wg makiety: limity per kategoria, cele oszczędnościowe, dopracowany wygląd.
3. AI: ✅ podpowiedzi kategorii. Worker: `https://dinero-ai.w-pietraszewski.workers.dev`
   (wdrażany automatycznie przez Cloudflare Workers Builds z katalogu `worker/` po każdym
   scaleniu do `main`). Do zrobienia: podsumowanie miesiąca.
   Zasady: do AI idą tylko nazwa sklepu i kwota (bez przelewów do osób), klucz API
   wyłącznie jako sekret w Workerze, aplikacja musi działać bez AI.
