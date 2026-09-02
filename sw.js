/* サービスワーカー：一度開けば Wi-Fi が無くても使えるようにする */
const VERSION = 'pm-sched-v5';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(VERSION)
      .then(function(c){
        // data.js は手元でだけ置くファイル。無くても失敗させない
        return c.addAll(SHELL).then(function(){ return c.add('./data.js').catch(function(){}); });
      })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys()
      .then(function(keys){
        return Promise.all(keys.filter(function(k){ return k!==VERSION; })
                              .map(function(k){ return caches.delete(k); }));
      })
      .then(function(){ return self.clients.claim(); })
  );
});

/* 画面ファイルはキャッシュ優先。裏で新しいものを取りに行って次回に備える */
self.addEventListener('fetch', function(e){
  const req = e.request;
  if(req.method !== 'GET') return;
  if(new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function(hit){
      const net = fetch(req).then(function(res){
        if(res && res.status === 200){
          const copy = res.clone();
          caches.open(VERSION).then(function(c){ c.put(req, copy); });
        }
        return res;
      }).catch(function(){
        // オフライン。キャッシュにも無ければトップを返す
        return hit || caches.match('./index.html');
      });
      return hit || net;
    })
  );
});
