// «Клас»: перегони всім класом. Заїзд відкриває й запускає вчитель на сторінці /teacher/race/, учні натискають «Клас»
// у грі й чекають. Хто чекає в мить «Старту», той і їде; хто прийшов пізніше — потрапляє в наступний заїзд.
// Підключається в <head> гри після /duel.js: <script src="/classrace.js">. Дані — у тій самій базі Firebase,
// що й «Разом» (duel.js): duel/<ключ класу>/race — стан заїзду від учителя, duel/<ключ класу>/cp/<учень> — учасники.
// Текст сторінка вчителя не надсилає: лише трасу, мову й зерно (seed); з нього гра кожного учня складає однаковий текст.
//
// Для гри:
//   Klass.available()      — чи можна (учень увійшов і є ключ класу)
//   Klass.open({ look, start, solo })
//     look                 — { model, color, badge }: як виглядає машинка учня в інших
//     start(d)             — почати заїзд: d = { track, lang, seed, me }. Як і в «Разом», кличеться так, щоб «Руш!»
//                            (2,25 с від початку заїзду в грі) прозвучало в мить старту. Далі Klass кличе
//                            d.onField(list) — усі учасники заїзду: [{ id, label, model, color, badge, pos, fin }]
//                            і d.onStop() — учитель зупинив заїзд
//     solo()               — немає зв'язку, учень обрав їхати з роботом
//   Klass.pos(n, len)      — скільки надруковано; на старті передати й len — довжину тексту
//   Klass.finish(), Klass.next(o) — після заїзду знову чекати наступного, Klass.leave()
(()=>{
  const ACC = window.Account, DUEL = window.Duel;
  if(!ACC || !DUEL) return;
  const GAME = location.pathname.split('/')[1] || 'game';
  const COUNTDOWN_MS = 2250;
  // Значок «Клас»: троє дітей. Емодзі групи людей Windows 10 малює погано або зовсім не знає, тож малюємо самі
  const ICON = '<svg class="klass-ico" viewBox="0 0 40 28" aria-hidden="true" style="height:1em; width:1.43em; vertical-align:-.12em"><path d="M1.5 28c0-6.2 3.6-9.4 8.5-9.4s8.5 3.2 8.5 9.4z" fill="#F08A5D"/><circle cx="10" cy="12.2" r="5" fill="#F2C39B"/><path d="M4.9 12c-.3-4 2.2-6.3 5.1-6.3s5.4 2.3 5.1 6.3c-1-1.9-2.9-2.9-5.1-2.9s-4.1 1-5.1 2.9z" fill="#7A4B2A"/><path d="M21.5 28c0-6.2 3.6-9.4 8.5-9.4s8.5 3.2 8.5 9.4z" fill="#6C5CE7"/><circle cx="30" cy="12.2" r="5" fill="#E8B48A"/><path d="M24.8 12.6c-.6-4.3 1.9-6.9 5.2-6.9s5.8 2.6 5.2 6.9l-.9-1.8c-.9-1.3-2.4-2-4.3-2s-3.4.7-4.3 2z M34.6 9.5c1.6.4 2.6 2 2.3 4.6-.9-.6-1.6-1.6-1.9-2.9z" fill="#2B2B3A"/><path d="M10.2 28c0-7.2 4.3-10.8 9.8-10.8s9.8 3.6 9.8 10.8z" fill="#16A3A0" stroke="#fff" stroke-width="1.2"/><circle cx="20" cy="10.6" r="5.7" fill="#F2C39B" stroke="#fff" stroke-width="1.2"/><path d="M14.2 10.4c-.3-4.6 2.5-7.2 5.8-7.2s6.1 2.6 5.8 7.2c-.8-1.6-2.2-2.6-3.6-3-.7 1.2-2.6 2-4.6 2-1.4 0-2.6-.4-3.4.9z" fill="#D9822B"/></svg>';
  const SEND_MS = 300;    // прогрес — не частіше ніж раз на 0,3 с: учасників багато, а між оновленнями машинки їдуть плавно

  const esc = s=>String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let db = null, base = null, me = null, opts = null, box = null;
  let race = null, field = {}, myRef = null, cur = null;   // cur — заїзд, у якому учень зараз їде
  let sendTimer = 0, lastSent = 0, pendingPos = 0;

  const inRound = (p, r)=>p && r && p.round === r.round;
  const roster = ()=>Object.entries(field).filter(([, p])=>inRound(p, race)).map(([id, p])=>({ id, ...p }));

  // Стан заїзду від учителя й список учасників
  let played = 0;   // номер заїзду, який учень уже проїхав: після фінішу той самий заїзд не починається вдруге
  const canBegin = ()=>race && race.state === 'race' && !cur && race.round !== played && field[me.id] && inRound(field[me.id], race);
  function onRace(s){
    race = s.val();
    if(race && race.game !== GAME) race = null;
    // Учитель зупинив заїзд або відкрив новий — поточний закінчено (гра вирішує, що показати)
    if(cur && (!race || race.state === 'stop' || race.round !== cur.round)){ const d = cur; cur = null; d.onStop?.(); }
    // Заїзд відкрито — стаємо в нього (і після свого попереднього заїзду, і якщо прийшли, поки йшов інший)
    if(race && race.state === 'lobby' && !cur && myRef) myRef.update({ round:race.round, pos:0 }).then(()=>myRef?.child('fin').remove());
    if(canBegin()) begin();
    render();
  }
  function onField(s){
    field = s.val() || {};
    if(cur) cur.onField?.(Object.entries(field).filter(([, p])=>p.round === cur.round).map(([id, p])=>({ id, ...p })));
    if(canBegin()) begin();
    render();
  }

  function begin(){
    const d = { round:race.round, track:race.track, lang:race.lang, seed:race.seed, me:me.id, onField:null, onStop:null };
    cur = d;
    played = race.round;
    pendingPos = 0; lastSent = 0;
    closeBox();
    const wait = Math.max(0, race.start - DUEL.serverNow() - COUNTDOWN_MS);
    setTimeout(()=>{ if(cur === d){ opts.start(d); d.onField?.(roster()); } }, wait);
  }

  /* ---------- Вікно очікування ---------- */
  const css = `
    .klass{--ink:#1B1B3A; --soft:#514F72; --teal:#16A3A0; --teal-d:#0E7C7A; --line:#E4E1F5;
      font-family:'Nunito Sans',system-ui,sans-serif; color:var(--ink); line-height:1.45; box-sizing:border-box;}
    .klass *{box-sizing:border-box;}
    #klassBox{position:fixed; inset:0; z-index:2147483640; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(27,27,58,.55); overflow:auto;}
    .klass-card{background:#fff; border-radius:26px; padding:22px 22px 16px; max-width:460px; width:100%; text-align:center; box-shadow:0 20px 50px rgba(27,27,58,.25);}
    .klass-big{font-size:44px; line-height:1;}
    .klass h2{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:25px; line-height:1.2; margin:8px 0 4px;}
    .klass p{margin:0; color:var(--soft); font-size:15.5px;}
    .klass button{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:16px; border:none; border-radius:999px; padding:7px 18px; cursor:pointer; background:var(--teal); color:#fff;}
    .klass button.light{background:#E3F7F6; color:var(--teal-d);}
    .klass button.ghost{background:none; color:var(--soft); font-size:14.5px; font-weight:600; padding:4px 10px; text-decoration:underline;}
    .klass .row{display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:12px;}
    .klass-list{display:flex; flex-wrap:wrap; gap:6px; justify-content:center; margin:14px 0 4px; max-height:40vh; overflow:auto;}
    .klass-list span{background:#F6F5FB; border-radius:999px; padding:4px 12px; font-weight:700; font-size:15px;}
    .klass-list span.me{background:#E3F7F6; color:var(--teal-d);}`;
  const EVENTS = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'touchstart'];
  const block = e=>{ if(box && !box.contains(e.target)) e.stopImmediatePropagation(); };
  function openBox(){
    if(box) return;
    if(!document.getElementById('klassCss')){ const st = document.createElement('style'); st.id = 'klassCss'; st.textContent = css; document.head.appendChild(st); }
    box = document.createElement('div');
    box.id = 'klassBox';
    box.className = 'klass';
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
  const card = html=>{ if(box) box.innerHTML = `<div class="klass-card">${html}</div>`; };
  const on = (sel, fn)=>box && box.querySelectorAll(sel).forEach(b=>b.addEventListener('click', fn));

  function render(){
    if(!box || cur) return;
    const list = race ? roster() : [];
    const names = list.length ? `<div class="klass-list">${list.map(p=>`<span class="${p.id === me.id ? 'me' : ''}">${esc(p.label)}</span>`).join('')}</div>` : '';
    let body;
    if(!race || race.state === 'stop') body = `<div class="klass-big">${ICON}</div><h2>Перегони класом</h2>
      <p>Учитель ще не відкрив заїзд. Чекай тут — щойно відкриє, ти будеш у списку.</p>`;
    else if(race.state === 'lobby') body = `<div class="klass-big">${ICON}</div><h2>Чекаємо на старт</h2>
      <p>Ти в заїзді класу. Учитель натисне «Старт», і почнеться відлік. Уже готові: ${list.length}.</p>${names}`;
    else if(race.round === played) body = `<div class="klass-big">${ICON}</div><h2>Чекаємо на наступний заїзд</h2>
      <p>Інші ще фінішують. Щойно вчитель відкриє новий заїзд, ти будеш у ньому.</p>`;
    else body = `<div class="klass-big">⏳</div><h2>Заїзд уже йде</h2>
      <p>Дочекайся наступного — ти потрапиш у нього сам, щойно вчитель його відкриє.</p>`;
    card(body + `<div class="row"><button class="ghost" data-a="close">Вийти</button></div>`);
    on('[data-a="close"]', ()=>Klass.leave());
  }

  /* ---------- API для гри ---------- */
  const Klass = {
    icon:ICON,   // для кнопки «Клас» у грі й сторінки вчителя
    available(){ return DUEL.available(); },
    async open(o){
      if(!Klass.available()) return;
      opts = o;
      openBox();
      card(`<div class="klass-big">📡</div><h2>Підключаюсь…</h2>`);
      db = await DUEL.db();
      if(!db){
        card(`<div class="klass-big">📵</div><h2>Немає зв'язку</h2><p>Без інтернету перегони класом не вийдуть. Можна поїхати з роботом.</p>
          <div class="row"><button data-a="solo">🚦 Їхати з роботом</button><button class="light" data-a="close">Закрити</button></div>`);
        on('[data-a="solo"]', ()=>{ closeBox(); opts.solo(); });
        on('[data-a="close"]', closeBox);
        return;
      }
      if(!box) return;
      const u = ACC.user;
      me = { id:u.id, label:u.label };
      base = db.ref('duel/' + u.cls);
      myRef = base.child('cp/' + me.id);
      myRef.onDisconnect().remove();
      const look = o.look || {};
      await myRef.set({ label:me.label, model:look.model || '', color:look.color || '', badge:look.badge || '', round:0 }).catch(()=>{});
      base.child('race').on('value', onRace);
      base.child('cp').on('value', onField);
      render();
    },
    // len — довжина тексту: гра передає її один раз на старті, щоб на проєкторі смужки рахувались від фінішу, а не від лідера
    pos(n, len){
      if(!cur || !myRef) return;
      if(len) myRef.update({ len });
      pendingPos = n;
      const send = ()=>{ lastSent = Date.now(); myRef?.update({ pos:pendingPos }); };
      clearTimeout(sendTimer);
      if(Date.now() - lastSent >= SEND_MS) send(); else sendTimer = setTimeout(send, SEND_MS - (Date.now() - lastSent));
    },
    finish(){
      if(!cur || !myRef) return;
      clearTimeout(sendTimer);
      myRef.update({ pos:pendingPos, fin:firebase.database.ServerValue.TIMESTAMP });
    },
    // Після заїзду — знову чекати наступного (вікно очікування); учасником лишаємось
    next(o){
      cur = null;
      if(o) opts = o;
      openBox();
      render();
    },
    leave(){
      clearTimeout(sendTimer);
      cur = null;
      base?.child('race').off('value', onRace);
      base?.child('cp').off('value', onField);
      myRef?.remove();
      myRef?.onDisconnect().cancel();
      myRef = null; base = null; race = null; field = {};
      closeBox();
      DUEL.offline();
    },
  };
  window.Klass = Klass;
})();
