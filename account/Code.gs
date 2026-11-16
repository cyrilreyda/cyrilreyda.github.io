/**
 * Спільний акаунт учня для всіх ігор сайту: сервер на Google Таблиці.
 * Скрипт прив'язаний до таблиці (Розширення → Apps Script) і бачить лише її.
 * Розгортання: вебзастосунок, «Виконувати як: я», «Хто має доступ: будь-хто».
 * Як налаштувати й вести таблицю — README каталогу, розділ «Акаунт учня».
 *
 * @OnlyCurrentDoc
 */

const SHEET_CLASSES = 'Класи';     // A: клас (лише для вчителя), B: PIN класу
const SHEET_STUDENTS = 'Учні';     // A: клас, B: прізвище (можна лише першу літеру), C: ім'я, D: нік, E: малюнки, F: помилки, G: id, H: покоління
const SHEET_PROGRESS = 'Прогрес';  // A: id, B: гра, C: версія, D: дані, E: оновлено
const MAX_TRIES = 5;               // стільки помилок з малюнками — і вхід закрито, доки вчитель не скине
const MAX_DOC = 45000;             // у клітинці таблиці не більше 50 000 знаків
const PIN_FAILS_PER_10_MIN = 100;  // стільки хибних PIN за 10 хвилин на всіх — далі PIN не перевіряються до кінця 10 хвилин
const ANIMALS = 9, FOODS = 9;

// Версія коду: відкрийте адресу вебзастосунку в браузері — вона показується там. Змінювати разом з кодом
const VERSION = '2026-11-16';

const S = { CLASS:0, LAST:1, FIRST:2, NICK:3, PICS:4, FAILS:5, ID:6, GEN:7 };
const P = { ID:0, GAME:1, VER:2, DATA:3, TIME:4 };

function doGet(){
  return json({ ok:true, service:'account', version:VERSION });
}

function doPost(e){
  let req;
  try{ req = JSON.parse(e.postData.contents); }catch(err){ return json({ error:'bad-request' }); }
  try{
    const fn = { classList, setup, login, sync, teacherClasses, teacherOverview }[req.a];
    return json(fn ? fn(req) : { error:'bad-request' });
  }catch(err){
    console.error(err);
    return json({ error:'server' });
  }
}

const json = o=>ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

/* ---------- Таблиця ---------- */

function sheet(name, header){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if(!sh){ sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}
const classesSheet = ()=>sheet(SHEET_CLASSES, ['Клас', 'PIN']);
const studentsSheet = ()=>sheet(SHEET_STUDENTS, ['Клас', 'Прізвище', "Ім'я", 'Нік', 'Малюнки', 'Помилки', 'id', 'Покоління']);
const progressSheet = ()=>sheet(SHEET_PROGRESS, ['id', 'Гра', 'Версія', 'Дані', 'Оновлено']);

// Щонайменше 8 стовпців: поки «Нік», «Малюнки» тощо ще порожні, таблиця їх не рахує, а скрипт має бачити їх порожніми
function rows(sh){
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, Math.max(8, sh.getLastColumn())).getValues() : [];
}

function secret(){
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SECRET');
  if(!s){ s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('SECRET', s); }
  return s;
}
function hmac(text){
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret())).replace(/=+$/, '');
}

// Клас за PIN. Повертає { name, students:[{ row, r }] } або помилку
function findClass(pin){
  pin = String(pin || '').replace(/\D/g, '');
  const cache = CacheService.getScriptCache();
  const bucket = 'pinfail-' + Math.floor(Date.now() / 600000);
  if(+(cache.get(bucket) || 0) >= PIN_FAILS_PER_10_MIN) return { error:'busy' };
  const cls = pin.length >= 4 && rows(classesSheet()).find(r=>String(r[1]).replace(/\D/g, '') === pin);
  if(!cls){
    cache.put(bucket, String(+(cache.get(bucket) || 0) + 1), 700);
    Utilities.sleep(1000);
    return { error:'pin' };
  }
  const name = String(cls[0]).trim();
  const sh = studentsSheet();
  let all = rows(sh);
  if(needIds(all, name)){
    const lock = LockService.getScriptLock(), own = !lock.hasLock();
    if(own) lock.waitLock(20000);
    try{ all = rows(sh); fixIds(sh, all, name); }finally{ if(own) lock.releaseLock(); }
  }
  const students = [];
  all.forEach((r, i)=>{ if(String(r[S.CLASS]).trim() === name && String(r[S.FIRST]).trim()) students.push({ row:i + 2, r }); });
  return { name, students };
}

// Чи є учні класу без id або два рядки з одним id (рядок скопіювали разом зі стовпцем id)
function needIds(all, name){
  const seen = new Set();
  return all.some(r=>{
    const id = String(r[S.ID]).trim();
    if(!id) return String(r[S.CLASS]).trim() === name && !!String(r[S.FIRST]).trim();
    if(seen.has(id)) return true;
    seen.add(id);
    return false;
  });
}

// Новим учням класу — id (раз і назавжди, щоб прогрес не залежав від написання імені).
// Повторний id: перший рядок зберігає id і прогрес, копія стає новим учнем — новий id, порожні нік і малюнки
function fixIds(sh, all, name){
  const taken = new Set(all.map(r=>String(r[S.ID]).trim()).filter(Boolean)), seen = new Set();
  const newId = ()=>{
    let id;
    do id = Utilities.getUuid().slice(0, 8); while(taken.has(id) || /^\d*e?\d*$/i.test(id));   // лише цифри таблиця перетворить на число
    taken.add(id);
    return id;
  };
  all.forEach((r, i)=>{
    const id = String(r[S.ID]).trim();
    if(id && !seen.has(id)){ seen.add(id); return; }
    if(id){
      r[S.NICK] = r[S.PICS] = r[S.FAILS] = r[S.GEN] = '';
      r[S.ID] = newId();
      sh.getRange(i + 2, S.NICK + 1, 1, 5).setValues([['', '', '', r[S.ID], '']]);
    }else if(String(r[S.CLASS]).trim() === name && String(r[S.FIRST]).trim()){
      r[S.ID] = newId();
      sh.getRange(i + 2, S.ID + 1).setValue(r[S.ID]);
    }else return;
    seen.add(r[S.ID]);
  });
}

// Номер рядка учня просто перед записом. Якщо, поки скрипт працював, у таблиці вставили, видалили чи пересортували рядки,
// шукаємо учня за id заново: інакше запис потрапить сусідові
function studentRow(sh, s){
  const id = String(s.r[S.ID]);
  if(s.row <= sh.getLastRow() && String(sh.getRange(s.row, S.ID + 1).getValue()) === id) return s.row;
  const i = rows(sh).findIndex(r=>String(r[S.ID]) === id);
  if(i < 0) throw new Error('student row gone: ' + id);
  return s.row = i + 2;
}
// Те саме для рядка гри учня на аркуші «Прогрес»; 0 — рядка вже немає
function progressRow(sh, id, game, row){
  const same = r=>String(r[P.ID]) === id && String(r[P.GAME]) === game;
  if(row <= sh.getLastRow() && same(sh.getRange(row, 1, 1, 2).getValues()[0])) return row;
  const i = rows(sh).findIndex(same);
  return i < 0 ? 0 : i + 2;
}

// «Оля К.», а якщо в класі дві «Олі К.» — «Оля Ко.»; повне прізвище з сервера не виходить
function labels(students){
  const first = s=>String(s.r[S.FIRST]).trim(), last = s=>String(s.r[S.LAST]).trim();
  const out = new Map();
  students.forEach(s=>{
    let n = 1;
    const short = (x, k)=>first(x) + (last(x) ? ' ' + last(x).slice(0, k) + '.' : '');
    while(n < last(s).length && students.some(o=>o !== s && first(o) === first(s) && short(o, n) === short(s, n))) n++;
    out.set(s, short(s, n));
  });
  return out;
}
function userOf(s, label){
  const nick = String(s.r[S.NICK] || '').trim();
  return { id:String(s.r[S.ID]), name:label, nick, label:nick || label, full:nick ? `${nick} (${label})` : label, cls:classKey(s.r[S.CLASS]) };
}
// Ключ класу для дуелей: однаковий в усіх учнів класу, але з нього не дізнатися ні назви класу, ні PIN
const classKey = name=>hmac('class:' + String(name).trim()).slice(0, 22);

/* ---------- Дії ---------- */

function classList(req){
  const c = findClass(req.pin);
  if(c.error) return c;
  const lab = labels(c.students);
  const list = c.students.map(s=>Object.assign(userOf(s, lab.get(s)), {
    pics:!!String(s.r[S.PICS]).trim(), locked:+s.r[S.FAILS] >= MAX_TRIES,
  }));
  list.sort((a, b)=>a.name.localeCompare(b.name, 'uk'));
  return { ok:true, students:list };
}

const picsHash = (id, pics)=>hmac('pics:' + id + ':' + pics[0] + ':' + pics[1]);
const tokenFor = (id, gen)=>id + '.' + hmac('token:' + id + ':' + (gen || 0));
function validPics(p){
  return Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1]) &&
    p[0] >= 0 && p[0] < ANIMALS && p[1] >= 0 && p[1] < FOODS;
}
function cleanNick(n){
  return String(n || '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

// Перший вхід (або після скидання вчителем): нік і малюнки
function setup(req){
  if(!validPics(req.pics)) return { error:'bad-request' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    const c = findClass(req.pin);
    if(c.error) return c;
    const s = c.students.find(s=>String(s.r[S.ID]) === String(req.id));
    if(!s) return { error:'no-student' };
    if(String(s.r[S.PICS]).trim()) return { error:'has-pics' };
    const nick = cleanNick(req.nick);
    if(nick && nick.length < 2) return { error:'nick-short' };
    if(nick && c.students.some(o=>o !== s && String(o.r[S.NICK]).trim().toLowerCase() === nick.toLowerCase())) return { error:'nick-taken' };
    const gen = (+s.r[S.GEN] || 0) + 1;   // нове покоління — старі входи на інших пристроях більше не діють
    const sh = studentsSheet();
    sh.getRange(studentRow(sh, s), S.NICK + 1, 1, 5).setValues([[nick, picsHash(s.r[S.ID], req.pics), 0, s.r[S.ID], gen]]);
    s.r[S.NICK] = nick; s.r[S.GEN] = gen;
    return session(s, labels(c.students).get(s));
  }finally{ lock.releaseLock(); }
}

function login(req){
  if(!validPics(req.pics)) return { error:'bad-request' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    const c = findClass(req.pin);
    if(c.error) return c;
    const s = c.students.find(s=>String(s.r[S.ID]) === String(req.id));
    if(!s) return { error:'no-student' };
    if(!String(s.r[S.PICS]).trim()) return { error:'no-pics' };
    const fails = +s.r[S.FAILS] || 0;
    if(fails >= MAX_TRIES) return { error:'locked' };
    if(picsHash(s.r[S.ID], req.pics) !== String(s.r[S.PICS]).trim()){
      const sh = studentsSheet();
      sh.getRange(studentRow(sh, s), S.FAILS + 1).setValue(fails + 1);
      return fails + 1 >= MAX_TRIES ? { error:'locked' } : { error:'pics', left:MAX_TRIES - fails - 1 };
    }
    if(fails){ const sh = studentsSheet(); sh.getRange(studentRow(sh, s), S.FAILS + 1).setValue(0); }
    return session(s, labels(c.students).get(s));
  }finally{ lock.releaseLock(); }
}

function session(s, label){
  const id = String(s.r[S.ID]);
  return { ok:true, token:tokenFor(id, s.r[S.GEN]), user:userOf(s, label), docs:docsOf(id) };
}

function docsOf(id){
  const docs = {};
  rows(progressSheet()).forEach(r=>{
    if(String(r[P.ID]) !== id) return;
    try{ docs[r[P.GAME]] = { v:+r[P.VER] || 0, data:JSON.parse(r[P.DATA]) }; }catch(e){}
  });
  return docs;
}

// Учень за токеном; токен перестає діяти, коли вчитель скидає малюнки й учень обирає нові
function studentByToken(token){
  const id = String(token || '').split('.')[0];
  if(!id) return null;
  const sh = studentsSheet();
  const all = rows(sh);
  const i = all.findIndex(r=>String(r[S.ID]) === id);
  if(i < 0) return null;
  const r = all[i];
  if(!String(r[S.PICS]).trim() || tokenFor(id, r[S.GEN]) !== token) return null;
  return { row:i + 2, r };
}

// Синхронізація. req.put: { гра:{ v, data } } — v це версія, від якої пристрій рахував зміни.
// Якщо на сервері та сама версія — записуємо (v+1). Якщо новіша — не записуємо й віддаємо серверну:
// пристрій зведе обидві й надішле ще раз. req.have: { гра:v } — що вже є на пристрої; віддаємо лише новіше
function sync(req){
  const s = studentByToken(req.token);
  if(!s) return { error:'token' };
  const id = String(s.r[S.ID]);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    const sh = progressSheet();
    const all = rows(sh);
    const at = {};
    all.forEach((r, i)=>{ if(String(r[P.ID]) === id) at[r[P.GAME]] = { row:i + 2, v:+r[P.VER] || 0, data:r[P.DATA] }; });
    const saved = {}, conflicts = {}, tooBig = [];
    Object.keys(req.put || {}).forEach(game=>{
      if(!/^[a-z0-9-]{1,40}$/.test(game)) return;
      const doc = req.put[game], cur = at[game];
      const text = JSON.stringify(doc.data);
      if(text.length > MAX_DOC){ tooBig.push(game); return; }
      if(cur && cur.v !== +doc.v){ conflicts[game] = { v:cur.v, data:JSON.parse(cur.data) }; return; }
      const v = (cur ? cur.v : 0) + 1;
      const row = [id, game, v, text, new Date()];
      const to = cur && progressRow(sh, id, game, cur.row);
      if(to) sh.getRange(to, 1, 1, 5).setValues([row]);
      else sh.appendRow(row);
      at[game] = { v, data:text };
      saved[game] = v;
    });
    const fresh = {};
    Object.keys(at).forEach(game=>{
      if(saved[game] || conflicts[game]) return;
      if((+(req.have || {})[game] || 0) < at[game].v) fresh[game] = { v:at[game].v, data:JSON.parse(at[game].data) };
    });
    return { ok:true, saved, conflicts, fresh, tooBig, cls:classKey(s.r[S.CLASS]) };   // cls — тим, хто увійшов до появи дуелей
  }finally{ lock.releaseLock(); }
}

/* ---------- Огляд класу для вчителя (/teacher/class/) ---------- */
// PIN вчителя — у властивостях скрипту (Налаштування проєкту → Властивості скрипту → TEACHER_PIN), не в коді:
// код сайту відкритий. Після 20 хибних PIN за 10 хвилин сервер до кінця цих 10 хвилин їх не перевіряє
function teacherCheck(pin){
  const want = String(PropertiesService.getScriptProperties().getProperty('TEACHER_PIN') || '').replace(/\D/g, '');
  if(!want) return { error:'no-teacher-pin' };
  const cache = CacheService.getScriptCache(), bucket = 'tpinfail-' + Math.floor(Date.now() / 600000);
  if(+(cache.get(bucket) || 0) >= 20) return { error:'busy' };
  if(String(pin || '').replace(/\D/g, '') !== want){
    cache.put(bucket, String(+(cache.get(bucket) || 0) + 1), 700);
    Utilities.sleep(1000);
    return { error:'pin' };
  }
  return null;
}

function teacherClasses(req){
  const err = teacherCheck(req.tpin);
  if(err) return err;
  const st = rows(studentsSheet());
  const classes = rows(classesSheet()).map(r=>String(r[0]).trim()).filter(Boolean).map(name=>({
    name, count:st.filter(s=>String(s[S.CLASS]).trim() === name && String(s[S.FIRST]).trim()).length,
  }));
  return { ok:true, classes };
}

// Зведення класу: для кожного учня й кожної гри — скільки раундів (races / rounds / games), балів (neurons / total),
// наліпок і коли грав востаннє; ще звична швидкість друку (pace.all) і в які ігри вже грав (played)
function teacherOverview(req){
  const err = teacherCheck(req.tpin);
  if(err) return err;
  const name = String(req.cls || '').trim();
  const students = [];
  rows(studentsSheet()).forEach((r, i)=>{ if(String(r[S.CLASS]).trim() === name && String(r[S.FIRST]).trim()) students.push({ row:i + 2, r }); });
  const lab = labels(students);
  const list = students.map(s=>{
    const u = userOf(s, lab.get(s));
    return { name:u.name, nick:u.nick, id:u.id, joined:!!String(s.r[S.PICS]).trim(), games:{}, pace:0, played:[], last:0 };
  });
  const byId = {};
  list.forEach(u=>{ if(u.id) byId[u.id] = u; });
  rows(progressSheet()).forEach(p=>{
    const u = byId[String(p[P.ID])];
    if(!u) return;
    let d;
    try{ d = JSON.parse(p[P.DATA]); }catch(e){ return; }
    const t = p[P.TIME] instanceof Date ? p[P.TIME].getTime() : 0;
    if(p[P.GAME] === 'shared'){
      u.pace = Math.round((d.pace && d.pace.all) || 0);
      u.played = Object.keys(d.played || {});
      return;
    }
    const game = String(p[P.GAME]).replace(/(-boost)?-v\d+$/, '');   // звичайний і ?boost — одна гра
    const g = u.games[game] || (u.games[game] = { r:0, p:0, s:0, t:0 });
    g.r += +(d.races || d.rounds || d.games || 0);
    g.p += +(d.neurons || d.total || 0);
    g.s += Object.keys(d.stickers || {}).length;
    g.t = Math.max(g.t, t);
    u.last = Math.max(u.last, t);
  });
  list.forEach(u=>delete u.id);
  list.sort((a, b)=>a.name.localeCompare(b.name, 'uk'));
  return { ok:true, students:list };
}

// Запустити один раз із редактора: створює аркуші з заголовками й секрет
function init(){
  classesSheet(); studentsSheet(); progressSheet(); secret();
}
