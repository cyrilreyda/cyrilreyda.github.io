// Офлайн-режим каталогу. Онлайн сторінка завжди береться з мережі (і оновлює збережену копію),
// без інтернету — зі збереженої копії. Ігри мають власні sw.js у своїх папках; цей лише для файлів каталогу.
// Після зміни списку FILES збільшити номер у CACHE, щоб браузери забрали нову копію.
const CACHE = 'catalog-v1';
const FILES = ['./', './index.html', './manifest.webmanifest',
               './fonts/fonts.css', './fonts/baloo2-latin.woff2', './fonts/nunitosans-cyrillic.woff2', './fonts/nunitosans-latin.woff2',
               './icons/icon-192.png', './icons/icon-512.png', './img/emblem.png',
               './img/typing-race-kids.jpg', './img/hot-keys.jpg', './img/mouse-race-kids.jpg', './img/double-click-kids.jpg'];
const PATHS = FILES.map(f=>new URL(f, self.registration.scope).pathname);
const TIMEOUT = 5000;   // повільна мережа в класі — після 5 с беремо збережену копію

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
// Видаляємо лише старі версії каталогу: ігри сайту зберігають свої копії в тому самому сховищі.
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys()
    .then(keys=>Promise.all(keys.filter(k=>k.startsWith('catalog-') && k !== CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  const req = e.request, url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== location.origin) return;   // чужі сайти — без змін
  if(!PATHS.includes(url.pathname)) return;                            // сторінки й файли ігор — їхнім sw.js
  const fromCache = ()=>caches.match(req, { ignoreSearch:true }).then(r=>r || Response.error());
  const fromNet = fetch(req).then(res=>{
    if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=>c.put(req.url.split('?')[0], copy)); }
    return res;
  });
  const slow = new Promise((_, reject)=>setTimeout(()=>reject(new Error('timeout')), TIMEOUT));
  e.respondWith(Promise.race([fromNet, slow]).catch(fromCache));
});
