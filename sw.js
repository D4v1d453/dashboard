// =============================================================
// Service worker — makes the dashboard installable and usable offline.
// Bump CACHE_VERSION whenever you want every device to drop old caches.
//
//   Pages (navigations)       → network-first, fall back to cache, then offline.html
//   Same-origin JS/CSS/etc.   → stale-while-revalidate (instant load, refreshes in background)
//   Icons / progress photos   → cache-first (files never change)
//   CDN libraries (jsDelivr)  → stale-while-revalidate
//   Supabase / other APIs     → network-only (data lives in localStorage + sync)
// =============================================================
const CACHE_VERSION = 'v1';
const SHELL_CACHE = 'shell-' + CACHE_VERSION;
const RUNTIME_CACHE = 'runtime-' + CACHE_VERSION;

const SHELL = [
  '/',
  '/index.html',
  '/health.html',
  '/gym.html',
  '/finance.html',
  '/po-water.html',
  '/offline.html',
  '/topbar.js',
  '/sync.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  return /\.supabase\.co$/.test(url.hostname) && !url.pathname.startsWith('/storage/v1/object/public/')
    || url.hostname === 'api.anthropic.com'
    || url.hostname === 'open.er-api.com';
}
function isPhoto(url) {
  return /\.supabase\.co$/.test(url.hostname) && url.pathname.startsWith('/storage/v1/object/public/');
}

async function networkFirstPage(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // "/" and "/index.html" are the same page
    const url = new URL(request.url);
    if (url.pathname === '/') {
      const idx = await caches.match('/index.html');
      if (idx) return idx;
    }
    return caches.match('/offline.html');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, res.clone());
  }
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await caches.match(request);
  const network = fetch(request).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;            // let POST/upserts go straight to network
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (isApi(url)) return;                            // network-only: live data
  if (isPhoto(url) || (url.origin === self.location.origin && url.pathname.startsWith('/icons/'))) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(request));
  }
});
