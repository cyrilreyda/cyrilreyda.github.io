// Замок «лише на уроці» для каталогу й усіх ігор сайту. Підключається в <head> каталогу й кожної гри: <script src="/lock.js">.
// Поки ігри на цьому комп'ютері закриті, сторінку закриває заставка з полем «Код уроку». Код — 4 цифри, свій на кожен день.
// Вчитель бачить його на сторінці /teacher/ і показує класу на дошці. Введений код відкриває всі ігри сайту на цьому
// комп'ютері до кінця дня: localStorage у каталогу й ігор спільний. Вчитель може відкрити ігри й без коду, своїм PIN:
// на сьогодні або на цьому комп'ютері назавжди (комп'ютер у класі, який не стирає налаштування).
// Це захист від цікавості, а не від злому: код можна обчислити з відкритого коду сайту, а гра, розпакована з архіву,
// замка не має (/lock.js поруч немає — гра відкривається як завжди).
(()=>{
  // Вимикач замка. false — каталог і ігри відкриті всім без коду, сторінка вчителя лише каже, що замок вимкнено.
  // Щоб увімкнути знову, досить поставити true: ігри підключають /lock.js і далі
  const ENABLED = false;
  const SALT = 'pc6ggc33be';
  const PIN_HASH = 3322279215;   // hash(SALT + 'pin:' + PIN); як змінити PIN — README каталогу
  const UNLOCK = 'lesson-unlock';   // 'forever' або день 'YYYY-MM-DD', до кінця якого ігри відкриті
  const TEACHER = 'lesson-teacher'; // '1' — на цьому комп'ютері вже вводили PIN вчителя
  const teacherPage = !!(document.currentScript && document.currentScript.hasAttribute('data-teacher'));

  const day = (d = new Date())=>`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hash = s=>{ let h = 2166136261; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const codeFor = d=>String(1000 + hash(SALT + d) % 9000);
  const pinOk = p=>hash(SALT + 'pin:' + p.trim()) === PIN_HASH;
  const get = k=>{ try{ return localStorage.getItem(k); }catch(e){ return null; } };
  const set = (k, v)=>{ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }catch(e){} };
  const state = ()=>{ const v = get(UNLOCK); return v === 'forever' ? 'forever' : v === day() ? 'today' : 'locked'; };
  const onReady = fn=>document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn();

  const css = `
    html.lesson-locked body > :not(#lessonLock){visibility:hidden !important;}
    .ll{--ink:#1B1B3A; --soft:#514F72; --teal:#16A3A0; --teal-d:#0E7C7A; --line:#E4E1F5; --coral:#C2410C;
      font-family:'Nunito Sans',system-ui,sans-serif; color:var(--ink); line-height:1.5; box-sizing:border-box;}
    .ll *{box-sizing:border-box;}
    #lessonLock{position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; padding:16px; background:#F6F5FB; overflow:auto;}
    .ll-card{background:#fff; border:1.5px solid var(--line); border-radius:26px; padding:28px 26px 22px; max-width:420px; width:100%; text-align:center;
      box-shadow:0 20px 50px rgba(27,27,58,.12);}
    .ll-big{font-size:52px; line-height:1;}
    .ll h2{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:26px; line-height:1.2; margin:10px 0 4px;}
    .ll p{margin:0; color:var(--soft); font-size:15.5px;}
    .ll form{display:flex; gap:8px; margin:18px 0 6px;}
    .ll input{flex:1; min-width:0; font:inherit; font-size:26px; font-weight:700; letter-spacing:.3em; text-align:center; padding:6px 10px;
      border:2px solid var(--line); border-radius:14px; outline:none; color:var(--ink);}
    .ll input.pin{font-size:20px; letter-spacing:.15em;}
    .ll input:focus{border-color:var(--teal);}
    .ll button{font-family:'Baloo 2',system-ui,sans-serif; font-weight:700; font-size:17px; border:none; border-radius:999px; padding:8px 20px; cursor:pointer;
      background:var(--teal); color:#fff;}
    .ll button:hover{background:var(--teal-d);}
    .ll button.ghost{background:none; color:var(--soft); font-size:14px; font-weight:600; padding:4px 10px; text-decoration:underline;}
    .ll button.light{background:#E3F7F6; color:var(--teal-d);}
    .ll .err{min-height:1.5em; color:var(--coral); font-size:14px; font-weight:700;}
    .ll .row{display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin:6px 0 4px;}
    .ll-code{font-family:'Baloo 2',system-ui,sans-serif; font-weight:800; font-size:clamp(90px, 22vw, 180px); line-height:1; letter-spacing:.08em; color:var(--ink); margin:8px 0 4px;}
    .ll-status{margin-top:14px; padding:8px 12px; border-radius:12px; background:#F6F5FB; font-size:14.5px; color:var(--soft);}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // Форма PIN вчителя. ok — що робити після правильного PIN; remember — запам'ятати вчителя на цьому комп'ютері
  // (лише на сторінці вчителя: на комп'ютері учня кнопка «Я вчитель» щоразу питає PIN)
  const pinForm = (box, ok, remember, hint = 'PIN вчителя')=>{
    box.innerHTML = `<form><input class="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="${hint}" aria-label="${hint}"><button>OK</button></form><div class="err"></div>`;
    const f = box.querySelector('form'), inp = box.querySelector('input'), err = box.querySelector('.err');
    f.addEventListener('submit', e=>{
      e.preventDefault();
      if(pinOk(inp.value)){ if(remember) set(TEACHER, '1'); ok(); }
      else { err.textContent = 'PIN не підходить'; inp.select(); }
    });
    inp.focus();
  };

  /* ---------- Сторінка вчителя /teacher/ ---------- */
  if(teacherPage){
    onReady(()=>{
      const root = document.getElementById('teacher');
      root.classList.add('ll');
      if(!ENABLED){
        root.innerHTML = `<div class="ll-card"><div class="ll-big">🔓</div><h2>Код уроку не потрібен</h2>
          <p>Замок вимкнено: каталог і всі ігри відкриті без коду.</p>
          <div class="row"><a href="/" style="color:var(--teal-d); font-weight:700;">← До ігор</a></div></div>`;
        return;
      }
      const render = ()=>{
        if(get(TEACHER) !== '1'){
          root.innerHTML = `<div class="ll-card"><div class="ll-big">🔑</div><h2>Для вчителя</h2>
            <p>Введіть PIN вчителя. На цьому комп'ютері його більше не питатимуть.</p><div id="llPin"></div></div>`;
          pinForm(root.querySelector('#llPin'), render, true);
          return;
        }
        const s = state();
        root.innerHTML = `<div class="ll-card">
          <p>Код уроку на сьогодні, ${new Date().toLocaleDateString('uk', { day:'numeric', month:'long' })}</p>
          <div class="ll-code">${codeFor(day())}</div>
          <p>Покажіть код класу. Учень вводить його один раз, і всі ігри на його комп'ютері відкриті до кінця дня.</p>
          <div class="ll-status">Цей комп'ютер: ${s === 'forever' ? 'ігри відкриті назавжди' : s === 'today' ? 'ігри відкриті до кінця дня' : 'ігри закриті'}</div>
          <div class="row">
            ${s !== 'forever' ? '<button class="light" data-a="forever">Відкрити тут назавжди</button>' : ''}
            ${s !== 'locked' ? '<button class="light" data-a="lock">Закрити ігри тут</button>' : ''}
          </div>
          <div class="row"><a href="/" style="color:var(--teal-d); font-weight:700;">← До ігор</a>
            <button class="ghost" data-a="forget">Забути PIN на цьому комп'ютері</button></div>
        </div>`;
        root.querySelectorAll('[data-a]').forEach(b=>b.addEventListener('click', ()=>{
          const a = b.dataset.a;
          if(a === 'forever') set(UNLOCK, 'forever');
          if(a === 'lock') set(UNLOCK, null);
          if(a === 'forget') set(TEACHER, null);
          render();
        }));
      };
      render();
    });
    return;
  }

  /* ---------- Каталог і ігри: заставка, поки ігри закриті ---------- */
  if(!ENABLED || state() !== 'locked') return;
  const html = document.documentElement;
  html.classList.add('lesson-locked');
  let lock = null;
  // Поки замкнено, події з-поза заставки не доходять до гри (клавіші, клацання, колесо)
  const EVENTS = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'touchstart'];
  const block = e=>{ if(lock && !lock.contains(e.target)) e.stopImmediatePropagation(); };
  EVENTS.forEach(t=>window.addEventListener(t, block, { capture:true, passive:false }));

  const open = ()=>{
    html.classList.remove('lesson-locked');
    EVENTS.forEach(t=>window.removeEventListener(t, block, { capture:true }));
    lock.remove();
    lock = null;
  };
  onReady(()=>{
    lock = document.createElement('div');
    lock.id = 'lessonLock';
    lock.className = 'll';
    const catalog = location.pathname === '/' || location.pathname === '/index.html';
    lock.innerHTML = `<div class="ll-card"><div class="ll-big">🔒</div><h2>${catalog ? 'Ігри відкриваються' : 'Гра відкривається'} на уроці</h2>
      <p>Введи код уроку, який показує вчитель.</p>
      <form id="llCode"><input inputmode="numeric" maxlength="4" autocomplete="off" placeholder="····" aria-label="Код уроку"><button>Відкрити</button></form>
      <div class="err"></div>
      <div id="llTeacher"><button class="ghost" type="button">Я вчитель</button></div></div>`;
    document.body.appendChild(lock);
    // Події всередині заставки теж не мають дійти до обробників гри на document
    EVENTS.forEach(t=>lock.addEventListener(t, e=>e.stopPropagation()));
    const f = lock.querySelector('#llCode'), inp = f.querySelector('input'), err = lock.querySelector('.err');
    f.addEventListener('submit', e=>{
      e.preventDefault();
      if(inp.value.trim() === codeFor(day())){ set(UNLOCK, day()); open(); }
      else { err.textContent = 'Код не підходить. Перевір цифри на дошці.'; inp.select(); }
    });
    const t = lock.querySelector('#llTeacher');
    t.querySelector('button').addEventListener('click', ()=>{
      const choose = ()=>{
        t.innerHTML = `<div class="row"><button type="button" data-a="today">Відкрити на сьогодні</button><button type="button" class="light" data-a="forever">Назавжди на цьому комп'ютері</button></div>
          <div class="row"><a href="/teacher/" style="color:var(--teal-d); font-weight:700; font-size:14.5px;">Код уроку для класу →</a></div>`;
        t.querySelectorAll('[data-a]').forEach(b=>b.addEventListener('click', ()=>{ set(UNLOCK, b.dataset.a === 'forever' ? 'forever' : day()); open(); }));
      };
      pinForm(t, choose, false);
    });
    setTimeout(()=>inp.focus(), 50);
  });
})();
