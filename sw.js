// Офлайн-режим каталогу. Онлайн сторінка завжди береться з мережі (і оновлює збережену копію),
// без інтернету — зі збереженої копії. Ігри мають власні sw.js у своїх папках; цей лише для файлів каталогу.
// Після зміни списку FILES збільшити номер у CACHE, щоб браузери забрали нову копію.
const CACHE = 'catalog-v11';
const FILES = ['./', './index.html', './manifest.webmanifest', './lock.js', './account.js', './teacher/', './teacher/index.html',
               './fonts/fonts.css', './fonts/baloo2-latin.woff2', './fonts/nunitosans-cyrillic.woff2', './fonts/nunitosans-latin.woff2',
               './icons/icon-192.png', './icons/icon-512.png', './img/emblem.png',
               './img/typing-race-kids.jpg', './img/balloon-race-kids.jpg', './img/water-race-kids.jpg', './img/hot-keys.jpg', './img/mouse-race-kids.jpg', './img/double-click-kids.jpg', './img/word-bricks-kids.jpg', './img/keyboard-residents-kids.jpg'];
const PATHS = FILES.map(f=>new URL(f, self.registration.scope).pathname);
// Картинки, шрифти й значки каталогу — і ті, яких ще немає у FILES: нова картка гри показується без інтернету,
// навіть поки не встановилася нова версія цього файлу. Змінюються рідко, тож спершу збережена копія
const STABLE = /^\/(img|fonts|icons)\//;
const TIMEOUT = 5000;   // повільна мережа в класі — після 5 с беремо збережену копію

// Що завантажувати, вирішують хеші: files.json поруч із цим файлом (а для спільних файлів сайту — /files.json каталогу)
// містить git-хеш кожного файлу, його оновлює .githooks/pre-commit. Файл качається, лише коли збереженої копії з таким
// хешем немає ніде на сайті. ETag тут не годиться: GitHub Pages міняє його в усіх файлів після кожного push
const SCOPE = new URL(self.registration.scope).pathname;
const LIMIT = 30000;   // файл, що качається довше 30 с, не тримає решту: збережеться наступного разу
// Каталог показує «Зберігаю ігри…», лише коли справді щось качається
const news = self.BroadcastChannel ? new BroadcastChannel('offline-save') : null;

// './' і './guide/' — ті самі файли, що './index.html' і './guide/index.html': качаємо раз, зберігаємо під обома адресами
const source = f=>{ const p = new URL(f, self.registration.scope).pathname; return p.endsWith('/') ? p + 'index.html' : p; };

// На кеш браузера не покладаємось: на комп'ютерах класу він часто порожній
async function download(path){
  const stop = new AbortController(), t = setTimeout(()=>stop.abort(), LIMIT);
  try{
    const res = await fetch(path, { cache:'no-store', signal:stop.signal });
    if(!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const headers = new Headers(res.headers);
    headers.delete('Content-Encoding'); headers.delete('Content-Length');   // тіло вже розпаковане
    return new Response(await res.arrayBuffer(), { status:200, headers });
  }finally{ clearTimeout(t); }
}
// Git-хеш вмісту, як у files.json
async function hashOf(res){
  const body = new Uint8Array(await res.clone().arrayBuffer()), head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map(b=>b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
async function wanted(){
  const want = {};
  for(const base of new Set([SCOPE, '/']))
    for(const [f, h] of Object.entries(await (await download(base + 'files.json')).json())) want[base + f] = h;
  return want;
}
// Копія з потрібним хешем у будь-якому сховищі сайту: цієї версії, попередньої, каталогу чи іншої гри (спільні файли)
async function copyOf(path, hash){
  for(const k of await caches.keys()){
    const r = await (await caches.open(k)).match(path);
    if(r && await hashOf(r) === hash) return r;
  }
}

// atomic — оновлення на прохання каталогу: записуємо все разом, коли завантажено все, напівоновленої копії не буває.
// Інакше (встановлення) кожен файл записується одразу, і наступне відкриття докачує лише решту
async function sync(atomic){
  const c = await caches.open(CACHE), want = await wanted(), writes = [];
  const groups = new Map();
  for(const f of FILES){ const p = source(f); groups.set(p, [...(groups.get(p) || []), f]); }
  let told = false, failed = 0;
  await Promise.all([...groups].map(async ([p, keys])=>{
    const stale = [];
    for(const f of keys){ const r = await c.match(f); if(!r || await hashOf(r) !== want[p]) stale.push(f); }
    if(!stale.length) return;
    let res = await copyOf(p, want[p]);
    if(!res){
      if(!told && news){ told = true; news.postMessage(SCOPE); }
      try{ res = await download(p); }catch(e){ failed++; return; }
    }
    for(const f of stale) atomic ? writes.push([f, res.clone()]) : await c.put(f, res.clone());
  }));
  if(failed) throw new Error(`${CACHE}: не завантажено ${failed}`);
  await Promise.all(writes.map(([f, res])=>c.put(f, res)));
}
self.addEventListener('install', e=>{
  e.waitUntil(sync(false).then(()=>self.skipWaiting()));
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
  const stable = STABLE.test(url.pathname);
  if(!stable && !PATHS.includes(url.pathname)) return;                 // сторінки й файли ігор — їхнім sw.js
  const fromCache = ()=>caches.match(req, { ignoreSearch:true });
  // Відповідь з помилкою (буває, коли зв'язок ледь живий) не замінює збережену копію
  const net = ()=>fetch(req).then(res=>{
    if(!res.ok) throw new Error('HTTP ' + res.status);
    if(res.status === 200){ const copy = res.clone(); caches.open(CACHE).then(c=>c.put(req.url.split('?')[0], copy)); }
    return res;
  });
  if(stable){   // свіжу копію принесе оновлення від каталогу
    e.respondWith(fromCache().then(r=>r || net()).catch(()=>Response.error()));
    return;
  }
  const fromNet = net();
  const slow = new Promise((_, reject)=>setTimeout(()=>reject(new Error('timeout')), TIMEOUT));
  // Немає збереженої копії — чекаємо на мережу й далі: повільно, але відкриється
  e.respondWith(Promise.race([fromNet, slow]).catch(()=>fromCache().then(r=>r || fromNet)).catch(()=>Response.error()));
});

// Оновлення збереженої копії на прохання каталогу; каталогу відповідаємо, чи вдалося
self.addEventListener('message', e=>{
  if(e.data !== 'refresh') return;
  const port = e.ports[0];
  e.waitUntil(sync(true).then(()=>true, ()=>false).then(ok=>{ if(port) port.postMessage(ok); }));
});
