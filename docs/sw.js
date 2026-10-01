// 应用壳离线缓存：API 不缓存（现场数据必须走实时接口或 IndexedDB 队列）。
const CACHE = 'manual-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // 永远不缓存接口数据
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
