// Service worker : permet d'installer le site comme application et de l'ouvrir même sans réseau (coquille de l'appli).
// Réseau d'abord : on a toujours la dernière version quand on est en ligne ; le cache ne sert qu'hors ligne.
// Jamais de cache pour l'API, ni pour Supabase (messages, images, fichiers : tout reste en direct).
const CACHE = 'classe-shell-v1';
const SHELL = ['/', '/style.css', '/config.js', '/js/theme.js', '/js/app.js', '/js/shared.js', '/js/backend-supabase.js', '/js/backend-demo.js', '/vendor/supabase.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error()))),
  );
});
