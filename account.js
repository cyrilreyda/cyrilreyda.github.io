// Спільний акаунт учня для каталогу й усіх ігор сайту. Підключається в <head> після /lock.js: <script src="/account.js">.
// Учень входить один раз: PIN класу → себе зі списку → дві картинки (тварина і їжа). Вхід і прогрес бачать усі ігри сайту,
// бо localStorage у них спільний, а через сервер (Google Таблиця, account/Code.gs) — і на інших пристроях.
// Гра працює з даними на пристрої й не чекає сервера: зміни стають у чергу й відправляються, щойно є зв'язок.
// Без зв'язку увійти може той, хто вже входив на цьому пристрої (картинки перевіряються по збереженій копії),
// решта грає як гість, а прогрес гостя можна додати собі при наступному вході.
// Якщо API не задано (або гру розпаковано з архіву й /account.js поруч немає), window.Account немає,
// і гра працює по-старому: зі своїм вікном «Як тебе звати?».
//
// Для гри:
//   Account.ready(fn)        — fn(), коли є учень чи гість; якщо ще ні — спершу вікно входу
//   Account.user             — { id, label, full, guest, cls }: label — нік або «Оля К.», full — «Нік (Оля К.)»,
//                              cls — ключ класу (однаковий у всього класу, назви класу з нього не дізнатися)
//   Account.get(key)         — збережені дані гри (об'єкт) або null; key — як STORE_KEY гри
//   Account.save(key, data)  — зберегти дані гри (на пристрої одразу, на сервері — щойно буде зв'язок)
//   Account.shared(name)     — копія спільного для всіх ігор об'єкта (напр. 'pace' — швидкість друку) або {}
//   Account.setShared(name, value) — зберегти його
//   Account.on('update', fn) — fn(key, data): дані змінилися з іншого пристрою (дані вже зведено й збережено)
//   Account.logout()         — вийти; сторінка перезавантажується й показує вхід
//   Account.confirmReset(key, data) — скинути прогрес гри: учень підтверджує картинками, сервер записує data (новий порожній
//                              прогрес). Проміс: true — скинуто, false — скасовано чи немає інтернету. Гість — одразу true
//   Account.played()         — учень завершив раунд у цій грі (для «Моїх ігор» і наліпок за кількість ігор)
//   Account.showGames()      — вікно «Мої ігри» (гра відкриває його кліком на аватар у профілі)
(()=>{
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Адреса вебзастосунку Apps Script (Розгорнути → Керувати розгортаннями). Порожня — акаунта немає, ігри працюють по-старому
  const API = LOCAL ? 'http://localhost:8790/' : 'https://script.google.com/macros/s/AKfycbzntwAHNQg8lN-XZS6ZVeb6cgmUEsdviwB45gfOW8C9ww6X6rbocgquVLVGCLlNKhOv/exec';
  if(!API) return;

  const IDLE_CONFIRM = 10 * 60e3;   // після стількох хвилин без дій спитати «Це ти?» з картинками (перерва: за комп'ютер сів інший учень)
  const LOCAL_TRIES = 5;            // стільки помилок з картинками без сервера — і копія для входу без інтернету стирається
  const ANIMALS = [['🐱','кіт'],['🐶','песик'],['🐘','слон'],['🦒','жираф'],['🐸','жабка'],['🐧','пінгвін'],['🐙','восьминіг'],['🦋','метелик'],['🐞','сонечко']];
  const FOODS = [['🍎','яблуко'],['🍌','банан'],['🍉','кавун'],['🍇','виноград'],['🥕','морква'],['🍕','піца'],['🍦','морозиво'],['🍩','пончик'],['🧀','сир']];
  const SESSION = 'acc-session';           // { uid, last } — хто зараз грає на цьому пристрої
  const DATA = uid=>'acc-data:' + uid;      // { user, token, docs:{ key:{ v, data, dirty, rev } } } — прогрес учня на пристрої
  const VERIFY = uid=>'acc-verify:' + uid;  // { salt, hash } — для входу без інтернету
  const ROSTER = h=>'acc-class:' + h;       // список класу для входу без інтернету, ключ — хеш PIN

  const getJ = k=>{ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } };
  const setJ = (k, v)=>{ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); }catch(e){} };
  const esc = s=>String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const onReady = fn=>document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn();
  const shuffle = a=>{ a = a.slice(); for(let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  /* ---------- Сервер ---------- */
  async function call(req, timeout = 20000){
    const ctl = new AbortController();
    const t = setTimeout(()=>ctl.abort(), timeout);
    try{
      const r = await fetch(API, { method:'POST', body:JSON.stringify(req), headers:{ 'Content-Type':'text/plain;charset=utf-8' }, signal:ctl.signal });
      return await r.json();   // Google, перевантажений запитами, віддає сторінку замість JSON — це теж «немає зв'язку»
    }finally{ clearTimeout(t); }
  }

  /* ---------- Хеші (для входу без інтернету) ---------- */
  const subtle = window.crypto && crypto.subtle;
  const hex = buf=>Array.from(new Uint8Array(buf), b=>b.toString(16).padStart(2, '0')).join('');
  const sha = async s=>subtle ? hex(await subtle.digest('SHA-256', new TextEncoder().encode(s))) : null;
  async function slowHash(text, salt){
    const key = await subtle.importKey('raw', new TextEncoder().encode(text), 'PBKDF2', false, ['deriveBits']);
    return hex(await subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt:new TextEncoder().encode(salt), iterations:200000 }, key, 256));
  }
  async function saveVerifier(uid, pics){
    if(!subtle) return;
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    setJ(VERIFY(uid), { salt, hash:await slowHash(`${uid}:${pics}`, salt) });
  }
  // Перевірка картинок за копією на пристрої: { ok } або { left } — скільки спроб лишилось, або { none } — копії немає.
  // Після LOCAL_TRIES помилок копія стирається, і далі вхід лише через сервер (там свій лічильник помилок)
  async function checkVerifier(uid, pics){
    const v = getJ(VERIFY(uid));
    if(!v || !subtle) return { none:true };
    if(await slowHash(`${uid}:${pics}`, v.salt) === v.hash){
      if(v.fails){ v.fails = 0; setJ(VERIFY(uid), v); }
      return { ok:true };
    }
    v.fails = (v.fails || 0) + 1;
    setJ(VERIFY(uid), v.fails >= LOCAL_TRIES ? null : v);
    return { left:LOCAL_TRIES - v.fails };
  }

  /* ---------- Зведення даних з двох пристроїв ---------- */
  // Числа — більше (нейрончики, заїзди, рекорди лише ростуть), об'єкти — обидва набори ключів (наліпки, медалі),
  // масиви чисел однакової довжини — більше в кожній позиції, решта — з цього пристрою (налаштування, обране).
  // Скинутий прогрес позначено resetAt: з двох версій з різним resetAt береться новіша ціла, інакше старі рекорди повернулися б
  const isObj = x=>x && typeof x === 'object' && !Array.isArray(x);
  function merge(a, b){
    if(a === undefined || a === null) return b;
    if(b === undefined || b === null) return a;
    if(typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
    if(isObj(a) && isObj(b)){
      const ra = a.resetAt || 0, rb = b.resetAt || 0;
      if(ra !== rb) return ra > rb ? a : b;
      const out = {};
      new Set([...Object.keys(a), ...Object.keys(b)]).forEach(k=>out[k] = merge(a[k], b[k]));
      return out;
    }
    if(Array.isArray(a) && Array.isArray(b)){
      if(a.length === b.length && a.every(x=>typeof x === 'number') && b.every(x=>typeof x === 'number')) return a.map((x, i)=>Math.max(x, b[i]));
      return a.length >= b.length ? a : b;
    }
    return a;
  }

  /* ---------- Стан на пристрої ---------- */
  let session = getJ(SESSION);
  let rec = session && getJ(DATA(session.uid));
  if(session && !rec) session = null;
  const listeners = { update:[] };
  const emit = (ev, ...args)=>listeners[ev].forEach(fn=>{ try{ fn(...args); }catch(e){ console.error(e); } });
  const store = ()=>{ if(session) setJ(DATA(session.uid), rec); };
  // Каталог і кілька ігор можуть бути відкриті водночас: перед кожною зміною перечитуємо запис з localStorage
  const fresh = ()=>{ if(session) rec = getJ(DATA(session.uid)) || rec; return rec; };
  let lastTouch = 0;
  const touch = ()=>{ if(session && Date.now() - lastTouch > 60e3){ lastTouch = Date.now(); session.last = lastTouch; setJ(SESSION, session); } };

  function start(uid, r){
    session = { uid, last:Date.now() };
    rec = r;
    setJ(SESSION, session);
    store();
  }

  /* ---------- Синхронізація ---------- */
  let syncing = false, retry = 5000, timer = null, failedSince = 0;
  const dirtyRecs = ()=>{
    const out = [];
    try{
      for(let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if(!k.startsWith('acc-data:') || k === DATA('guest')) continue;
        const r = getJ(k);
        if(r && r.token && Object.values(r.docs || {}).some(d=>d.dirty)) out.push(k);
      }
    }catch(e){}
    return out;
  };
  function schedule(ms){ clearTimeout(timer); timer = setTimeout(syncAll, ms); }

  // Відправляє зміни всіх учнів цього пристрою (і тих, хто вже вийшов: класний комп'ютер без інтернету)
  async function syncAll(){
    if(syncing) return;
    syncing = true;
    let ok = true;
    try{
      const keys = new Set(dirtyRecs());
      if(session && !session.guest) keys.add(DATA(session.uid));
      for(const k of keys) ok = await syncOne(k) && ok;
    }finally{ syncing = false; }
    if(ok){ retry = 5000; failedSince = 0; }
    else { failedSince ||= Date.now(); retry = Math.min(retry * 2, 120000); }
    badge();
    if(!ok || dirtyRecs().length) schedule(ok ? 1000 : retry * (0.75 + Math.random() / 2));
  }
  async function syncOne(k){
    const isMine = ()=>session && !session.guest && k === DATA(session.uid);
    const r = getJ(k);
    if(!r || !r.token) return true;
    const put = {}, sent = {}, have = {};
    Object.entries(r.docs).forEach(([key, d])=>{ have[key] = d.v || 0; if(d.dirty){ put[key] = { v:d.v || 0, data:d.data }; sent[key] = d.rev; } });
    let res;
    try{ res = await call({ a:'sync', token:r.token, put, have }); }catch(e){ return false; }
    // Поки чекали відповідь, гра могла зберегти новіше — беремо свіжий запис
    const cur = getJ(k);
    if(!cur) return true;
    if(res.error === 'token'){   // вчитель скинув картинки — цей вхід більше не діє; дані лишаються й підуть після нового входу
      cur.token = null;
      setJ(k, cur);
      if(isMine()){ rec = cur; setJ(SESSION, null); }   // наступного разу — знову вхід
      return true;
    }
    if(!res.ok) return false;
    const changed = [];
    Object.entries(res.saved || {}).forEach(([key, v])=>{ const d = cur.docs[key]; if(d){ d.v = v; if(d.rev === sent[key]) d.dirty = false; } });
    Object.entries(res.conflicts || {}).forEach(([key, srv])=>{
      const d = cur.docs[key];
      cur.docs[key] = { v:srv.v, data:merge(d && d.data, srv.data), dirty:true, rev:((d && d.rev) || 0) + 1 };
      changed.push(key);
    });
    Object.entries(res.fresh || {}).forEach(([key, srv])=>{
      const d = cur.docs[key];
      if(d && d.dirty) return;
      cur.docs[key] = { v:srv.v, data:srv.data, dirty:false, rev:(d && d.rev) || 0 };
      changed.push(key);
    });
    (res.tooBig || []).forEach(key=>console.warn('account: too big to sync', key));
    if(res.cls && cur.user) cur.user.cls = res.cls;   // ключ класу для дуелей — і тим, хто увійшов до їх появи
    setJ(k, cur);
    if(isMine()){ rec = cur; changed.forEach(key=>emit('update', key, copy(cur.docs[key].data))); }
    return !Object.keys(res.conflicts || {}).length || await syncOne(k);
  }
  window.addEventListener('online', ()=>schedule(500));
  // Сторінку закривають: відправити незбережене без очікування відповіді (версію дізнаємося при наступній синхронізації)
  window.addEventListener('pagehide', ()=>{
    if(!session || session.guest || !rec || !rec.token || !navigator.sendBeacon) return;
    const put = {};
    Object.entries(rec.docs).forEach(([key, d])=>{ if(d.dirty) put[key] = { v:d.v || 0, data:d.data }; });
    if(Object.keys(put).length) navigator.sendBeacon(API, new Blob([JSON.stringify({ a:'sync', token:rec.token, put })], { type:'text/plain' }));
  });

  /* ---------- Значок «не збережено» ---------- */
  let badgeEl = null;
  function badge(){
    const show = failedSince && Date.now() - failedSince > 60e3 && dirtyRecs().length;
    if(!show){ if(badgeEl) badgeEl.hidden = true; return; }
    if(!badgeEl){
      badgeEl = document.createElement('div');
      badgeEl.className = 'acc-badge';
      badgeEl.title = 'Немає зв\'язку з сервером. Прогрес збережено на цьому пристрої й буде відправлено, щойно з\'явиться інтернет.';
      badgeEl.textContent = '☁ не збережено на сервері';
      document.body.appendChild(badgeEl);
    }
    badgeEl.hidden = false;
  }

  /* ---------- API для ігор ---------- */
  let readyFns = [];
  const userOf = ()=>session && rec ? Object.assign({ guest:!!session.guest }, rec.user) : null;
  const copy = x=>x == null ? null : JSON.parse(JSON.stringify(x));
  const Account = {
    get user(){ return userOf(); },
    ready(fn){
      if(session && !needConfirm()){ touch(); fn(); return; }
      readyFns.push(fn);
      onReady(()=>openLogin(session ? 'confirm' : 'pin'));
    },
    get(key){ fresh(); const d = rec && rec.docs[key]; return d ? copy(d.data) : null; },
    save(key, data){
      if(!fresh()) return;
      const d = rec.docs[key] ||= { v:0 };
      const resetAt = isObj(d.data) && d.data.resetAt;   // гра про позначку скидання не знає — зберігаємо її самі
      d.data = copy(data);
      if(resetAt && isObj(d.data) && !d.data.resetAt) d.data.resetAt = resetAt;
      d.dirty = true;
      d.rev = (d.rev || 0) + 1;
      store();
      touch();
      if(!session.guest) schedule(3000);
    },
    shared(name){ return copy((Account.get('shared') || {})[name]) || {}; },
    setShared(name, value){
      if(!fresh()) return;
      const all = Account.get('shared') || {};
      all[name] = value;
      Account.save('shared', all);
    },
    on(ev, fn){ (listeners[ev] ||= []).push(fn); },
    // Сторінка вчителя: ключ класу за PIN (той самий список класу, що й при вході учня). { cls } або { error }
    async classKey(pin){
      let r;
      try{ r = await call({ a:'classList', pin:String(pin).replace(/\D/g, '') }); }catch(e){ return { error:'net' }; }
      if(!r.ok) return { error:r.error || 'server' };
      const cls = r.students.find(s=>s.cls)?.cls;
      return cls ? { cls, count:r.students.length } : { error:'empty' };
    },
    logout(){
      setJ(SESSION, null);
      location.reload();
    },
    confirmReset(key, data){
      if(!session || session.guest) return Promise.resolve(true);
      if(!fresh() || !rec.token || box) return Promise.resolve(false);
      return new Promise(done=>{
        resetReq = { key, data:Object.assign(copy(data), { resetAt:Date.now() }), done };
        mode = 'reset'; who = { id:session.uid, pics:true }; picks = [];
        openLogin('animal');
      });
    },
  };
  window.Account = Account;
  // Інша вкладка могла оновити час останньої дії — беремо пізніший
  const needConfirm = ()=>{
    if(!session || session.guest) return false;
    const s = getJ(SESSION);
    if(s && s.uid === session.uid) session.last = Math.max(session.last || 0, s.last || 0);
    return Date.now() - (session.last || 0) > IDLE_CONFIRM;
  };
  // Гру лишили відкритою: після паузи перша ж дія (і таймер — щоб новий учень одразу побачив питання) відкриває «Це ти?».
  // Якщо в іншій вкладці вийшли чи увійшов інший учень, ця сторінка перезавантажується, щоб не писати прогрес не тому
  const ACTIVITY = ['keydown', 'pointerdown', 'touchstart', 'wheel'];
  function watchIdle(e){
    if(!session || box) return;
    const s = getJ(SESSION);
    if(!s || s.uid !== session.uid){ if(e) e.stopImmediatePropagation(), e.preventDefault(); location.reload(); return; }
    if(needConfirm()){
      if(e) e.stopImmediatePropagation(), e.preventDefault();
      onReady(()=>openLogin('confirm'));
      return;
    }
    if(e) touch();
  }
  ACTIVITY.forEach(t=>window.addEventListener(t, watchIdle, { capture:true, passive:false }));
  setInterval(()=>watchIdle(null), 30e3);

  if(session && !session.guest) schedule(1500);
  else if(dirtyRecs().length) schedule(1500);

  /* ---------- «Мої ігри»: у які ігри сайту учень уже грав, і наліпки за їх кількість ---------- */
  // Гра кличе Account.played() після кожного завершеного раунду (рахується перший), а Account.showGames() — після
  // кліку на аватар у профілі. Позначки — у спільних даних акаунта (shared.played), тож ідуть за учнем на інші пристрої
  const GAMES = [['typing-race-kids', '🚗', 'Клавіатурні перегони'], ['balloon-race-kids', '🎈', 'Повітряні перегони'], ['water-race-kids', '🚣', 'Перегони на воді'],
    ['keyboard-residents-kids', '⌨️', 'Мешканці клавіатури'], ['mouse-race-kids', '🐭', 'Мишачі перегони'], ['double-click-kids', '👆', 'Двічі клац!'],
    ['word-bricks-kids', '🧱', 'Цеглинки слів'], ['hot-keys', '🤖', 'Гарячі клавіші']];
  const GAME_STICKERS = [[2, '🌱', 'Дві гри'], [4, '🌿', 'Чотири гри'], [6, '🌳', 'Шість ігор'], [GAMES.length, '🏆', 'Усі ігри']];
  const playedCount = played=>GAMES.filter(([id])=>played[id]).length;
  Account.games = GAMES;                // для огляду класу (/teacher/class/): [id, значок, назва]
  Account.api = req=>call(req);         // огляд класу питає сервер сам: { a:'teacherClasses' | 'teacherOverview', tpin, … }
  Account.played = (game = location.pathname.split('/')[1])=>{
    if(!session) return;
    const played = Account.shared('played');
    if(played[game]) return;
    const before = GAME_STICKERS.filter(([n])=>playedCount(played) >= n).length;
    played[game] = Math.floor(Date.now() / 86400000);
    Account.setShared('played', played);
    const now = GAME_STICKERS.filter(([n])=>playedCount(played) >= n);
    if(now.length > before){ const [, ico, name] = now[now.length - 1]; toast(`${ico} Нова наліпка «${name}» — у «Моїх іграх»`); }
  };
  let toastEl = null, toastTimer = 0;
  function toast(text){
    ensureCss();
    if(!toastEl){ toastEl = document.createElement('div'); toastEl.className = 'acc-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>toastEl.hidden = true, 4500);
  }
  Account.showGames = ()=>{
    if(!session) return;
    ensureCss();
    const played = Account.shared('played'), n = playedCount(played), here = location.pathname.split('/')[1];
    const box = document.createElement('div');
    box.id = 'accGames';
    box.className = 'acc';
    box.innerHTML = `<div class="acc-card acc-games"><button class="ghost acc-x" type="button" aria-label="Закрити">✕</button>
      <h2>Мої ігри</h2><p>Зіграно ${n} з ${GAMES.length}</p>
      <div class="acc-glist">${GAMES.map(([id, ico, name])=>`<a class="acc-g${played[id] ? '' : ' no'}${id === here ? ' here' : ''}" href="/${id}/">
        <span class="acc-gi">${ico}</span><span>${esc(name)}</span><small>${played[id] ? '✓ зіграно' : 'ще ні'}</small></a>`).join('')}</div>
      <h3>Наліпки</h3>
      <div class="acc-slist">${GAME_STICKERS.map(([k, ico, name])=>`<span class="acc-s${n >= k ? '' : ' no'}"><span class="acc-gi">${ico}</span>${esc(name)}<small>${n >= k ? 'є!' : `ще ${k - n}`}</small></span>`).join('')}</div></div>`;
    const close = ()=>{ box.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e=>{ e.stopPropagation(); if(e.key === 'Escape') close(); };   // клавіші — не грі під вікном
    box.addEventListener('click', e=>{ if(e.target === box || e.target.closest('.acc-x')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(box);
  };

  /* ---------- Вікно входу ---------- */
  const ensureCss = ()=>{ if(document.getElementById('accCss')) return; const st = document.createElement('style'); st.id = 'accCss'; st.textContent = css; document.head.appendChild(st); };
  const css = `
    .acc{--ink:#1B1B3A; --soft:#514F72; --teal:#16A3A0; --teal-d:#0E7C7A; --line:#E4E1F5; --coral:#C2410C;
      font-family:'Nunito Sans',system-ui,sans-serif; color:var(--ink); line-height:1.45; box-sizing:border-box;}
    .acc *{box-sizing:border-box;}
    #accLogin{position:fixed; inset:0; z-index:2147483646; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(27,27,58,.55); overflow:auto;}
    .acc-card{background:#fff; border-radius:26px; padding:24px 22px 18px; max-width:460px; width:100%; text-align:center; box-shadow:0 20px 50px rgba(27,27,58,.25);}
    .acc-big{font-size:46px; line-height:1;}
    .acc h2{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:25px; line-height:1.2; margin:8px 0 4px;}
    .acc p{margin:0; color:var(--soft); font-size:15.5px;}
    .acc form{display:flex; gap:8px; margin:16px 0 4px;}
    .acc input{flex:1; min-width:0; font:inherit; font-size:20px; font-weight:700; text-align:center; padding:8px 10px;
      border:2px solid var(--line); border-radius:14px; outline:none; color:var(--ink);}
    .acc input.pin{font-size:26px; letter-spacing:.25em;}
    .acc input:focus{border-color:var(--teal);}
    .acc button{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:17px; border:none; border-radius:999px; padding:8px 20px; cursor:pointer; background:var(--teal); color:#fff;}
    .acc button:hover{background:var(--teal-d);}
    .acc button.ghost{background:none; color:var(--soft); font-size:14.5px; font-weight:600; padding:4px 10px; text-decoration:underline;}
    .acc button.light{background:#E3F7F6; color:var(--teal-d);}
    .acc .err{min-height:1.5em; margin-top:6px; color:var(--coral); font-size:14.5px; font-weight:700;}
    .acc .row{display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:8px;}
    .acc-list{display:flex; flex-direction:column; gap:6px; margin:14px 0 4px; max-height:52vh; overflow:auto; text-align:left;}
    .acc-list button{background:#F6F5FB; color:var(--ink); border-radius:14px; text-align:left; font-size:18px; padding:9px 14px;}
    .acc-list button:hover{background:#E3F7F6;}
    .acc-list button small{color:var(--soft); font-family:'Nunito Sans',system-ui,sans-serif; font-weight:600; font-size:14px;}
    .acc-grid{display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin:14px auto 4px; max-width:340px;}
    .acc-grid button{background:#F6F5FB; color:var(--ink); border-radius:18px; padding:8px 4px 6px; display:flex; flex-direction:column; align-items:center; gap:2px;}
    .acc-grid button:hover{background:#E3F7F6;}
    .acc-grid .e{font-size:46px; line-height:1.1; font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;}
    .acc-grid .w{font-family:'Nunito Sans',system-ui,sans-serif; font-weight:700; font-size:14px; color:var(--soft);}
    .acc-steps{display:flex; gap:6px; justify-content:center; margin-top:8px;}
    .acc-steps i{width:9px; height:9px; border-radius:50%; background:var(--line);}
    .acc-steps i.on{background:var(--teal);}
    .acc-wait{margin:18px 0 6px; font-weight:700; color:var(--soft);}
    #accGames{position:fixed; inset:0; z-index:2147483644; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(27,27,58,.55); overflow:auto;}
    .acc-games{position:relative; max-width:560px;}
    .acc-games h3{font-family:'Baloo 2',system-ui,sans-serif; font-size:19px; margin:16px 0 6px;}
    .acc-x{position:absolute; top:10px; right:12px; text-decoration:none !important; font-size:18px !important;}
    .acc-glist{display:grid; grid-template-columns:repeat(auto-fill, minmax(118px, 1fr)); gap:8px; margin-top:14px;}
    .acc-g, .acc-s{display:flex; flex-direction:column; align-items:center; gap:2px; padding:10px 6px 8px; border-radius:16px; background:#E3F7F6;
      color:var(--ink); text-decoration:none; font-weight:700; font-size:14px; line-height:1.25;}
    .acc-g.here{outline:2px solid var(--teal);}
    .acc-g:hover{background:#CDEFEE;}
    .acc-g.no, .acc-s.no{background:#F6F5FB; color:var(--soft);}
    .acc-g.no .acc-gi, .acc-s.no .acc-gi{filter:grayscale(1); opacity:.45;}
    .acc-g small, .acc-s small{font-weight:600; font-size:12px; color:var(--soft);}
    .acc-gi{font-size:32px; line-height:1.1; font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;}
    .acc-slist{display:grid; grid-template-columns:repeat(4, 1fr); gap:8px;}
    .acc-toast{position:fixed; left:50%; bottom:22px; transform:translateX(-50%); z-index:2147483645; background:#1B1B3A; color:#fff; border-radius:999px;
      padding:9px 18px; font:700 15px 'Nunito Sans',system-ui,sans-serif; box-shadow:0 8px 24px rgba(27,27,58,.3); max-width:calc(100% - 24px); text-align:center;}
    .acc-badge{position:fixed; left:10px; bottom:10px; z-index:2147483645; background:#FFF4E5; color:#9A3412; border:1.5px solid #FDBA74;
      border-radius:999px; padding:4px 12px; font:700 13px 'Nunito Sans',system-ui,sans-serif; cursor:help;}`;

  let box = null, offline = false, roster = null, pin = '', who = null, picks = [], firstPicks = null, nick = '';
  // mode: 'login' — звичайний вхід, 'again' — «Це ти?» після паузи, 'reset' — підтвердження скидання прогресу (resetReq)
  let mode = 'login', resetReq = null;
  const EVENTS = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'touchstart'];
  const block = e=>{ if(box && !box.contains(e.target)) e.stopImmediatePropagation(); };

  function openLogin(step){
    if(!box){
      ensureCss();
      box = document.createElement('div');
      box.id = 'accLogin';
      box.className = 'acc';
      document.body.appendChild(box);
      EVENTS.forEach(t=>window.addEventListener(t, block, { capture:true, passive:false }));
      EVENTS.forEach(t=>box.addEventListener(t, e=>e.stopPropagation()));
    }
    show(step);
  }
  function closeLogin(){
    EVENTS.forEach(t=>window.removeEventListener(t, block, { capture:true }));
    box.remove();
    box = null;
    mode = 'login';
    lastTouch = 0;   // щойно підтвердив — відлік паузи з цієї миті
    touch();
    const fns = readyFns;
    readyFns = [];
    fns.forEach(fn=>fn());
  }
  const card = html=>{ box.innerHTML = `<div class="acc-card">${html}</div>`; };
  const $ = s=>box.querySelector(s);
  const on = (sel, fn)=>box.querySelectorAll(sel).forEach(b=>b.addEventListener('click', fn));
  const wait = text=>card(`<div class="acc-big">⏳</div><div class="acc-wait">${text}</div>`);

  function show(step, err = ''){
    if(step === 'confirm'){   // після паузи: картинки, а не кнопка «Так», — інакше «так» натисне будь-хто
      mode = 'again'; who = { id:session.uid, pics:true }; picks = [];
      show('animal', err);
      return;
    }
    if(step === 'note'){   // повідомлення з однією кнопкою; err — текст, then — що далі
      card(`<div class="acc-big">${err.ico}</div><h2>${esc(err.title)}</h2><p>${esc(err.text)}</p>
        <div class="row" style="margin-top:16px"><button data-a="ok">Добре</button></div>`);
      on('[data-a="ok"]', err.then);
      return;
    }
    if(step === 'pin'){
      card(`<div class="acc-big">🔑</div><h2>Вхід у гру</h2><p>Введи PIN свого класу. Його знає вчитель.</p>
        <form><input class="pin" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="······" aria-label="PIN класу"><button>Далі</button></form>
        <div class="err">${esc(err)}</div>
        <div class="row"><button class="ghost" type="button" data-a="guest">Грати без входу</button></div>`);
      const inp = $('input');
      $('form').addEventListener('submit', e=>{ e.preventDefault(); askClass(inp.value.replace(/\D/g, '')); });
      on('[data-a="guest"]', ()=>{
        start('guest', getJ(DATA('guest')) || { user:{ id:'guest', label:'Гість', full:'Гість' }, docs:{} });
        session.guest = true;
        setJ(SESSION, session);
        closeLogin();
      });
      setTimeout(()=>inp.focus(), 50);
      return;
    }
    if(step === 'list'){
      card(`<h2>Хто ти?</h2><p>Знайди себе у списку.${offline ? ' Зараз немає інтернету.' : ''}</p>
        <div class="acc-list">${roster.map((s, i)=>`<button type="button" data-i="${i}">${s.locked ? '🔒 ' : ''}${esc(s.nick || s.name)}${s.nick ? ` <small>(${esc(s.name)})</small>` : ''}</button>`).join('')}</div>
        <div class="err">${esc(err)}</div>
        <div class="row"><button class="ghost" type="button" data-a="back">← Інший PIN</button></div>`);
      on('[data-i]', e=>{
        who = roster[+e.currentTarget.dataset.i];
        if(who.locked){ show('list', 'Вхід закрито після кількох помилок. Попроси вчителя відкрити.'); return; }
        picks = [];
        if(!who.pics){
          if(offline){ show('list', 'Перший вхід — лише з інтернетом.'); return; }
          firstPicks = null; nick = ''; show('nick'); return;
        }
        show('animal');
      });
      on('[data-a="back"]', ()=>show('pin'));
      return;
    }
    if(step === 'nick'){
      card(`<div class="acc-big">✏️</div><h2>Привіт, ${esc(who.name.split(' ')[0])}!</h2>
        <p>Можеш придумати собі нік. Його бачитимуть інші гравці. Не пиши в ньому прізвище.</p>
        <form><input maxlength="16" autocomplete="off" placeholder="Нік" aria-label="Нік" value="${esc(nick)}"><button>Далі</button></form>
        <div class="err">${esc(err)}</div>
        <div class="row"><button class="ghost" type="button" data-a="skip">Без ніка</button><button class="ghost" type="button" data-a="back">← Назад</button></div>`);
      const inp = $('input');
      $('form').addEventListener('submit', e=>{
        e.preventDefault();
        nick = inp.value.replace(/\s+/g, ' ').trim();
        if(nick && nick.length < 2){ show('nick', 'Нік — хоча б 2 літери.'); return; }
        show('animal');
      });
      on('[data-a="skip"]', ()=>{ nick = ''; show('animal'); });
      on('[data-a="back"]', ()=>show('list'));
      setTimeout(()=>inp.focus(), 50);
      return;
    }
    if(step === 'animal' || step === 'food'){
      const animal = step === 'animal', set = animal ? ANIMALS : FOODS;
      const setupMode = !who.pics, again = setupMode && firstPicks;
      const pick = animal ? 'Обери свою тварину.' : 'Обери свою їжу.';
      const title = mode === 'again' ? `Це ти, ${esc(userOf().label)}?` : mode === 'reset' ? 'Скинути прогрес?'
        : again ? (animal ? 'Ще раз: твоя тварина' : 'Ще раз: твоя їжа')
        : setupMode ? (animal ? 'Обери свою тварину' : 'Обери свою їжу')
        : (animal ? 'Твоя тварина' : 'Твоя їжа');
      const sub = mode === 'again' ? pick : mode === 'reset' ? 'Щоб підтвердити, що це твій прогрес. ' + pick
        : setupMode && !again ? 'Запам\'ятай її: так ти входитимеш у гру. Нікому не кажи.' : again ? 'Щоб перевірити, що ти запам\'ятав.' : '';
      const total = setupMode ? 4 : 2, at = (again ? 2 : 0) + (animal ? 0 : 1);
      const back = mode === 'again' ? '<button class="ghost" type="button" data-a="other">Ні, я інший учень</button>'
        : mode === 'reset' ? '<button class="ghost" type="button" data-a="cancel">Скасувати</button>'
        : '<button class="ghost" type="button" data-a="back">← Назад</button>';
      card(`<h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}
        <div class="acc-grid">${shuffle(set.map((x, i)=>[i, ...x])).map(([i, e, w])=>`<button type="button" data-p="${i}" aria-label="${w}"><span class="e">${e}</span><span class="w">${w}</span></button>`).join('')}</div>
        <div class="acc-steps">${Array.from({ length:total }, (_, i)=>`<i class="${i <= at ? 'on' : ''}"></i>`).join('')}</div>
        <div class="err">${esc(err)}</div>
        <div class="row">${back}</div>`);
      on('[data-a="other"]', ()=>Account.logout());
      on('[data-a="cancel"]', ()=>endReset(false));
      on('[data-p]', e=>{
        picks.push(+e.currentTarget.dataset.p);
        if(animal){ show('food'); return; }
        if(mode === 'again'){ doAgain(); return; }
        if(mode === 'reset'){ doReset(); return; }
        if(!setupMode){ doLogin(); return; }
        if(!firstPicks){ firstPicks = picks; picks = []; show('animal'); return; }
        if(firstPicks[0] !== picks[0] || firstPicks[1] !== picks[1]){ firstPicks = null; picks = []; show('animal', 'Картинки не збіглися. Обери ще раз.'); return; }
        doSetup();
      });
      on('[data-a="back"]', ()=>{ picks = []; firstPicks = null; show(who.pics ? 'list' : 'nick'); });
      return;
    }
    if(step === 'guestMerge'){
      card(`<div class="acc-big">🎁</div><h2>Тут хтось грав без входу</h2><p>Це був ти? Тоді додамо той прогрес тобі.</p>
        <div class="row" style="margin-top:16px"><button data-a="yes">Так, це я</button><button class="light" data-a="no">Ні, не я</button></div>`);
      on('[data-a="yes"]', ()=>{
        const g = getJ(DATA('guest'));
        Object.entries(g.docs).forEach(([key, d])=>{
          const mine = rec.docs[key];
          // Гра гостя — пізніша за скидання (якщо воно було), тож додається до скинутого, а не відкидається
          const gd = mine && isObj(mine.data) && mine.data.resetAt && isObj(d.data) ? { ...d.data, resetAt:mine.data.resetAt } : d.data;
          rec.docs[key] = { v:mine ? mine.v : 0, data:merge(mine && mine.data, gd), dirty:true, rev:((mine && mine.rev) || 0) + 1 };
        });
        setJ(DATA('guest'), null);
        store();
        schedule(500);
        closeLogin();
      });
      on('[data-a="no"]', closeLogin);
    }
  }

  async function askClass(p){
    if(p.length < 4){ show('pin', 'PIN — це цифри від вчителя.'); return; }
    pin = p;
    wait('Шукаю твій клас…');
    let res = null;
    try{ res = await call({ a:'classList', pin }); }catch(e){}
    const h = await sha('acc-class:' + pin);
    if(res && res.ok){
      offline = false;
      roster = res.students;
      if(h) setJ(ROSTER(h), roster);
      show('list');
      return;
    }
    if(res && res.error === 'pin'){ show('pin', 'Такого PIN немає. Перевір цифри.'); return; }
    if(res && res.error === 'busy'){ show('pin', 'Забагато спроб. Зачекай кілька хвилин.'); return; }
    const cached = h && getJ(ROSTER(h));
    if(cached){ offline = true; roster = cached; show('list'); return; }
    show('pin', 'Немає зв\'язку з сервером. Спробуй ще раз або грай без входу.');
  }

  async function doLogin(){
    const pics = picks.slice();
    picks = [];
    wait('Перевіряю…');
    let res = null;
    if(!offline){ try{ res = await call({ a:'login', pin, id:who.id, pics }); }catch(e){} }
    if(res && res.ok){ await finish(res, pics); return; }
    if(res && res.error === 'pics'){ show('animal', `Не ті картинки. Залишилось спроб: ${res.left}.`); return; }
    if(res && res.error === 'locked'){ who.locked = true; show('list', 'Вхід закрито після кількох помилок. Попроси вчителя відкрити.'); return; }
    if(res && res.error === 'no-pics'){ who.pics = false; firstPicks = null; nick = ''; show('nick'); return; }
    if(res && res.error){ show('pin', 'Щось пішло не так. Введи PIN ще раз.'); return; }
    // Немає зв'язку: впускаємо, якщо цей учень уже входив на цьому пристрої
    const r = getJ(DATA(who.id));
    const c = r ? await checkVerifier(who.id, pics) : { none:true };
    if(c.ok){ start(who.id, r); afterLogin(); return; }
    if(c.left) show('animal', `Не ті картинки. Залишилось спроб: ${c.left}.`);
    else if(!c.none) show('list', 'Забагато помилок. Тепер увійти можна лише з інтернетом.');
    else show('list', r ? 'Немає інтернету. Зараз увійти можна лише з інтернетом.' : 'Немає інтернету. Без нього можна увійти лише там, де ти вже входив.');
  }

  // «Це ти?» після паузи: картинки перевіряються на пристрої, тож і без інтернету. Немає копії — звичайний вхід
  async function doAgain(){
    const pics = picks.slice();
    picks = [];
    wait('Перевіряю…');
    const c = await checkVerifier(session.uid, pics);
    if(c.ok){ closeLogin(); return; }
    if(c.left){ show('animal', `Не ті картинки. Залишилось спроб: ${c.left}.`); return; }
    Account.logout();
  }

  // Скидання прогресу: лише через сервер — він перевіряє картинки й записує порожній прогрес
  async function doReset(){
    const pics = picks.slice(), { key, data } = resetReq;
    picks = [];
    wait('Перевіряю…');
    let res = null;
    try{ res = await call({ a:'reset', token:rec.token, game:key, data, pics }); }catch(e){}
    if(res && res.ok){
      fresh();
      const d = rec.docs[key];
      rec.docs[key] = { v:res.v, data, dirty:false, rev:((d && d.rev) || 0) + 1 };
      store();
      endReset(true);
      return;
    }
    if(res && res.error === 'pics'){ show('animal', `Не ті картинки. Залишилось спроб: ${res.left}.`); return; }
    if(res && (res.error === 'locked' || res.error === 'token')){
      if(res.error === 'locked') setJ(VERIFY(session.uid), null);
      show('note', { ico:'🔒', title:res.error === 'locked' ? 'Вхід закрито' : 'Треба увійти ще раз',
        text:res.error === 'locked' ? 'Забагато помилок з картинками. Попроси вчителя відкрити вхід.' : 'Цей вхід більше не діє.', then:()=>Account.logout() });
      return;
    }
    show('note', { ico:'📡', title:'Потрібен інтернет', text:res ? 'Щось пішло не так. Спробуй пізніше.' : 'Скинути прогрес можна лише з інтернетом. Спробуй, коли він з\'явиться.', then:()=>endReset(false) });
  }
  function endReset(ok){
    const done = resetReq && resetReq.done;
    resetReq = null;
    closeLogin();
    if(done) done(ok);
  }

  async function doSetup(){
    const pics = picks.slice();
    picks = []; firstPicks = null;
    wait('Запам\'ятовую…');
    let res = null;
    try{ res = await call({ a:'setup', pin, id:who.id, nick, pics }); }catch(e){}
    if(res && res.ok){ await finish(res, pics); return; }
    if(res && res.error === 'nick-taken'){ show('nick', 'Такий нік у класі вже є. Придумай інший.'); return; }
    if(res && res.error === 'nick-short'){ show('nick', 'Нік — хоча б 2 літери.'); return; }
    if(res && res.error === 'has-pics'){ who.pics = true; show('animal', 'Ти вже обирав картинки. Обери свої.'); return; }
    show('nick', res ? 'Щось пішло не так. Спробуй ще раз.' : 'Немає зв\'язку з сервером. Спробуй ще раз.');
  }

  // Успішний вхід через сервер: дані з сервера зводимо з тим, що лишилося на пристрої невідправленим
  async function finish(res, pics){
    const old = getJ(DATA(res.user.id));
    const docs = {};
    Object.entries(res.docs || {}).forEach(([key, d])=>docs[key] = { v:d.v, data:d.data, dirty:false, rev:0 });
    if(old) Object.entries(old.docs || {}).forEach(([key, d])=>{
      if(!d.dirty) return;
      const srv = docs[key];
      docs[key] = { v:srv ? srv.v : 0, data:merge(d.data, srv && srv.data), dirty:true, rev:(d.rev || 0) + 1 };
    });
    start(res.user.id, { user:res.user, token:res.token, docs });
    wait('Готово!');
    await saveVerifier(res.user.id, pics);
    schedule(500);
    afterLogin();
  }
  function afterLogin(){
    const g = getJ(DATA('guest'));
    if(g && Object.keys(g.docs || {}).length){ show('guestMerge'); return; }
    closeLogin();
  }
})();
