// Service Worker: 缓存静态资源，支持离线打开。兼容 Gitee Pages 子路径与根路径。
var CACHE_NAME = 'chatroom-pwa-v5';
// 以 sw.js 所在目录为基址，兼容子路径部署（如 /仓库名/）
var SW_BASE = self.location.pathname.replace(/[^/]*$/, '');
function swAsset(p){ return SW_BASE + p.replace(/^\//, ''); }
var STATIC_ASSETS = [
  swAsset('/'),
  swAsset('index.html'),
  swAsset('app.js?v=20261013r'),
  swAsset('manifest.json'),
  swAsset('icon-192.png'),
  swAsset('icon-512.png')
];
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);
  // 跨域请求（Supabase REST/Realtime）不拦截，直接放行
  if (url.origin !== self.location.origin) return;
  // 只缓存 GET 同源静态资源
  if (event.request.method !== 'GET') return;
  // 导航请求：网络优先，失败回退缓存
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match(swAsset('index.html'));
      })
    );
    return;
  }
  // 静态资源：缓存优先，未命中则走网络并缓存
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
        }
        return response;
      });
    })
  );
});
