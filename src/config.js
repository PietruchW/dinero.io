// Adres pośrednika AI (Cloudflare Worker, katalog worker/). Pusty = funkcja AI ukryta.
// Po ustawieniu dopisz ten sam adres (sam origin) do connect-src w CSP w index.html.
// Numer wersji aplikacji – pokazywany w Ustawieniach. Musi się zgadzać
// z nazwą pamięci podręcznej w sw.js (dinero-shell-v<numer>) – pilnuje tego test.
export const APP_VERSION = 14;

export const AI_URL = 'https://dinero-ai.w-pietraszewski.workers.dev';
