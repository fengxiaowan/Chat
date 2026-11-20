// 服务端已用 immutable 缓存头处理静态资源，这里不再做任何拦截，彻底排除 SW 干扰。
// 保留空壳以便旧注册能顺利被新版本接管并自我注销。
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister()),
  );
});

self.addEventListener('fetch', () => {
  // 不拦截任何请求。
});
