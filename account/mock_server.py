"""Локальна заміна Apps Script (Code.gs) для перевірки входу й синхронізації без Google.

Запуск: python account/mock_server.py   (http://localhost:8790/)
Заодно віддає сайт так, як GitHub Pages: каталог у корені, ігри з сусідніх папок у /<гра>/ — тож працюють
/lock.js і /account.js. На localhost account.js звертається сюди, а не до Google.
Дані лише в пам'яті: після перезапуску все спочатку. Клас для перевірки — PIN 123456.
Відповіді повторюють Code.gs; змінюючи одне, змініть і друге.
"""
import hashlib
import hmac
import json
import sys
import time
import uuid
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8790
SECRET = b"mock-secret"
MAX_TRIES = 5
DELAY = float(sys.argv[1]) if len(sys.argv) > 1 else 0.6  # секунд на відповідь, як у Google

CLASSES = {"123456": "3-А", "654321": "4-Б"}
STUDENTS = [  # клас, прізвище, ім'я, нік, малюнки, помилки, id, покоління
    ["3-А", "Ко", "Оля"], ["3-А", "Кр", "Оля"], ["3-А", "Ш", "Максим"],
    ["3-А", "Б", "Софія"], ["3-А", "М", "Артем"], ["4-Б", "Т", "Іван"],
]
STUDENTS = [r + ["", "", 0, uuid.uuid4().hex[:8], 0] for r in STUDENTS]
PROGRESS = {}  # (id, гра) -> {"v": int, "data": obj}
NICK, PICS, FAILS, ID, GEN = 3, 4, 5, 6, 7


def h(text):
    return hmac.new(SECRET, text.encode(), hashlib.sha256).hexdigest()[:43]


def labels(students):
    out = {}
    for s in students:
        n = 1
        short = lambda x, k: x[2] + (" " + x[1][:k] + "." if x[1] else "")
        while n < len(s[1]) and any(o is not s and o[2] == s[2] and short(o, n) == short(s, n) for o in students):
            n += 1
        out[id(s)] = short(s, n)
    return out


def user(s, label):
    return {"id": s[ID], "name": label, "nick": s[NICK], "label": s[NICK] or label,
            "full": f"{s[NICK]} ({label})" if s[NICK] else label, "cls": h("class:" + s[0])[:22]}


def find(pin):
    name = CLASSES.get("".join(c for c in str(pin or "") if c.isdigit()))
    if not name:
        time.sleep(1)
        return None, None
    return name, [s for s in STUDENTS if s[0] == name]


def session(s, students):
    return {"ok": True, "token": s[ID] + "." + h(f"token:{s[ID]}:{s[GEN]}"), "user": user(s, labels(students)[id(s)]),
            "docs": {g: d for (i, g), d in PROGRESS.items() if i == s[ID]}}


def valid_pics(p):
    return isinstance(p, list) and len(p) == 2 and all(isinstance(x, int) and 0 <= x < 9 for x in p)


TEACHER_PIN = os.environ.get("MOCK_TEACHER_PIN", "000000")  # у Google — властивість скрипту TEACHER_PIN


def teacher(req):
    a = req.get("a")
    if "".join(c for c in str(req.get("tpin") or "") if c.isdigit()) != TEACHER_PIN:
        return {"error": "pin"}
    if a == "teacherClasses":
        return {"ok": True, "classes": [{"name": n, "count": sum(1 for s in STUDENTS if s[0] == n)} for n in CLASSES.values()]}
    students = [s for s in STUDENTS if s[0] == req.get("cls")]
    lab = labels(students)
    out = []
    for s in students:
        u = {"name": lab[id(s)], "nick": s[NICK], "joined": bool(s[PICS]), "games": {}, "pace": 0, "played": [], "last": 0}
        for (i, game), doc in PROGRESS.items():
            if i != s[ID]:
                continue
            d, t = doc.get("data") or {}, doc.get("t", 0)
            if game == "shared":
                u["pace"] = round((d.get("pace") or {}).get("all", 0))
                u["played"] = list((d.get("played") or {}).keys())
                continue
            g = u["games"].setdefault(game.replace("-boost", "").rsplit("-v", 1)[0], {"r": 0, "p": 0, "s": 0, "t": 0})
            g["r"] += d.get("races") or d.get("rounds") or d.get("games") or 0
            g["p"] += d.get("neurons") or d.get("total") or 0
            g["s"] += len(d.get("stickers") or {})
            g["t"] = max(g["t"], t)
            u["last"] = max(u["last"], t)
        out.append(u)
    return {"ok": True, "students": sorted(out, key=lambda u: u["name"])}


def handle(req):
    a = req.get("a")
    if a in ("teacherClasses", "teacherOverview"):
        return teacher(req)
    if a in ("classList", "setup", "login"):
        name, students = find(req.get("pin"))
        if name is None:
            return {"error": "pin"}
        if a == "classList":
            lab = labels(students)
            lst = [dict(user(s, lab[id(s)]), pics=bool(s[PICS]), locked=s[FAILS] >= MAX_TRIES) for s in students]
            return {"ok": True, "students": sorted(lst, key=lambda u: u["name"])}
        if not valid_pics(req.get("pics")):
            return {"error": "bad-request"}
        s = next((s for s in students if s[ID] == req.get("id")), None)
        if not s:
            return {"error": "no-student"}
        ph = h(f"pics:{s[ID]}:{req['pics'][0]}:{req['pics'][1]}")
        if a == "setup":
            if s[PICS]:
                return {"error": "has-pics"}
            nick = " ".join(str(req.get("nick") or "").split())[:16]
            if any(o is not s and o[NICK].lower() == nick.lower() for o in students if nick):
                return {"error": "nick-taken"}
            s[NICK], s[PICS], s[FAILS], s[GEN] = nick, ph, 0, s[GEN] + 1
            return session(s, students)
        if not s[PICS]:
            return {"error": "no-pics"}
        if s[FAILS] >= MAX_TRIES:
            return {"error": "locked"}
        if ph != s[PICS]:
            s[FAILS] += 1
            return {"error": "locked"} if s[FAILS] >= MAX_TRIES else {"error": "pics", "left": MAX_TRIES - s[FAILS]}
        s[FAILS] = 0
        return session(s, students)
    if a == "sync":
        sid = str(req.get("token") or "").split(".")[0]
        s = next((s for s in STUDENTS if s[ID] == sid), None)
        if not s or not s[PICS] or req["token"] != sid + "." + h(f"token:{sid}:{s[GEN]}"):
            return {"error": "token"}
        saved, conflicts, fresh = {}, {}, {}
        for game, doc in (req.get("put") or {}).items():
            cur = PROGRESS.get((sid, game))
            if cur and cur["v"] != doc.get("v"):
                conflicts[game] = cur
                continue
            PROGRESS[(sid, game)] = {"v": (cur["v"] if cur else 0) + 1, "data": doc.get("data"), "t": int(time.time() * 1000)}
            saved[game] = PROGRESS[(sid, game)]["v"]
        for (i, game), cur in PROGRESS.items():
            if i == sid and game not in saved and game not in conflicts and (req.get("have") or {}).get(game, 0) < cur["v"]:
                fresh[game] = cur
        return {"ok": True, "saved": saved, "conflicts": conflicts, "fresh": fresh, "tooBig": [], "cls": h("class:" + s[0])[:22]}
    if a == "reset":
        sid = str(req.get("token") or "").split(".")[0]
        s = next((s for s in STUDENTS if s[ID] == sid), None)
        if not valid_pics(req.get("pics")) or not str(req.get("game") or ""):
            return {"error": "bad-request"}
        if not s or not s[PICS] or req["token"] != sid + "." + h(f"token:{sid}:{s[GEN]}"):
            return {"error": "token"}
        if s[FAILS] >= MAX_TRIES:
            return {"error": "locked"}
        if h(f"pics:{sid}:{req['pics'][0]}:{req['pics'][1]}") != s[PICS]:
            s[FAILS] += 1
            return {"error": "locked"} if s[FAILS] >= MAX_TRIES else {"error": "pics", "left": MAX_TRIES - s[FAILS]}
        s[FAILS] = 0
        cur = PROGRESS.get((sid, req["game"]))
        v = (cur["v"] if cur else 0) + 1
        PROGRESS[(sid, req["game"])] = {"v": v, "data": req.get("data"), "t": int(time.time() * 1000)}
        return {"ok": True, "v": v}
    return {"error": "bad-request"}


SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # папка каталогу
GAMES = os.path.dirname(SITE)                                          # поруч лежать ігри


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parts = [p for p in path.split("?")[0].split("#")[0].split("/") if p and p != ".."]
        if parts and parts[0] != os.path.basename(SITE) and os.path.isdir(os.path.join(GAMES, parts[0])):
            return os.path.join(GAMES, *parts)
        return os.path.join(SITE, *parts)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        time.sleep(DELAY)
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        except ValueError:
            return self._send({"error": "bad-request"})
        self._send(handle(req))


if __name__ == "__main__":
    print(f"account mock on http://localhost:{PORT}/  (PIN 123456)")
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()
