#!/usr/bin/env python3
"""Rommancer Sync setup screen for handhelds with Python + pygame (Knulli, Batocera, ROCKNIX).

Everything is done with the gamepad: server address, log in or create an account, sync now,
status and sign out. Syncing itself is done by rommancer-sync.sh next to this file.
"""
import json
import os
import re
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
import pygame  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "rommancer-sync.sh")
CACERT = os.path.join(HERE, "cacert.pem")
# Pre-rendered spinning save point (tools/render_savepoint.py): square frames side by side
SPRITE = os.path.join(HERE, "savepoint.png")
SPRITE_FPS = 60
ES_INPUT = ["/userdata/system/configs/emulationstation/es_input.cfg", "/usr/share/emulationstation/es_input.cfg"]

TEXTS = {
    "es": {
        "title": "Rommancer Sync",
        "server": "Servidor",
        "login": "Entrar",
        "signup": "Crear cuenta",
        "quit": "Salir",
        "user": "Usuario o email",
        "username": "Usuario",
        "email": "Email",
        "password": "Contraseña",
        "connected": "Conectado a {server}",
        "as": "como {user}",
        "sync_now": "Sincronizar ahora",
        "status": "Estado",
        "logout": "Desconectar esta consola",
        "syncing": "Sincronizando...",
        "checking": "Conectando con el servidor...",
        "no_server": "Primero escribe la dirección del servidor",
        "bad_server": "No hay un Rommancer en esa dirección",
        "bad_login": "Usuario o contraseña incorrectos",
        "signup_closed": "Este servidor no permite crear cuentas",
        "exists": "Ese usuario o email ya existe",
        "error": "Error: {msg}",
        "done": "Listo. Los saves se sincronizan solos en segundo plano.",
        "logged_out": "Consola desconectada",
        "keys": "A tecla  B borrar  X mayús  Y espacio  START aceptar  SELECT cancelar",
        "menu_keys": "A elegir   B atrás",
        "press": "Pulsa A para continuar",
        "nolog": "Todavía no hay registro",
        "version": "Versión {v}",
        "installed": "instalada el {d}",
        "p_connecting": "Conectando con el servidor",
        "p_waiting": "Esperando a la sincronización en curso",
        "p_roms": "Comprobando roms",
        "p_saves": "Comprobando saves",
        "p_server": "Preguntando al servidor",
        "p_transfer": "Transfiriendo saves",
        "p_roms-plan": "Preguntando qué roms tocan",
        "p_roms-download": "Descargando roms",
        "sync_roms": "Sincronizar roms",
        "auto_roms": "Roms automáticas: {v}",
        "allow_pull": "El servidor puede traer juegos: {v}",
        "allow_ssh": "Acceso SSH del servidor: {v}",
        "p_pulls": "Enviando juegos al servidor",
        "yes": "sí",
        "no": "no",
        "conflicts": "Conflictos ({n})",
        "no_conflicts": "No hay conflictos",
        "conflict_info": "{game}: esta consola guardó el {mine}; el servidor tiene una versión del {theirs} ({dev}).",
        "keep_device": "Quedarme con el de esta consola",
        "keep_server": "Usar el del servidor",
    },
    "en": {
        "title": "Rommancer Sync",
        "server": "Server",
        "login": "Log in",
        "signup": "Create account",
        "quit": "Exit",
        "user": "Username or email",
        "username": "Username",
        "email": "Email",
        "password": "Password",
        "connected": "Connected to {server}",
        "as": "as {user}",
        "sync_now": "Sync now",
        "status": "Status",
        "logout": "Unlink this console",
        "syncing": "Syncing...",
        "checking": "Contacting the server...",
        "no_server": "Enter the server address first",
        "bad_server": "No Rommancer at that address",
        "bad_login": "Wrong username or password",
        "signup_closed": "This server does not allow new accounts",
        "exists": "That username or email already exists",
        "error": "Error: {msg}",
        "done": "Done. Saves now sync in the background.",
        "logged_out": "Console unlinked",
        "keys": "A key  B delete  X shift  Y space  START accept  SELECT cancel",
        "menu_keys": "A choose   B back",
        "press": "Press A to continue",
        "nolog": "No log yet",
        "version": "Version {v}",
        "installed": "installed {d}",
        "p_connecting": "Contacting the server",
        "p_waiting": "Waiting for the running sync",
        "p_roms": "Checking roms",
        "p_saves": "Checking saves",
        "p_server": "Asking the server",
        "p_transfer": "Transferring saves",
        "p_roms-plan": "Asking which roms belong here",
        "p_roms-download": "Downloading roms",
        "sync_roms": "Sync roms",
        "auto_roms": "Automatic roms: {v}",
        "allow_pull": "Server may fetch games: {v}",
        "allow_ssh": "Server SSH access: {v}",
        "p_pulls": "Sending games to the server",
        "yes": "yes",
        "no": "no",
        "conflicts": "Conflicts ({n})",
        "no_conflicts": "No conflicts",
        "conflict_info": "{game}: this console saved on {mine}; the server has a version from {theirs} ({dev}).",
        "keep_device": "Keep this console's save",
        "keep_server": "Use the server's save",
    },
}


def system_language():
    # Newer Knulli renamed batocera.conf to knulli.conf
    for conf in ("/userdata/system/knulli.conf", "/userdata/system/batocera.conf"):
        try:
            with open(conf, encoding="utf-8") as f:
                m = re.search(r"^system\.language=(\w\w)", f.read(), re.M)
                if m:
                    return m.group(1)
        except OSError:
            pass
    return (os.environ.get("LANG") or "en")[:2]


T = TEXTS.get(system_language(), TEXTS["en"])

# ---------- device state, shared with rommancer-sync.sh ----------


def hints():
    out = subprocess.run(["sh", SCRIPT, "hints"], capture_output=True, text=True, timeout=30).stdout
    return dict(line.split("\t", 1) for line in out.splitlines() if "\t" in line)


def read_config(state):
    cfg = {}
    try:
        with open(os.path.join(state, "config"), encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip("\n").split("=", 1)
                    cfg[k] = v
    except OSError:
        pass
    return cfg


def write_config(state, server, token, user):
    os.makedirs(state, exist_ok=True)
    path = os.path.join(state, "config")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"SERVER={server}\nTOKEN={token}\nUSER={user}\n")
    os.chmod(path, 0o600)


# ---------- server ----------


def ssl_context():
    ctx = ssl.create_default_context()
    if os.path.exists(CACERT):
        ctx.load_verify_locations(CACERT)
    return ctx


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def call(server, path, form=None):
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(server.rstrip("/") + "/api/v1" + path, data=data)
    try:
        with urllib.request.urlopen(req, timeout=20, context=ssl_context()) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            msg = json.loads(raw).get("error", raw)
        except ValueError:
            msg = raw.strip()
        raise ApiError(e.code, msg) from None
    return dict(line.split("\t", 1) for line in body.splitlines() if "\t" in line)


# ---------- input: the gamepad mapping EmulationStation already knows ----------


def es_mapping(joy):
    """Button/axis/hat ids of a joystick, by name, from EmulationStation's es_input.cfg."""
    for path in ES_INPUT:
        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError):
            continue
        for cfg in root.iter("inputConfig"):
            if cfg.get("type") != "joystick" or cfg.get("deviceName") != joy.get_name():
                continue
            return {i.get("name"): (i.get("type"), int(i.get("id")), int(i.get("value"))) for i in cfg.iter("input")}
    return {}


class Pad:
    KEYS = {
        pygame.K_UP: "up", pygame.K_DOWN: "down", pygame.K_LEFT: "left", pygame.K_RIGHT: "right",
        pygame.K_RETURN: "a", pygame.K_BACKSPACE: "b", pygame.K_ESCAPE: "select", pygame.K_TAB: "x",
        pygame.K_SPACE: "y", pygame.K_F1: "start",
    }

    def __init__(self):
        pygame.joystick.init()
        self.joys = [pygame.joystick.Joystick(i) for i in range(pygame.joystick.get_count())]
        self.maps = {}
        for j in self.joys:
            m = es_mapping(j)
            # Generic fallback: SDL's usual south/east buttons and the first hat
            self.maps[j.get_instance_id()] = m or {"a": ("button", 0, 1), "b": ("button", 1, 1), "x": ("button", 2, 1), "y": ("button", 3, 1),
                                                   "select": ("button", 6, 1), "start": ("button", 7, 1)}
        self.axis_held = {}

    def actions(self, event):
        if event.type == pygame.KEYDOWN:
            return [self.KEYS[event.key]] if event.key in self.KEYS else []
        if event.type == pygame.TEXTINPUT:
            return [("char", event.text)]
        m = self.maps.get(getattr(event, "instance_id", None), {})
        if event.type == pygame.JOYBUTTONDOWN:
            return [name for name, (kind, ident, _) in m.items() if kind == "button" and ident == event.button]
        if event.type == pygame.JOYHATMOTION:
            x, y = event.value
            return [d for d, ok in (("left", x < 0), ("right", x > 0), ("up", y > 0), ("down", y < 0)) if ok]
        if event.type == pygame.JOYAXISMOTION:
            key = (event.instance_id, event.axis)
            direction = 0 if abs(event.value) < 0.6 else (1 if event.value > 0 else -1)
            if direction == self.axis_held.get(key, 0):
                return []
            self.axis_held[key] = direction
            if direction == 0:
                return []
            named = [n for n, (kind, ident, val) in m.items() if kind == "axis" and ident == event.axis and val == direction]
            if named:
                return named
            return [("down" if direction > 0 else "up") if event.axis % 2 else ("right" if direction > 0 else "left")]
        return []


# ---------- drawing ----------

BG = (18, 20, 28)
FG = (235, 235, 240)
DIM = (140, 145, 160)
ACCENT = (110, 170, 255)
BAD = (255, 120, 120)


class Screen:
    def __init__(self):
        pygame.display.init()
        pygame.font.init()
        flags = 0 if os.environ.get("SDL_VIDEODRIVER") in ("dummy", "offscreen") else pygame.FULLSCREEN
        self.surf = pygame.display.set_mode((640, 480) if flags == 0 else (0, 0), flags)
        pygame.mouse.set_visible(False)
        self.w, self.h = self.surf.get_size()
        scale = self.h / 480
        self.big = pygame.font.Font(None, int(44 * scale))
        self.font = pygame.font.Font(None, int(32 * scale))
        self.small = pygame.font.Font(None, int(24 * scale))
        self.shots = os.environ.get("ROMMANCER_UI_SHOTS")
        self.shot_n = 0
        self.frames = []
        if os.path.exists(SPRITE):
            strip = pygame.image.load(SPRITE).convert_alpha()
            side = strip.get_height()
            target = int(self.h * 0.5)
            cells = [strip.subsurface((i * side, 0, side, side)) for i in range(strip.get_width() // side)]
            # The strip is rendered at the 480p size: other screens get scaled copies
            self.frames = cells if abs(target - side) < 8 else [pygame.transform.smoothscale(c, (target, target)) for c in cells]

    # Two columns: text on the left, the spinning save point on the right
    def left(self):
        return int(self.w * 0.06)

    def column(self):
        return int(self.w * 0.58) if self.frames else self.w - 2 * self.left()

    def sprite(self):
        if not self.frames:
            return
        img = self.frames[int(time.time() * SPRITE_FPS) % len(self.frames)]
        self.surf.blit(img, img.get_rect(center=(int(self.w * 0.8), int(self.h * 0.5))))

    def text(self, s, pos, font=None, color=FG, center=False):
        img = (font or self.font).render(s, True, color)
        r = img.get_rect()
        if center:
            r.midtop = pos
        else:
            r.topleft = pos
        self.surf.blit(img, r)
        return r

    def frame(self, title, footer=""):
        self.surf.fill(BG)
        self.text(title, (self.w // 2, int(self.h * 0.04)), self.big, ACCENT, center=True)
        if footer:
            self.text(footer, (self.w // 2, self.h - int(self.h * 0.07)), self.small, DIM, center=True)

    def wrap(self, s, font, width):
        lines, line = [], ""
        for word in s.split():
            test = (line + " " + word).strip()
            if font.size(test)[0] > width and line:
                lines.append(line)
                line = word
            else:
                line = test
        return lines + ([line] if line else [])

    def flip(self):
        pygame.display.flip()
        if self.shots:
            os.makedirs(self.shots, exist_ok=True)
            pygame.image.save(self.surf, os.path.join(self.shots, f"{self.shot_n:03d}.png"))
            self.shot_n += 1


# ---------- the app ----------

KEYBOARD = [
    "1234567890",
    "qwertyuiop",
    "asdfghjkl@",
    "zxcvbnm.-_",
    ":/?=&+#!*~",
]


class App:
    def __init__(self):
        self.screen = Screen()
        self.pad = Pad()
        self.hints = hints()
        self.state = self.hints.get("state") or os.path.join(HERE, ".rommancer")
        self.cfg = read_config(self.state)
        saved = self.cfg.get("SERVER") or self._read(os.path.join(HERE, "server.txt"))
        self.server = (saved or "https://").strip()
        self.script = [a.strip() for a in os.environ.get("ROMMANCER_UI_TEST", "").split(",") if a.strip()]
        self.clock = pygame.time.Clock()
        # Conflicts are counted in the background so the menu never waits for the network
        self.conflict_count = None
        self.refresh_conflicts()
        pygame.key.set_repeat(300, 60)

    @staticmethod
    def _read(path):
        try:
            with open(path, encoding="utf-8") as f:
                return f.readline().strip()
        except OSError:
            return ""

    # Input: real events, or a scripted list in tests (ROMMANCER_UI_TEST="down,a,...")
    def next_action(self, timeout=None):
        """Next gamepad action; None when TIMEOUT seconds pass without one (to animate)."""
        start = time.time()
        while True:
            if self.script:
                time.sleep(0.05)
                a = self.script.pop(0)
                return ("char", a[5:]) if a.startswith("type:") else a
            if os.environ.get("ROMMANCER_UI_TEST") is not None:
                return "quit"
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return "quit"
                acts = self.pad.actions(event)
                if acts:
                    return acts[0]
            if timeout is not None and time.time() - start >= timeout:
                return None
            time.sleep(0.016)

    def menu(self, title, items, info=(), refresh=None, refresh_index=None):
        """REFRESH (optional) recomputes the label at REFRESH_INDEX on every frame, for values that arrive later."""
        sel = 0
        while True:
            if refresh is not None:
                items[refresh_index] = refresh()
            s = self.screen
            s.frame(title, T["menu_keys"])
            s.sprite()
            x, width = s.left(), s.column()
            y = int(s.h * 0.2)
            for line in info:
                for part in s.wrap(line, s.small, width):
                    s.text(part, (x, y), s.small, DIM)
                    y += s.small.get_linesize()
            y += int(s.h * 0.04)
            for i, label in enumerate(items):
                color = ACCENT if i == sel else FG
                while s.font.size(label)[0] > width and len(label) > 4:
                    label = label[:-2] + "…"
                r = s.text(label, (x + 10, y), s.font, color)
                if i == sel:
                    pygame.draw.rect(s.surf, ACCENT, r.inflate(20, 8), 2, border_radius=8)
                y += int(s.font.get_linesize() * (1.4 if len(items) <= 5 else 1.12 if len(items) <= 7 else 1.0 if len(items) <= 8 else 0.92))
            s.flip()
            a = self.next_action(timeout=0)
            if a is None:
                self.clock.tick(SPRITE_FPS)
                continue
            if a == "up":
                sel = (sel - 1) % len(items)
            elif a == "down":
                sel = (sel + 1) % len(items)
            elif a in ("a", "start"):
                return sel
            elif a in ("b", "quit"):
                return None

    def keyboard(self, title, value="", secret=False):
        row, col, upper = 0, 0, False
        while True:
            s = self.screen
            s.frame(title, T["keys"])
            shown = "*" * len(value) if secret else value
            box = pygame.Rect(30, int(s.h * 0.15), s.w - 60, int(s.font.get_linesize() * 1.4))
            pygame.draw.rect(s.surf, (40, 44, 60), box, border_radius=8)
            txt = shown + "_"
            while s.font.size(txt)[0] > box.w - 20 and len(txt) > 1:
                txt = txt[1:]
            s.text(txt, (box.x + 10, box.y + 6))
            kw, kh = (s.w - 60) // 10, int(s.h * 0.1)
            for r, keys in enumerate(KEYBOARD):
                for c, ch in enumerate(keys):
                    ch = ch.upper() if upper else ch
                    rect = pygame.Rect(30 + c * kw, int(s.h * 0.3) + r * kh, kw - 6, kh - 6)
                    hot = (r, c) == (row, col)
                    pygame.draw.rect(s.surf, ACCENT if hot else (50, 55, 72), rect, border_radius=6)
                    img = s.font.render(ch, True, BG if hot else FG)
                    s.surf.blit(img, img.get_rect(center=rect.center))
            s.flip()
            a = self.next_action()
            if isinstance(a, tuple):
                value += a[1]
            elif a == "up":
                row = (row - 1) % len(KEYBOARD)
            elif a == "down":
                row = (row + 1) % len(KEYBOARD)
            elif a == "left":
                col = (col - 1) % 10
            elif a == "right":
                col = (col + 1) % 10
            elif a == "a":
                ch = KEYBOARD[row][col]
                value += ch.upper() if upper else ch
            elif a == "b":
                value = value[:-1]
            elif a == "x":
                upper = not upper
            elif a == "y":
                value += " "
            elif a == "start":
                return value
            elif a in ("select", "quit"):
                return None

    def message(self, text, color=FG, wait=True):
        s = self.screen
        while True:
            s.frame(T["title"], T["press"] if wait else "")
            s.sprite()
            y = int(s.h * 0.3)
            for line in s.wrap(text, s.font, s.column()):
                s.text(line, (s.left(), y), s.font, color)
                y += s.font.get_linesize()
            s.flip()
            if not wait:
                return
            a = self.next_action(timeout=0)
            if a in ("a", "b", "start", "quit"):
                return
            if a is None:
                self.clock.tick(SPRITE_FPS)

    # ---------- flows ----------

    def linked(self):
        return bool(self.cfg.get("TOKEN"))

    def device_form(self):
        h = self.hints
        return {"name": h.get("name", "console"), "firmware": h.get("firmware", ""), "root": h.get("root", ""), "model": h.get("model", "")}

    def check_server(self):
        if not self.server or self.server == "https://":
            self.message(T["no_server"], BAD)
            return None
        self.message(T["checking"], wait=False)
        try:
            return call(self.server, "/link/info")
        except (ApiError, OSError, ValueError):
            self.message(T["bad_server"], BAD)
            return None

    def finish_link(self, resp):
        write_config(self.state, self.server.rstrip("/"), resp["token"], resp.get("user", ""))
        self.cfg = read_config(self.state)
        testing = os.environ.get("ROMMANCER_UI_TEST") is not None
        if not testing:
            subprocess.run(["sh", SCRIPT, "install"], capture_output=True, timeout=60)
        self.sync_now()
        if not testing:
            subprocess.Popen(["sh", SCRIPT, "daemon"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.message(T["done"])

    def api_error(self, e):
        if e.status == 401:
            return T["bad_login"]
        if e.status == 403 and "Sign-up" in str(e):
            return T["signup_closed"]
        if e.status == 409:
            return T["exists"]
        return T["error"].format(msg=e)

    def login(self):
        if not self.check_server():
            return
        user = self.keyboard(T["user"])
        if not user:
            return
        password = self.keyboard(T["password"], secret=True)
        if password is None:
            return
        self.message(T["checking"], wait=False)
        try:
            self.finish_link(call(self.server, "/link/login", {**self.device_form(), "username": user, "password": password}))
        except ApiError as e:
            self.message(self.api_error(e), BAD)
        except OSError as e:
            self.message(T["error"].format(msg=e), BAD)

    def signup(self):
        info = self.check_server()
        if not info:
            return
        if info.get("signup") != "1":
            self.message(T["signup_closed"], BAD)
            return
        user = self.keyboard(T["username"])
        email = user and self.keyboard(T["email"])
        password = email and self.keyboard(T["password"], secret=True)
        if not password:
            return
        self.message(T["checking"], wait=False)
        try:
            self.finish_link(call(self.server, "/link/signup", {**self.device_form(), "username": user, "email": email, "password": password}))
        except ApiError as e:
            self.message(self.api_error(e), BAD)
        except OSError as e:
            self.message(T["error"].format(msg=e), BAD)

    def progress_file(self):
        return os.path.join(os.environ.get("TMPDIR", "/tmp"), f"rommancer-{os.getuid()}", "progress")

    def sync_now(self):
        self.run_with_progress("all", T["syncing"])

    def sync_roms(self):
        self.run_with_progress("roms", T["sync_roms"])

    def run_with_progress(self, command, title, *args):
        """Runs a client command in the background, showing its phase and percentage while it works."""
        try:
            os.remove(self.progress_file())
        except OSError:
            pass
        proc = subprocess.Popen(["sh", SCRIPT, command, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        s = self.screen
        while proc.poll() is None:
            phase, done, total, parts = "connecting", 0, 0, []
            try:
                with open(self.progress_file(), encoding="utf-8") as f:
                    parts = f.read().strip().split("\t")
                phase, done, total = parts[0], int(parts[1]), int(parts[2])
            except (OSError, ValueError, IndexError):
                pass
            detail, share = "", (done / total if total else 0)
            if phase == "roms-download" and len(parts) >= 6 and total:
                # Finished roms plus what the current file has written so far
                size = int(parts[3] or 0)
                cur = os.path.getsize(parts[4]) if os.path.exists(parts[4]) else 0
                file_share = min(cur / size, 1) if size else 0
                share = ((done - 1) + file_share) / total
                detail = f"{parts[5][:42]}  {int(file_share * 100)}%"
            s.frame(T["title"])
            s.sprite()
            x, width, y = s.left(), s.column(), int(s.h * 0.3)
            s.text(title, (x, y), s.font)
            label = T.get(f"p_{phase}", "")
            if total:
                label += f"  {done}/{total}"
            s.text(label, (x, y + s.font.get_linesize() * 1.5), s.small, DIM)
            bar = pygame.Rect(x, y + int(s.font.get_linesize() * 2.6), width - 20, 14)
            pygame.draw.rect(s.surf, (40, 44, 60), bar, border_radius=7)
            if total:
                fill = bar.copy()
                fill.w = max(14, int(bar.w * min(share, 1)))
                pygame.draw.rect(s.surf, ACCENT, fill, border_radius=7)
                s.text(f"{int(100 * share)}%", (bar.right - 50, bar.bottom + 6), s.small, DIM)
            if detail:
                s.text(detail, (x, bar.bottom + 6), s.small, DIM)
            s.flip()
            for _ in pygame.event.get():
                pass
            self.clock.tick(SPRITE_FPS)
        out = (proc.stdout.read() if proc.stdout else "").strip()
        self.message(" · ".join(out.splitlines()[-2:]) if out else T["error"].format(msg="sync"))

    def settings(self):
        cfg = {}
        try:
            with open(os.path.join(self.state, "settings"), encoding="utf-8") as f:
                cfg = dict(line.rstrip("\n").split("=", 1) for line in f if "=" in line)
        except OSError:
            pass
        return cfg

    def toggle(self, key):
        on = self.settings().get(key, "1") == "1"
        subprocess.run(["sh", SCRIPT, "set", key, "0" if on else "1"], capture_output=True, timeout=30)

    def toggle_auto_roms(self):
        self.toggle("AUTO_ROMS")

    def toggle_allow_pull(self):
        self.toggle("ALLOW_PULL")

    def toggle_allow_ssh(self):
        self.toggle("ALLOW_SSH")

    def conflicts(self):
        try:
            out = subprocess.run(["sh", SCRIPT, "conflicts"], capture_output=True, text=True, timeout=15, env={**os.environ, "HTTP_MAX": "5"}).stdout
        except subprocess.TimeoutExpired:
            return []
        return [line.split("\t") for line in out.splitlines() if line.startswith("conflict\t")]

    def refresh_conflicts(self):
        if not self.linked():
            return

        def work():
            self.conflict_count = len(self.conflicts())

        threading.Thread(target=work, daemon=True).start()

    def resolve_conflicts(self):
        while True:
            rows = self.conflicts()
            if not rows:
                self.message(T["no_conflicts"])
                return
            pick = self.menu(T["conflicts"].format(n=len(rows)), [r[2][:40] for r in rows])
            if pick is None:
                return
            c = rows[pick]
            info = T["conflict_info"].format(game=c[2], mine=c[4][:16].replace("T", " "), theirs=c[5][:16].replace("T", " "), dev=c[6])
            choice = self.menu(T["conflicts"].format(n=len(rows)), [T["keep_device"], T["keep_server"]], info=[info])
            if choice is not None:
                self.run_with_progress("resolve", T["syncing"], c[1], "device" if choice == 0 else "server")

    def status(self):
        try:
            with open(os.path.join(self.state, "log"), encoding="utf-8") as f:
                lines = f.read().splitlines()[-6:]
        except OSError:
            lines = [T["nolog"]]
        self.menu(T["status"], ["OK"], info=[self.version_line()] + lines)

    def version_line(self):
        """The client's version and when this console first synced with it"""
        try:
            with open(os.path.join(HERE, "rommancer-sync.sh"), encoding="utf-8") as f:
                v = next((l.split("=", 1)[1].strip() for l in f if l.startswith("CLIENT_VERSION=")), "?")
        except OSError:
            v = "?"
        line = T["version"].format(v=v)
        try:
            with open(os.path.join(self.state, "version"), encoding="utf-8") as f:
                mark = f.read().strip().split("\t")
            if len(mark) == 2 and mark[0] == v:
                line += ", " + T["installed"].format(d=mark[1])
        except OSError:
            pass
        return line

    def logout(self):
        subprocess.run(["sh", SCRIPT, "unlink"], capture_output=True, timeout=30)
        self.cfg = {}
        self.message(T["logged_out"])

    def run(self):
        while True:
            if self.linked():
                info = [T["connected"].format(server=self.cfg.get("SERVER", "")), T["as"].format(user=self.cfg.get("USER", "?"))]
                cfg = self.settings()
                auto = T["yes"] if cfg.get("AUTO_ROMS", "1") == "1" else T["no"]
                pull = T["yes"] if cfg.get("ALLOW_PULL", "1") == "1" else T["no"]
                ssh = T["yes"] if cfg.get("ALLOW_SSH", "1") == "1" else T["no"]
                n = "…" if self.conflict_count is None else self.conflict_count
                items = [T["sync_now"], T["sync_roms"], T["auto_roms"].format(v=auto), T["allow_pull"].format(v=pull), T["allow_ssh"].format(v=ssh), T["conflicts"].format(n=n), T["status"], T["logout"], T["quit"]]
                choice = self.menu(T["title"], items, info, refresh=lambda: T["conflicts"].format(n="…" if self.conflict_count is None else self.conflict_count), refresh_index=5)
                actions = [self.sync_now, self.sync_roms, self.toggle_auto_roms, self.toggle_allow_pull, self.toggle_allow_ssh, self.resolve_conflicts, self.status, self.logout]
            else:
                choice = self.menu(T["title"], [f"{T['server']}: {self.server}", T["login"], T["signup"], T["quit"]])
                actions = [self.edit_server, self.login, self.signup]
            if choice is None or choice >= len(actions):
                return
            actions[choice]()
            self.refresh_conflicts()

    def edit_server(self):
        value = self.keyboard(T["server"], self.server)
        if value:
            self.server = value.strip()


def main():
    try:
        App().run()
    finally:
        pygame.quit()


if __name__ == "__main__":
    sys.exit(main())
