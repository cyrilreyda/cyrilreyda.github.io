# Інформатика в 131-й

Каталог ігор-тренажерів для уроків інформатики: https://cyrilreyda.github.io/

| Гра | Що тренує | Репозиторій |
|---|---|---|
| Мишачі перегони | ліва й права кнопки миші, колесо | [mouse-race-kids](https://github.com/cyrilreyda/mouse-race-kids) |
| Двічі клац! | подвійне клацання, влучність | [double-click-kids](https://github.com/cyrilreyda/double-click-kids) |
| Клавіатурні перегони Junior | друк | [typing-race-kids](https://github.com/cyrilreyda/typing-race-kids) |
| Гарячі клавіші | клавіатурні скорочення | [hot-keys](https://github.com/cyrilreyda/hot-keys) |

Сторінка — один файл `index.html`. Ігри лежать у власних репозиторіях і відкриваються за адресою `/<репозиторій>/`, тож посилання в картках відносні до кореня сайту. Картинки в `img/` — знімки екрана ігор, 16:10.

Нова гра: картка в `index.html` у потрібному розділі, знімок у `img/`, рядок у таблиці вище, а в шапці самої гри — посилання `← Інформатика в 131-й` на https://cyrilreyda.github.io/.

Локальна перевірка: з папки, де поруч лежать усі репозиторії, запустити `python -m http.server 8770` і відкрити http://localhost:8770/cyrilreyda.github.io/ (посилання на ігри ведуть на http://localhost:8770/<гра>/).
