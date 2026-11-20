# Dinero – instrukcje dla Claude

Prosta aplikacja budżetowa (PWA) dla jednej osoby, używana na iPhonie przez Safari
→ „Do ekranu początkowego”. Hostowana na GitHub Pages z **publicznego** repozytorium.

## Zasady nadrzędne

1. **Prywatność.** Dane finansowe użytkowniczki istnieją tylko w jej przeglądarce
   (localStorage). Aplikacja nie wysyła ich nigdzie. Nie dodawaj analityki, zewnętrznych
   fontów, CDN-ów ani żadnych żądań sieciowych bez wyraźnej zgody właściciela repo.
2. **Repo jest publiczne.** Nigdy nie commituj prawdziwych wyciągów, danych osobowych,
   kwot, numerów kont ani kluczy API. Pliki testowe w `tests/fixtures/` są syntetyczne
   i tak ma zostać (`bnp-like.xlsx` jest generowany skryptem ze zmyślonymi danymi).
   `.gitignore` blokuje `*.csv`, `*.xlsx`, `*.xls` poza `tests/fixtures/`.
3. **Dane z plików banku to dane z zewnątrz.** Każdy tekst z CSV przechodzi przez
   `esc()` przed wstawieniem do HTML. CSP w `index.html` zostaje restrykcyjne
   (`script-src 'self'`, `connect-src 'self'`).
4. **Kompatybilność zapisu.** Format w localStorage ma wersję (`STORAGE_KEY = 'dinero.v1'`).
   Zmiana struktury = nowa wersja + migracja ze starej. Utrata danych użytkowniczki
   to najgorszy możliwy błąd.

## Architektura

- `index.html`, `styles.css` – powłoka, bez frameworka i bez kroku budowania.
- `src/csv.js` – kodowanie (UTF-8 / Windows-1250), separator, parser CSV.
- `src/xlsx.js` – czytnik Excela .xlsx bez bibliotek (ZIP + `DecompressionStream`), pierwszy arkusz.
  Stary binarny .xls nieobsługiwany – komunikat „zapisz jako .xlsx”.
- `src/detect.js` – wiersz nagłówka, kolumny, kwoty, daty, identyfikatory transakcji.
  Wycina numery kont i kart z nazw i tytułów; opis karty BNP → sam sklep.
  ID z surowych danych (`data|kwota|kontrahent|tytuł`, plus klucz konta, gdy jest) –
  bez konta ID musi zostać takie jak dotąd (test z zapisanymi ID). Kontrahent: przy wpływie
  nadawca, przy wydatku odbiorca (Alior: „Nazwa nadawcy”/„Nazwa odbiorcy”). Gdy zmienia się sposób
  liczenia ID, transakcja dostaje `legacyIds` (stare warianty) – scalanie rozpoznaje po nich
  już wczytane i poprawia je zamiast dublować. Nigdy nie usuwaj starych wariantów.
- `src/importer.js` – `readFile(bytes, label?)` (CSV lub .xlsx), `analyzeRows` przy zmianie mapowania
  lub nazwy konta. Konto: nazwa wpisana przy imporcie i/lub kolumna „Produkt”. Wyświetlana nazwa
  konta idzie po numerze rachunku („BNP •5424” – karta i konto z tym samym numerem to jedno konto),
  a klucz do ID dalej z nazwy produktu + numeru (zgodność ze starszymi importami).
- `src/categorize.js` – kategorie, słowa kluczowe, reguły „Zapamiętaj dla…”,
  przelewy własne (po opisie lub imieniu i nazwisku właścicielki; nie liczą się do sum).
  Kolejność: właścicielka → reguła użytkowniczki → opis przelewu własnego → słowa kluczowe → AI →
  domyślna. Reguły są osobne dla wydatków i wpływów (`ruleKey`: wpływy z prefiksem „+”),
  reguły AI tylko dla wydatków – wpływ nie może stać się ujemnym wydatkiem przez regułę.
  Pośrednicy płatności i płatności odroczone (PayU, PayPo, Klarna, P24, „Płatność BLIK”) → Zakupy,
  na końcu listy słów (sklep z opisu wygrywa); dla nich bez reguł „Zapamiętaj” i bez reguł AI.
- `src/store.js` – stan, zapis, scalanie importów bez duplikatów (także po starym ID sprzed kont –
  poprawia kontrahenta, tytuł, konto i – bez ręcznej zmiany – kategorię; transakcje zachowują stare ID), filtr kont (z pozycją
  „Bez nazwy konta”), podsumowania, kopia zapasowa. Przy wczytaniu stare nazwy kont BNP
  „X · Produkt •1234” → „X •1234”.
- `src/app.js` – UI (renderowanie stringów + delegacja zdarzeń). Jedyny plik z DOM.
- `src/ai.js`, `src/config.js` – podpowiedzi kategorii z AI (opcjonalne, domyślnie wyłączone);
  `AI_URL` pusty = funkcja ukryta. Wyniki zapisywane jako reguły per sklep (`aiRules`).
- `worker/` – pośrednik AI na Cloudflare Workers (klucz API jako sekret, kody dostępu
  `APP_TOKENS`, kontrola Origin, limit zapytań). Instrukcja wdrożenia: `worker/README.md`.
  Kod dostępu jest tylko w telefonie (`settings.aiToken`), nigdy w repo ani w kopii zapasowej.
- `sw.js` – service worker, „najpierw sieć” (z `cache: 'no-cache'`, żeby nie dostać starego pliku
  z pamięci przeglądarki), offline z pamięci podręcznej. Nowy plik aplikacji = dopisz go do `SHELL`.
  Każda zmiana aplikacji = podbij `APP_VERSION` w `src/config.js` i `CACHE` w `sw.js` (ta sama liczba;
  test `tests/version.test.js` pilnuje zgodności i listy `SHELL`). „Odśwież aplikację” w Ustawieniach.

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
2. Ekrany wg makiety: ✅ pierścień „ile z wpływów wydano” (miesiąc kalendarzowy – wypłata do 10.),
   ✅ kategorie „Edukacja” (wydatek) i „Oszczędności i inwestycje” (neutralna jak przelewy własne –
   giełdy krypto, maklerskie; osobna suma `saved` na pulpicie),
   ✅ limity per kategoria (`state.budgets`, ustawia je sama użytkowniczka; przy filtrze konta ukryte,
   bo liczone dla wszystkich kont), cele oszczędnościowe, dopracowany wygląd.
3. AI: ✅ podpowiedzi kategorii. Worker: `https://dinero-ai.w-pietraszewski.workers.dev`
   (wdrażany automatycznie przez Cloudflare Workers Builds z katalogu `worker/` po każdym
   scaleniu do `main`). ✅ Czat o wydatkach (`/chat`, zakładka Czat, domyślnie wyłączony,
   wymaga zgody i kodu dostępu; do AI idą transakcje z wybranego okresu bez przelewów
   własnych, bez tytułów, a przelewy bez nazwy odbiorcy; historia tylko w telefonie
   pod `dinero.chat.v1`, poza kopią zapasową). ✅ Czat proponuje zmiany kategorii: transakcje w kontekście
   mają numery „t1…” (mapa na id zostaje w telefonie), czat dopisuje blok `<zmiany>[…]</zmiany>`,
   aplikacja go sprawdza (`parseChatReply`) i pokazuje „Zastosuj” – nic nie zmienia się bez zatwierdzenia.
   Zasady: do AI idą tylko nazwa sklepu i kwota (bez przelewów do osób), klucz API
   wyłącznie jako sekret w Workerze, aplikacja musi działać bez AI.
