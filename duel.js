// Дуель з однокласником: двоє друкують той самий текст одночасно, кожен бачить на трасі машинку суперника.
// Підключається в <head> гри після /account.js: <script src="/duel.js">. Однокласників знаходимо за прихованим ключем
// класу з акаунта (Account.user.cls). Обмін — через Firebase Realtime Database (бібліотека вантажиться, лише коли
// учень відкриває дуель). Немає інтернету — гра пропонує їхати самому з роботом.
//
// Для гри:
//   Duel.available()       — чи можна дуелі (учень увійшов, і в акаунті є ключ класу)
//   Duel.open({ make, start, solo })
//     make()               — налаштування заїзду від того, хто запрошує:
//                            { text, lang, track, level, model, color, badge, desc } (desc — «🏙 Київ · 🇺🇦» для запрошення)
//     start(d)             — почати заїзд. d — те саме з make() від того, хто запрошував, плюс d.opp { label, model, color, badge }.
//                            Гру треба почати одразу: відлік 3-2-1 у грі триває 2,25 с, і Duel кличе start саме так,
//                            щоб «Руш!» в обох прозвучало разом. Під час заїзду Duel кличе d.onOpp({ pos, fin, left })
//     solo()               — немає зв'язку, учень обрав їхати з роботом
//   Duel.pos(n)            — скільки знаків уже надруковано (часто кликати можна: відправляється не частіше ніж раз на 0,2 с)
//   Duel.finish()          — учень доїхав
//   Duel.leave()           — вийти з дуелі (повернувся в гараж, закрив заїзд)
(()=>{
  const ACC = window.Account;
  if(!ACC) return;
  const CONFIG = {
    apiKey: 'AIzaSyBYwZr2yq0CVa6kcyuz5y30xj_fomJrP-4',
    authDomain: 'games131.firebaseapp.com',
    databaseURL: 'https://games131-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'games131',
    appId: '1:719513405865:web:cdfff8478ff69a09a15cb8',
  };
  const SDK = ['firebase-app-compat.js', 'firebase-database-compat.js'].map(f=>'https://www.gstatic.com/firebasejs/10.12.2/' + f);
  const GAME = location.pathname.split('/')[1] || 'game';   // дуель лише з тими, хто в тій самій грі
  const CONNECT_MS = 8000;      // стільки чекаємо на зв'язок, далі — «їхати з роботом»
  const COUNTDOWN_MS = 2250;    // від початку заїзду в грі до «Руш!»
  const LEAD_MS = 3500;         // від «Прийняти» до «Руш!»: щоб обидва встигли отримати час старту

  const esc = s=>String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const loadScript = src=>new Promise((ok, fail)=>{ const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });

  let db = null, offset = 0, me = null, base = null, opts = null;
  let lobbyRef = null, invRef = null, room = null, roomRef = null, box = null, lobby = {}, invites = {};
  let sendTimer = 0, lastSent = 0, pendingPos = 0;

  // Firebase: бібліотека, з'єднання, різниця годинника з сервером. Немає зв'язку за CONNECT_MS — false
  async function connect(){
    if(db){ db.goOnline(); return waitConnected(); }
    try{
      for(const src of SDK) await loadScript(src);
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(CONFIG);
      db = app.database();
      db.ref('.info/serverTimeOffset').on('value', s=>offset = s.val() || 0);
    }catch(e){ return false; }
    return waitConnected();
  }
  function waitConnected(){
    return new Promise(ok=>{
      const ref = db.ref('.info/connected');
      const t = setTimeout(()=>{ ref.off('value', h); ok(false); }, CONNECT_MS);
      const h = s=>{ if(s.val()){ clearTimeout(t); ref.off('value', h); ok(true); } };
      ref.on('value', h);
    });
  }
  const serverNow = ()=>Date.now() + offset;

  /* ---------- Лобі: хто з класу зараз чекає на дуель ---------- */
  function enterLobby(){
    const u = ACC.user;
    me = { id:u.id, label:u.label };
    base = db.ref('duel/' + u.cls);
    lobbyRef = base.child('lobby/' + me.id);
    lobbyRef.onDisconnect().remove();
    lobbyRef.set({ label:me.label, game:GAME, at:firebase.database.ServerValue.TIMESTAMP });
    base.child('lobby').on('value', s=>{ lobby = s.val() || {}; render(); });
    invRef = base.child('inv/' + me.id);
    invRef.onDisconnect().remove();
    invRef.on('value', s=>{ invites = s.val() || {}; render(); });
  }
  function leaveLobby(){
    if(!base) return;
    base.child('lobby').off();
    invRef?.off();
    lobbyRef?.remove(); invRef?.remove();
    lobbyRef = invRef = null;
  }

  /* ---------- Кімната дуелі ---------- */
  // Той, хто запрошує, створює кімнату з текстом і налаштуваннями; суперник відповідає «так» (acc) чи «ні» (no).
  // Після «так» той, хто запрошував, ставить час старту за годинником сервера — обидва починають у ту саму мить
  function invite(toId){
    const set = opts.make();
    const id = base.child('rooms').push().key;
    roomRef = base.child('rooms/' + id);
    room = { id, host:true, to:toId, toLabel:lobby[toId]?.label || '' };
    roomRef.onDisconnect().remove();
    roomRef.set({ meta:{ a:me.id, b:toId, la:me.label, lb:room.toLabel, game:GAME, ...set } });
    const inv = base.child(`inv/${toId}/${me.id}`);
    inv.onDisconnect().remove();
    inv.set({ room:id, label:me.label, desc:set.desc || '', at:firebase.database.ServerValue.TIMESTAMP });
    room.inv = inv;
    roomRef.on('value', s=>{
      const r = s.val();
      if(!room || room.id !== id) return;
      if(!r){ return; }
      if(r.no){ dropRoom(); render(`${room?.toLabel || 'Суперник'} зараз не може.`); return; }
      if(r.acc && !r.start) roomRef.child('start').set(serverNow() + LEAD_MS);
      if(r.start && !room.started) begin(r);
    });
    render();
  }
  function accept(fromId){
    const inv = invites[fromId];
    if(!inv) return;
    base.child(`inv/${me.id}/${fromId}`).remove();
    roomRef = base.child('rooms/' + inv.room);
    room = { id:inv.room, host:false, waiting:true, fromLabel:inv.label };
    const set = opts.make();
    roomRef.child('p/' + me.id).onDisconnect().update({ left:true });
    roomRef.child('acc').set({ model:set.model, color:set.color, badge:set.badge || '' });
    roomRef.on('value', s=>{
      const r = s.val();
      if(!room || room.id !== inv.room) return;
      if(!r){ if(!room.started){ dropRoom(); render(`${inv.label} скасував дуель.`); } else oppLeft(); return; }
      if(r.start && !room.started) begin(r);
    });
    render();
  }
  function decline(fromId){
    const inv = invites[fromId];
    base.child(`inv/${me.id}/${fromId}`).remove();
    if(inv) base.child(`rooms/${inv.room}/no`).set(true);
  }
  function dropRoom(){
    if(!room) return;
    roomRef?.off();
    room.inv?.remove();
    if(room.host) roomRef?.remove(); else roomRef?.child('p/' + me.id).update({ left:true });
    roomRef?.onDisconnect().cancel();
    room = null; roomRef = null;
  }

  // Старт: обидва знають текст, машинки й час. Ховаємо вікно й запускаємо гру так, щоб «Руш!» було в мить start
  function begin(r){
    room.started = true;
    room.inv?.remove();
    leaveLobby();
    const m = r.meta, host = room.host;
    const opp = host ? { id:m.b, label:m.lb, ...(r.acc || {}) } : { id:m.a, label:m.la, model:m.model, color:m.color, badge:m.badge };
    const d = { text:m.text, lang:m.lang, track:m.track, level:m.level, model:m.model, color:m.color, badge:m.badge, desc:m.desc, opp, onOpp:null };
    room.d = d;
    room.oppId = opp.id;
    // Прогрес суперника
    roomRef.child('p/' + opp.id).on('value', s=>{ const p = s.val(); if(p && room?.d === d) d.onOpp?.({ pos:p.pos || 0, fin:p.fin || 0, left:!!p.left }); });
    closeBox();
    const wait = Math.max(0, r.start - serverNow() - COUNTDOWN_MS);
    setTimeout(()=>{ if(room?.d === d) opts.start(d); }, wait);
  }
  function oppLeft(){ room?.d?.onOpp?.({ pos:-1, fin:0, left:true }); }

  /* ---------- Вікно дуелі ---------- */
  const css = `
    .duel{--ink:#1B1B3A; --soft:#514F72; --teal:#16A3A0; --teal-d:#0E7C7A; --line:#E4E1F5; --coral:#C2410C;
      font-family:'Nunito Sans',system-ui,sans-serif; color:var(--ink); line-height:1.45; box-sizing:border-box;}
    .duel *{box-sizing:border-box;}
    #duelBox{position:fixed; inset:0; z-index:2147483640; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(27,27,58,.55); overflow:auto;}
    .duel-card{background:#fff; border-radius:26px; padding:22px 22px 16px; max-width:460px; width:100%; text-align:center; box-shadow:0 20px 50px rgba(27,27,58,.25);}
    .duel-big{font-size:44px; line-height:1;}
    .duel h2{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:25px; line-height:1.2; margin:8px 0 4px;}
    .duel p{margin:0; color:var(--soft); font-size:15.5px;}
    .duel button{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:16px; border:none; border-radius:999px; padding:7px 18px; cursor:pointer; background:var(--teal); color:#fff;}
    .duel button:hover{background:var(--teal-d);}
    .duel button.light{background:#E3F7F6; color:var(--teal-d);}
    .duel button.ghost{background:none; color:var(--soft); font-size:14.5px; font-weight:600; padding:4px 10px; text-decoration:underline;}
    .duel .row{display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:12px;}
    .duel .err{min-height:1.4em; margin-top:8px; color:var(--coral); font-size:14.5px; font-weight:700;}
    .duel-list{display:flex; flex-direction:column; gap:6px; margin:14px 0 4px; max-height:46vh; overflow:auto; text-align:left;}
    .duel-item{display:flex; align-items:center; gap:10px; background:#F6F5FB; border-radius:14px; padding:8px 10px 8px 14px; font-weight:700; font-size:17px;}
    .duel-item span{flex:1;}
    .duel-inv{background:#FFF4E5; border:1.5px solid #FDBA74; border-radius:16px; padding:10px 12px; margin-top:12px; text-align:left;}
    .duel-inv b{display:block; font-size:16.5px;}
    .duel-inv small{color:var(--soft);}
    .duel-inv .row{justify-content:flex-start; margin-top:8px;}`;
  const EVENTS = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'touchstart'];
  const block = e=>{ if(box && !box.contains(e.target)) e.stopImmediatePropagation(); };
  function openBox(){
    if(box) return;
    if(!document.getElementById('duelCss')){ const st = document.createElement('style'); st.id = 'duelCss'; st.textContent = css; document.head.appendChild(st); }
    box = document.createElement('div');
    box.id = 'duelBox';
    box.className = 'duel';
    document.body.appendChild(box);
    EVENTS.forEach(t=>window.addEventListener(t, block, { capture:true, passive:false }));
    EVENTS.forEach(t=>box.addEventListener(t, e=>e.stopPropagation()));
  }
  function closeBox(){
    if(!box) return;
    EVENTS.forEach(t=>window.removeEventListener(t, block, { capture:true }));
    box.remove();
    box = null;
  }
  const card = html=>{ if(box) box.innerHTML = `<div class="duel-card">${html}</div>`; };
  const on = (sel, fn)=>box && box.querySelectorAll(sel).forEach(b=>b.addEventListener('click', fn));

  let note = '';
  function render(msg){
    if(msg !== undefined) note = msg;
    if(!box || room?.started) return;
    if(room && room.host){
      card(`<div class="duel-big">⏳</div><h2>Чекаю на ${esc(room.toLabel)}…</h2><p>Щойно суперник прийме виклик, почнеться відлік.</p>
        <div class="row"><button class="light" data-a="cancel">Скасувати</button></div>`);
      on('[data-a="cancel"]', ()=>{ dropRoom(); render(''); });
      return;
    }
    if(room && !room.host){
      card(`<div class="duel-big">🏁</div><h2>Дуель з ${esc(room.fromLabel)}</h2><p>Зараз почнеться відлік…</p>`);
      return;
    }
    const fresh = serverNow() - 3 * 60e3;
    const others = Object.entries(lobby).filter(([id, v])=>id !== me.id && v && v.game === GAME && (v.at || 0) > fresh)
      .sort((a, b)=>String(a[1].label).localeCompare(String(b[1].label), 'uk'));
    const inv = Object.entries(invites).filter(([, v])=>v && v.room);
    card(`<div class="duel-big">⚔️</div><h2>Дуель з однокласником</h2>
      <p>${others.length ? 'Обери, кого покликати. У списку ті, хто зараз відкрив «Дуель» у цій грі.' : 'Поки тут нікого. Попроси друга відкрити «Дуель» у своїй грі — і він з\'явиться тут.'}</p>
      ${inv.map(([id, v])=>`<div class="duel-inv"><b>${esc(v.label)} кличе тебе на дуель!</b>${v.desc ? `<small>${esc(v.desc)}</small>` : ''}
        <div class="row"><button data-acc="${esc(id)}">Прийняти</button><button class="light" data-no="${esc(id)}">Ні</button></div></div>`).join('')}
      ${others.length ? `<div class="duel-list">${others.map(([id, v])=>`<div class="duel-item"><span>${esc(v.label)}</span><button data-inv="${esc(id)}">Покликати</button></div>`).join('')}</div>` : ''}
      <div class="err">${esc(note)}</div>
      <div class="row"><button class="ghost" data-a="close">Закрити</button></div>`);
    on('[data-inv]', e=>{ note = ''; invite(e.currentTarget.dataset.inv); });
    on('[data-acc]', e=>{ note = ''; accept(e.currentTarget.dataset.acc); });
    on('[data-no]', e=>decline(e.currentTarget.dataset.no));
    on('[data-a="close"]', ()=>Duel.leave());
  }

  /* ---------- API для гри ---------- */
  const Duel = {
    available(){ const u = ACC.user; return !!(u && !u.guest && u.cls); },
    async open(o){
      if(!Duel.available()) return;
      opts = o;
      note = '';
      openBox();
      card(`<div class="duel-big">📡</div><h2>Підключаюсь…</h2><p>Шукаю однокласників.</p>`);
      if(!await connect()){
        db?.goOffline();
        card(`<div class="duel-big">📵</div><h2>Немає зв'язку</h2><p>Без інтернету дуель не вийде. Можна поїхати самому з роботом.</p>
          <div class="row"><button data-a="solo">🚦 Їхати з роботом</button><button class="light" data-a="close">Закрити</button></div>`);
        on('[data-a="solo"]', ()=>{ closeBox(); opts.solo(); });
        on('[data-a="close"]', closeBox);
        return;
      }
      if(!box) return;   // поки чекали, вікно закрили
      enterLobby();
      render();
    },
    pos(n){
      if(!room?.started || !roomRef) return;
      pendingPos = n;
      const send = ()=>{ lastSent = Date.now(); roomRef?.child('p/' + me.id).update({ pos:pendingPos }); };
      clearTimeout(sendTimer);
      if(Date.now() - lastSent >= 200) send(); else sendTimer = setTimeout(send, 200 - (Date.now() - lastSent));
    },
    finish(){
      if(!room?.started || !roomRef) return;
      clearTimeout(sendTimer);
      roomRef.child('p/' + me.id).update({ pos:pendingPos, fin:firebase.database.ServerValue.TIMESTAMP });
    },
    leave(){
      clearTimeout(sendTimer);
      dropRoom();
      leaveLobby();
      closeBox();
      db?.goOffline();   // поза дуеллю не тримаємо з'єднання: у безкоштовного тарифу Firebase їх до 100 одночасно
    },
  };
  window.Duel = Duel;
})();
