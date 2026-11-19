# Dinero

Prosta aplikacja do pilnowania domowego budżetu. Wczytujesz wyciąg z banku (CSV),
a aplikacja dzieli wydatki na kategorie i pokazuje, ile poszło w danym miesiącu.

**Wszystko dzieje się na Twoim telefonie.** Wyciągi są czytane w przeglądarce
i zapisywane tylko w jej pamięci. Nic nie trafia na żaden serwer.

## Jak zainstalować na iPhonie

1. Otwórz adres aplikacji w **Safari**.
2. Stuknij **Udostępnij** → **Do ekranu początkowego**.
3. Uruchamiaj aplikację z ikonki – otwiera się na pełnym ekranie i działa też offline.

## Jak używać

1. W banku pobierz historię konta jako **CSV**.
2. W aplikacji: **Import** → wybierz plik → sprawdź kolumny → **Importuj**.
   Ten sam okres możesz wczytać ponownie – duplikaty są pomijane.
3. W **Transakcjach** popraw kategorie. Z włączonym „Zapamiętuj kategorię dla sklepu”
   kolejne zakupy w tym sklepie trafią do tej kategorii same.
4. W **Ustawieniach** wpisz swoje imię i nazwisko jak w banku – przelewy między Twoimi
   kontami przestaną liczyć się jako wydatki.
5. Raz w miesiącu: **Ustawienia** → **Zapisz kopię** (do Plików lub iCloud).

## Dla deweloperów

Bez zależności i bez kroku budowania.

```sh
npm test      # testy (Node ≥ 20)
npm start     # podgląd na http://localhost:8080
```

Zasady pracy z repozytorium: [CLAUDE.md](CLAUDE.md).
