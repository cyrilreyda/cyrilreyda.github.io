// Повний екран у встановленій програмі (гра чи каталог, відкриті з ярлика, без рядка адреси): перший клік або
// натискання клавіші в грі розгортає її на весь екран, без F11. Браузер дозволяє це лише у відповідь на дію людини,
// тому не одразу при відкритті. Esc виходить; знову гра сама розгорнеться, коли її відкрити наступного разу,
// а до того — кнопкою повного екрана в грі. У звичайній вкладці браузера нічого не робить.
// Підключається в <head> ігор з кнопкою повного екрана (#fsBtn). «Гарячі клавіші» — без нього: там учать Esc.
(()=>{
  const app = ['standalone', 'minimal-ui', 'window-controls-overlay'].some(m=>matchMedia(`(display-mode: ${m})`).matches);
  if(!app || !document.documentElement.requestFullscreen) return;
  const go = e=>{
    if(e.type === 'keydown' && (e.key === 'Escape' || e.key === 'F11')) return;   // Esc не розгортає, F11 браузер робить сам
    removeEventListener('pointerdown', go, true);
    removeEventListener('keydown', go, true);
    if(e.target.closest && e.target.closest('#fsBtn')) return;   // кнопка гри сама вмикає повний екран
    if(!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
  };
  addEventListener('pointerdown', go, true);
  addEventListener('keydown', go, true);
})();
