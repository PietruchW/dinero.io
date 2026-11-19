# Pośrednik AI (Cloudflare Worker)

Mały serwer, który przyjmuje z aplikacji nazwy nierozpoznanych sklepów i kwoty,
pyta Claude o kategorie i odsyła same nazwy kategorii.

- Klucz API Anthropic jest **sekretem Workera** – nie ma go w repo ani w aplikacji.
- Przyjmuje zapytania tylko z `ALLOWED_ORIGIN` (adres aplikacji), najwyżej 10 na minutę z jednego IP,
  najwyżej 40 sklepów naraz.
- Niczego nie zapisuje i nie loguje treści zapytań.
- Do AI nie trafiają: daty, numery kont, tytuły przelewów ani przelewy do osób
  (aplikacja ich nie wysyła).

## Wdrożenie (raz)

1. **Klucz API z limitem.** W Claude Console utwórz osobny klucz tylko dla tej aplikacji
   i ustaw mu niski miesięczny limit wydatków (np. 5 USD). Nawet przy nadużyciu nie
   wydasz więcej niż limit.
2. **Konto Cloudflare** (darmowe): https://dash.cloudflare.com/sign-up
3. Na komputerze, w katalogu `worker/` tego repo:
   ```sh
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put ANTHROPIC_API_KEY   # wklej klucz z kroku 1
   ```
4. `wrangler deploy` wypisze adres w stylu `https://dinero-ai.<twoja-nazwa>.workers.dev`.
   Ten adres trzeba wpisać w `src/config.js` aplikacji i w CSP w `index.html`.

## Testy

Testy Workera są w `tests/worker.test.js` i uruchamiają się razem z resztą (`npm test`).
