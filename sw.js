/* サービスワーカー：一度開けば Wi-Fi が無くても使えるようにする */
const VERSION = 'pm-sched-v8';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './firebase-config.js',
  './sync.js',
  './pdf-import.js'
];

/* 同期に使うライブラリ。ここもキャッシュしておかないと、圏外で開いたときに読み込めない */
const SDK = 'https://www.gstatic.com/firebasejs/11.6.1/';
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const LIBS = [SDK+'firebase-app.js', SDK+'firebase-auth.js', SDK+'firebase-firestore.js',
              PDFJS+'pdf.min.js', PDFJS+'pdf.worker.min.js'];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(VERSION)
      .then(function(c){
        // data.js は手元でだけ置くファイル。無くても失敗させない
        return c.addAll(SHELL)
          .then(function(){ return c.add('./data.js').catch(function(){}); })
          .then(function(){ return Promise.all(LIBS.map(function(u){ return c.add(u).catch(function(){}); })); });
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
  const url = new URL(req.url);
  /* 同期の通信（Firestore・ログイン）は素通しする。オフライン対応はFirestore側が持っている */
  if(url.hostname.indexOf('googleapis.com')>=0 || url.hostname.indexOf('firebaseapp.com')>=0
     || url.hostname.indexOf('google.com')>=0) return;
  /* ライブラリはキャッシュ優先で返す（圏外でも起動できるように） */
  if(url.href.indexOf(SDK)===0 || url.href.indexOf(PDFJS)===0){
    e.respondWith(caches.match(req).then(function(hit){
      return hit || fetch(req).then(function(res){
        const copy = res.clone();
        caches.open(VERSION).then(function(c){ c.put(req, copy); });
        return res;
      });
    }));
    return;
  }
  if(url.origin !== self.location.origin) return;

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
