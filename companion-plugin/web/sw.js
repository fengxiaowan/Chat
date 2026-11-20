const CACHE = 'companion-shell-v20261120c';
const SHELL = [
  '/liao',
  '/liao/app.js?v=20261120c',
  '/liao/style.css?v=20261116e',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/liao')) return;
  // API、聊天流和音频必须拿新数据；只有页面壳和静态资源走缓存回退。
  if (url.pathname === '/liao' || url.pathname === '/liao/app.js' || url.pathname === '/liao/style.css' || url.pathname === '/liao/sw.js') {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => caches.match(event.request).then((cached) => cached || new Response('offline', { status: 503 }))),
    );
  }
});
