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
(()=>{
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Адреса вебзастосунку Apps Script (Розгорнути → Керувати розгортаннями). Порожня — акаунта немає, ігри працюють по-старому
  const API = LOCAL ? 'http://localhost:8790/' : 'https://script.google.com/macros/s/AKfycbzntwAHNQg8lN-XZS6ZVeb6cgmUEsdviwB45gfOW8C9ww6X6rbocgquVLVGCLlNKhOv/exec';
  if(!API) return;

  const IDLE_CONFIRM = 30 * 60e3;   // після стількох хвилин без гри спитати «Це ти?» (класний комп'ютер, прийшов інший учень)
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
  async function checkVerifier(uid, pics){
    const v = getJ(VERIFY(uid));
    return !!(v && subtle && await slowHash(`${uid}:${pics}`, v.salt) === v.hash);
  }

  /* ---------- Зведення даних з двох пристроїв ---------- */
  // Числа — більше (нейрончики, заїзди, рекорди лише ростуть), об'єкти — обидва набори ключів (наліпки, медалі),
  // масиви чисел однакової довжини — більше в кожній позиції, решта — з цього пристрою (налаштування, обране)
  const isObj = x=>x && typeof x === 'object' && !Array.isArray(x);
  function merge(a, b){
    if(a === undefined || a === null) return b;
    if(b === undefined || b === null) return a;
    if(typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
    if(isObj(a) && isObj(b)){
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
      d.data = copy(data);
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
    logout(){
      setJ(SESSION, null);
      location.reload();
    },
  };
  window.Account = Account;
  const needConfirm = ()=>session && !session.guest && Date.now() - (session.last || 0) > IDLE_CONFIRM;

  if(session && !session.guest) schedule(1500);
  else if(dirtyRecs().length) schedule(1500);

  /* ---------- Вікно входу ---------- */
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
    .acc-badge{position:fixed; left:10px; bottom:10px; z-index:2147483645; background:#FFF4E5; color:#9A3412; border:1.5px solid #FDBA74;
      border-radius:999px; padding:4px 12px; font:700 13px 'Nunito Sans',system-ui,sans-serif; cursor:help;}`;

  let box = null, offline = false, roster = null, pin = '', who = null, picks = [], firstPicks = null, nick = '';
  const EVENTS = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'touchstart'];
  const block = e=>{ if(box && !box.contains(e.target)) e.stopImmediatePropagation(); };

  function openLogin(step){
    if(!box){
      const st = document.createElement('style');
      st.textContent = css;
      document.head.appendChild(st);
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
    if(step === 'confirm'){
      const u = userOf();
      card(`<div class="acc-big">👋</div><h2>Це ти, ${esc(u.label)}?</h2>
        <div class="row" style="margin-top:16px"><button data-a="yes">Так, це я</button><button class="light" data-a="no">Ні, інший учень</button></div>`);
      on('[data-a="yes"]', closeLogin);
      on('[data-a="no"]', ()=>{ session = null; rec = null; setJ(SESSION, null); show('pin'); });
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
      const title = again ? (animal ? 'Ще раз: твоя тварина' : 'Ще раз: твоя їжа')
        : setupMode ? (animal ? 'Обери свою тварину' : 'Обери свою їжу')
        : (animal ? 'Твоя тварина' : 'Твоя їжа');
      const sub = setupMode && !again ? 'Запам\'ятай її: так ти входитимеш у гру. Нікому не кажи.' : again ? 'Щоб перевірити, що ти запам\'ятав.' : '';
      const total = setupMode ? 4 : 2, at = (again ? 2 : 0) + (animal ? 0 : 1);
      card(`<h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}
        <div class="acc-grid">${shuffle(set.map((x, i)=>[i, ...x])).map(([i, e, w])=>`<button type="button" data-p="${i}" aria-label="${w}"><span class="e">${e}</span><span class="w">${w}</span></button>`).join('')}</div>
        <div class="acc-steps">${Array.from({ length:total }, (_, i)=>`<i class="${i <= at ? 'on' : ''}"></i>`).join('')}</div>
        <div class="err">${esc(err)}</div>
        <div class="row"><button class="ghost" type="button" data-a="back">← Назад</button></div>`);
      on('[data-p]', e=>{
        picks.push(+e.currentTarget.dataset.p);
        if(animal){ show('food'); return; }
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
          rec.docs[key] = { v:mine ? mine.v : 0, data:merge(mine && mine.data, d.data), dirty:true, rev:((mine && mine.rev) || 0) + 1 };
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
    if(r && await checkVerifier(who.id, pics)){ start(who.id, r); afterLogin(); return; }
    show('animal', r ? 'Не ті картинки.' : 'Немає інтернету. Без нього можна увійти лише там, де ти вже входив.');
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
