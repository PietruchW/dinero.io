// Service worker: aplikacja działa offline. Strategia „najpierw sieć”:
// online zawsze dostajesz najnowszą wersję z GitHub Pages, offline – kopię
// z pamięci podręcznej. Dane użytkowniczki nie przechodzą przez ten plik.

const CACHE = 'dinero-shell-v19';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/csv.js',
  './src/detect.js',
  './src/categorize.js',
  './src/importer.js',
  './src/xlsx.js',
  './src/store.js',
  './src/ai.js',
  './src/config.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // cache: 'no-cache' – zawsze pytamy serwer, czy plik się zmienił (bez tego
  // przeglądarka mogła do 10 minut podawać starą wersję z własnej pamięci).
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
