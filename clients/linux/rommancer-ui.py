#!/usr/bin/env python3
"""Rommancer Sync setup screen for handhelds with Python + pygame (Knulli, Batocera, ROCKNIX).

Everything is done with the gamepad: server address, log in or create an account, sync now,
status and sign out. Syncing itself is done by rommancer-sync.sh next to this file.
"""
import functools
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

# Every text on screen, with the vocabulary of docs/clients-ux.md (save, savestate, game). Keys ending in "1" are the singular of the key without it (one save, one game); the summary's arrows
# and warning sign are drawn (the default font has no glyph for them)
TEXTS = {
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
        "sync_now": "Sync now",
        "status": "Status",
        "settings": "Settings",
        "logout": "Disconnect this console…",
        "logout_title": "Disconnect this console",
        "logout_ask": "Disconnect this console from {host}? Its saves stay on it, but it stops syncing.",
        "logout_go": "Disconnect",
        "account": "Account: {user} @ {host}",
        "syncing": "Syncing...",
        "checking": "Contacting the server...",
        "no_server": "Enter the server address first",
        "bad_server": "No Rommancer at that address",
        "bad_login": "Wrong username or password",
        "signup_closed": "This server does not allow new accounts",
        "exists": "That username or email already exists",
        "error": "Error: {msg}",
        "done": "Done. Automatic sync is on.",
        "logged_out": "Console disconnected",
        "keys": "A key  B delete  X shift  Y space  START accept  SELECT cancel",
        "menu_keys": "A choose   B back",
        "press": "Press A to continue",
        "nolog": "No log yet",
        "version": "Version {v}",
        "synced": "Synced: {d}",
        "today": "today",
        "never_synced": "Not synced yet",
        "offline_since": "Offline since {t}",
        "conflicts_line": "{n} saves in conflict",
        "conflicts_line1": "1 save in conflict",
        "months": "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",
        "installed": "installed {d}",
        "step": "Step {n} of {m} · {title}",
        "st_saves": "Saves",
        "st_settings": "Settings",
        "st_prune": "Games in no list",
        "st_roms": "List games",
        "st_pulls": "Sending to the server",
        "p_connecting": "Contacting the server",
        "p_waiting": "Waiting for the sync under way",
        "p_roms": "Checking games",
        "p_saves": "Checking saves",
        "p_hashing": "Reading new or changed files",
        "p_server": "Asking the server",
        "p_identify": "Identifying games by their header",
        "p_transfer": "Passing saves",
        "p_finished": "Saves up to date",
        "p_settings": "Applying the server's settings",
        "p_prune": "Deleting games in no list",
        "p_roms-plan": "Asking which games belong here",
        "p_roms-download": "Downloading games",
        "p_roms-finished": "Games up to date",
        "p_pulls": "Sending games to the server",
        "p_working": "Working...",
        "of": "{pct}% of {size}",
        "allow_pull": "The server may request games: {v}",
        "allow_pull_note": "It copies the games it lacks from this console.",
        "allow_ssh": "Server SSH access: {v}",
        "allow_ssh_note": "It syncs this console even while the app is closed.",
        "prune": "Delete games in no list: {v}",
        "prune_note": "Deletes the games that are in none of the lists.",
        "prune_clean": "Delete saves of deleted games ({n})",
        "prune_clean_note": "Removes their saves; they stay on the server.",
        "yes": "yes",
        "no": "no",
        "conflicts": "Conflicts ({n})",
        "no_conflicts": "No conflicts",
        "conflict_info": "{game}: this console saved on {mine}; the server has a version from {theirs} ({dev}).",
        "keep_device": "Keep this console's save",
        "keep_server": "Use the server's save",
        "prune_intro": "Rommancer can delete from this console the games that are in none of its lists. The ones the server lacks are sent to it before they are deleted. Saves stay. You can change it later in Settings or on the web. Turn it on?",
        "prune_ask": "Deleting games in no list was turned on from the server. If you keep it, {n} games ({size}) will be deleted. Do you want to keep this option?",
        "prune_hold": "{n} of the {total} games on this console (more than half) would be deleted for being in no list. A list may have been emptied. Delete them?",
        "prune_yes": "Yes, turn it on",
        "prune_no": "No, leave it off",
        "prune_keep": "Yes, keep it",
        "prune_off": "No, turn it off",
        "prune_delete": "Yes, delete them",
        "prune_later": "Not now",
        "roms_watch": "Watch game download",
        "pulls_watch": "Watch games being sent to the server",
        "w_roms": "Downloading games {n}",
        "w_pulls": "Sending games to the server {n}",
        "details": "Show details",
        "back_keys": "B back to the menu (sending goes on)",
        "stop_keys": "B to stop",
        "stopping": "Stopping the download...",
        "lists": "Game lists",
        "lists_info": "{n} lists on this console. A adds or removes one; on leaving, their games download or go.",
        "roms_now": "Download the lists' games now",
        "no_lists": "No lists yet. Create them in Rommancer's web app.",
        "lists_fail": "Could not reach the server",
        "back": "Back",
        "list_drop": "Removing “{name}” deletes {n} games from this console ({size}).",
        "list_drop_up": "{n} the server lacks are sent to it first.",
        "list_drop_go": "Remove and delete {n} games",
        "cancel": "Cancel",
        "up_to_date": "All up to date",
        "last_result": "Last result:",
        "log": "Log:",
        "f_saves-up": "{n} saves uploaded to the server",
        "f_saves-up1": "1 save uploaded to the server",
        "f_saves-down": "{n} saves received",
        "f_saves-down1": "1 save received",
        "f_states-up": "{n} savestates uploaded to the server",
        "f_states-up1": "1 savestate uploaded to the server",
        "f_states-down": "{n} savestates received",
        "f_states-down1": "1 savestate received",
        "f_games-down": "{n} games downloaded",
        "f_games-down1": "1 game downloaded",
        "f_games-sent": "{n} games sent to the server",
        "f_games-sent1": "1 game sent to the server",
        "f_games-deleted": "{n} games deleted (in no list)",
        "f_games-deleted1": "1 game deleted (in no list)",
        "f_saves-cleaned": "{n} saves of deleted games removed",
        "f_saves-cleaned1": "1 save of deleted games removed",
        "f_games-stopped": "Game download stopped",
        "f_games-nospace": "No room for “{x}”: not enough space",
        "f_conflicts": "{n} saves in conflict",
        "f_conflicts1": "1 save in conflict",
        "f_errors": "{n} errors",
        "f_errors1": "1 error",
    },
}

T = TEXTS["en"]

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
WARN = (255, 190, 90)


def human(n):
    """A byte count for people: 1.2 GB"""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            s = f"{n:.1f} {unit}" if unit not in ("B", "KB") else f"{int(n)} {unit}"
            return s
        n /= 1024


def work_dir():
    """The client's folder in RAM (progress, last sync, failure details), as rommancer-sync.sh names it"""
    return os.path.join(os.environ.get("TMPDIR") or "/tmp", f"rommancer-{os.getuid()}")


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


@functools.lru_cache(maxsize=1)
def client_version():
    """CLIENT_VERSION of the sync script beside this app (read once: every frame shows it)"""
    try:
        with open(os.path.join(HERE, "rommancer-sync.sh"), encoding="utf-8") as f:
            return next((l.split("=", 1)[1].strip() for l in f if l.startswith("CLIENT_VERSION=")), "?")
    except OSError:
        return "?"


# The client's state folder, where it notes its version and when it arrived (by the server's clock)
STATE_DIR = None


_synced = [0.0, ""]


def synced_at():
    """When the last sync went through, as: Sincronizado: hoy, 18:52 (the client keeps it in RAM, and on the card
    every ten minutes); read again every two seconds, not every frame"""
    if time.time() - _synced[0] < 2:
        return _synced[1]
    _synced[:] = [time.time(), _synced_text()]
    return _synced[1]


def _synced_text():
    for path in (os.path.join(work_dir(), "last-sync"), os.path.join(STATE_DIR or "", "last-sync")):
        try:
            t = time.localtime(int(read_text(path).strip()))
        except ValueError:
            continue
        if time.strftime("%Y%m%d", t) == time.strftime("%Y%m%d"):
            day = T["today"]
        else:
            day = f"{t.tm_mday} {T['months'].split()[t.tm_mon - 1]}"
        return T["synced"].format(d=f"{day}, {t.tm_hour:02d}:{t.tm_min:02d}")
    return T["never_synced"]


# ---------- the summary of an action: the client's "sum<TAB>key<TAB>n[<TAB>extra]" lines (docs/clients-ux.md) ----------

SUM_ORDER = ["saves-up", "saves-down", "states-up", "states-down", "games-down", "games-sent", "games-deleted",
             "saves-cleaned", "games-stopped", "games-nospace", "conflicts", "errors"]
SUM_ICONS = {"saves-up": "up", "states-up": "up", "games-sent": "up", "saves-down": "down", "states-down": "down",
             "games-down": "down", "conflicts": "warn", "errors": "warn", "games-nospace": "warn"}


def summary_facts(lines):
    """One (icon, text, colour) per fact that is not zero, in the guide's order; the same keys added up (conflicts:
    the last count; a game with no room: each one)"""
    vals, conflicts, nospace, stopped = {}, 0, [], False
    for line in lines:
        p = line.rstrip("\n").split("\t")
        if len(p) < 3 or p[0] != "sum" or not p[2].isdigit():
            continue
        if p[1] == "conflicts":
            conflicts = int(p[2])
        elif p[1] == "games-nospace":
            nospace.append(p[3] if len(p) > 3 else "?")
        elif p[1] == "games-stopped":
            stopped = True
        else:
            vals[p[1]] = vals.get(p[1], 0) + int(p[2])
    vals.update({"conflicts": conflicts, "games-stopped": int(stopped)})
    facts = []
    for k in SUM_ORDER:
        color = WARN if SUM_ICONS.get(k) == "warn" else FG
        if k == "games-nospace":
            facts += [("warn", T["f_games-nospace"].format(x=x), color) for x in nospace]
        elif vals.get(k):
            n = vals[k]
            text = T[f"f_{k}1"] if n == 1 and f"f_{k}1" in T else T[f"f_{k}"].format(n=n)
            facts.append((SUM_ICONS.get(k), text, color))
    return facts


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

    def column(self, wide=False):
        """The text's width: beside the save point, or the whole screen (WIDE: no save point)"""
        return int(self.w * 0.58) if self.frames and not wide else self.w - 2 * self.left()

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

    def frame(self, title, footer="", sub=None):
        """Title (with the client's version next to the app's name), a line under it (SUB: text and colour; when
        the last sync went through otherwise) and the footer's button hints"""
        self.surf.fill(BG)
        r = self.text(title, (self.w // 2, int(self.h * 0.04)), self.big, ACCENT, center=True)
        if title == T["title"]:
            v = self.small.render(client_version(), True, DIM)
            self.surf.blit(v, (r.right + int(self.w * 0.012), r.bottom - v.get_height() - 2))
        text, color = sub or (synced_at(), DIM)
        self.text(text, (self.w // 2, r.bottom), self.small, color, center=True)
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

    def clip(self, s, font, width):
        """S cut with an ellipsis to fit WIDTH"""
        if font.size(s)[0] <= width:
            return s
        while len(s) > 1 and font.size(s + "…")[0] > width:
            s = s[:-1]
        return s + "…"

    def icon(self, kind, x, y, size, color):
        """The summary's marks, drawn (the default font has no arrows): up, down, a warning triangle"""
        if kind == "up":
            pygame.draw.polygon(self.surf, ACCENT, [(x + size // 2, y), (x, y + size), (x + size, y + size)])
        elif kind == "down":
            pygame.draw.polygon(self.surf, ACCENT, [(x, y), (x + size, y), (x + size // 2, y + size)])
        elif kind == "warn":
            pygame.draw.polygon(self.surf, color, [(x + size // 2, y), (x, y + size), (x + size, y + size)])
            pygame.draw.line(self.surf, BG, (x + size // 2, y + size // 3), (x + size // 2, y + size * 2 // 3), 2)
            pygame.draw.rect(self.surf, BG, (x + size // 2 - 1, y + size * 3 // 4, 2, 2))

    def lines(self, entries, x, y, width, font=None):
        """Lines from Y down: plain texts (dim) or facts (icon, text, colour), each wrapped to WIDTH; the Y after them"""
        font = font or self.small
        size = int(font.get_height() * 0.55)
        for e in entries:
            icon, text, color = e if isinstance(e, tuple) else (None, e, DIM)
            indent = size + int(size * 0.7) if icon else 0
            for i, part in enumerate(self.wrap(text, font, width - indent)):
                if i == 0 and icon:
                    self.icon(icon, x, y + (font.get_height() - size) // 2, size, color)
                self.text(part, (x + indent, y), font, color)
                y += font.get_linesize()
        return y

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
        global STATE_DIR
        STATE_DIR = self.state
        self.cfg = read_config(self.state)
        saved = self.cfg.get("SERVER") or self._read(os.path.join(HERE, "server.txt"))
        self.server = (saved or "https://").strip()
        self.script = [a.strip() for a in os.environ.get("ROMMANCER_UI_TEST", "").split(",") if a.strip()]
        self.clock = pygame.time.Clock()
        # Conflicts are counted in the background so the menu never waits for the network
        self.conflict_count = None
        self.cleanable = "0"
        self.refresh_conflicts()
        # Work under way (a game download, games sent to the server), read in the background while the home
        # screen shows
        self.live, self.live_on = {}, False
        threading.Thread(target=self.poll_live, daemon=True).start()
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

    def menu(self, title, items, info=(), start=0, notes=None, sub=None, wide=False, big_info=False):
        """ITEMS: labels, or a function giving them (called again every second, for what arrives later or changes:
        the conflicts, a download under way); the selection stays on its label. INFO: lines above them, texts or
        facts (icon, text, colour), or a function giving them. NOTES: per item, a line under the selected one saying
        what it does. SUB: the line under the title (text, colour), or a function giving it. START is the item
        selected at first; items that do not fit scroll with the selection. WIDE: the whole width, without the save
        point (long labels); BIG_INFO: the info in the items' size (a summary)."""
        def get():
            return (items() if callable(items) else items, info() if callable(info) else info, sub() if callable(sub) else sub)

        labels, lines, head = get()
        fetched = time.time()
        sel = min(max(start, 0), len(labels) - 1)
        first = 0
        while True:
            if (callable(items) or callable(info) or callable(sub)) and time.time() - fetched >= 1:
                was = labels[sel]
                labels, lines, head = get()
                fetched = time.time()
                sel = labels.index(was) if was in labels else min(sel, len(labels) - 1)
            s = self.screen
            s.frame(title, T["menu_keys"], head)
            if not wide:
                s.sprite()
            x, width = s.left(), s.column(wide)
            y = s.lines(lines, x, int(s.h * 0.2), width, s.font if big_info else s.small)
            y += int(s.h * 0.04)
            n = len(labels)
            step = int(s.font.get_linesize() * (1.4 if n <= 5 else 1.12 if n <= 7 else 1.0 if n <= 8 else 0.92))
            note = notes[sel] if notes and sel < len(notes) else ""
            note_h = s.small.get_linesize() if note else 0
            # As many as fit above the footer; the window follows the selection
            fit = max(1, (int(s.h * 0.9) - y - note_h) // step)
            first = min(max(first, sel - fit + 1), sel)
            # Small triangles say there is more above or below (the default font may lack arrow glyphs)
            tri = max(4, step // 6)
            top_y = y
            if first:
                pygame.draw.polygon(s.surf, DIM, [(x - 8, top_y + tri), (x - 8 - tri, top_y + 3 * tri), (x - 8 + tri, top_y + 3 * tri)])
            for i in range(first, min(n, first + fit)):
                color = ACCENT if i == sel else FG
                r = s.text(s.clip(labels[i], s.font, width), (x + 10, y), s.font, color)
                if i == sel:
                    pygame.draw.rect(s.surf, ACCENT, r.inflate(20, 8), 2, border_radius=8)
                y += step
                if i == sel and note:
                    # Under the selection's frame, the next item pushed down
                    s.text(s.clip(note, s.small, width - 10), (x + 10, r.bottom + 6), s.small, DIM)
                    y = max(y, r.bottom + 6 + note_h + (step - s.font.get_height()) // 2)
            if first + fit < n:
                b = y - step - (note_h if sel == first + fit - 1 else 0)
                pygame.draw.polygon(s.surf, DIM, [(x - 8 - tri, b + tri), (x - 8 + tri, b + tri), (x - 8, b + 3 * tri)])
            s.flip()
            a = self.next_action(timeout=0)
            if a is None:
                self.clock.tick(SPRITE_FPS)
                continue
            if a == "up":
                sel = (sel - 1) % n
            elif a == "down":
                sel = (sel + 1) % n
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

    def message(self, text, color=FG, wait=True, title=None, lines=None):
        """TEXT on its own screen (or LINES: texts and facts, one per line), until A or B when WAIT"""
        s = self.screen
        while True:
            s.frame(title or T["title"], T["press"] if wait else "")
            s.sprite()
            if lines is not None:
                s.lines(lines, s.left(), int(s.h * 0.24), s.column(), s.font)
            else:
                s.lines([(None, text, color)], s.left(), int(s.h * 0.3), s.column(), s.font)
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

    def host(self):
        server = self.cfg.get("SERVER", "")
        return urllib.parse.urlparse(server).netloc or server

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
        return os.path.join(work_dir(), "progress")

    def details_file(self):
        return os.path.join(work_dir(), "fail-details")

    def sync_now(self):
        self.run_with_progress("all", T["sync_now"])

    def sync_roms(self):
        self.run_with_progress("roms", T["st_roms"])

    def progress_lines(self, parts):
        """What a "progress" line says: (what it does now with its count, share of the whole or None, the current
        file, that file's percent and size)"""
        phase = parts[0] if parts and parts[0] else "connecting"
        try:
            done, total = int(parts[1]), int(parts[2])
        except (IndexError, ValueError):
            done, total = 0, 0
        if phase.endswith("finished"):
            total = 0
        label = T.get(f"p_{phase}", T["p_working"])
        if not total:
            return label, None, "", ""
        label += f"  {done}/{total}"
        share, name, extra = done / total, parts[5] if len(parts) >= 6 else "", ""
        size = int(parts[3]) if len(parts) >= 4 and parts[3].isdigit() else 0
        if phase == "roms-download":
            # Finished games plus what the current file has written so far
            cur = os.path.getsize(parts[4]) if len(parts) >= 5 and os.path.exists(parts[4]) else 0
            file_share = min(cur / size, 1) if size else 0
            share = ((done - 1) + file_share) / total
            extra = T["of"].format(pct=int(file_share * 100), size=human(size)) if size else human(cur)
        elif phase == "pulls":
            # The file's share: the last figure of curl's progress bar
            figures = re.findall(r"([0-9]+)(?:\.[0-9]+)?%", read_text(os.path.join(work_dir(), "pull-curl")).replace("\r", "\n"))
            file_share = int(figures[-1]) / 100 if figures else 0
            share = ((done - 1) + file_share) / total
            extra = T["of"].format(pct=int(file_share * 100), size=human(size))
        return label, max(0.0, min(share, 1.0)), name, extra

    def draw_progress(self, title, step, parts, footer):
        """A progress screen: the step of "Sync now", what it does now with its count, the bar with its percent, the
        current file on its own line with its percent and size; the button's hint in the footer"""
        s = self.screen
        label, share, name, extra = self.progress_lines(parts)
        s.frame(title, footer)
        s.sprite()
        x, width, y = s.left(), s.column(), int(s.h * 0.26)
        if step:
            s.text(s.clip(step, s.font, width), (x, y), s.font)
            y += int(s.font.get_linesize() * 1.4)
        s.text(s.clip(label, s.small, width), (x, y), s.small, DIM)
        y += int(s.small.get_linesize() * 1.3)
        pct_w = s.small.size("100%")[0] + 10
        bar = pygame.Rect(x, y + 2, width - pct_w, 14)
        pygame.draw.rect(s.surf, (40, 44, 60), bar, border_radius=7)
        if share is not None:
            fill = bar.copy()
            fill.w = max(14, int(bar.w * share))
            pygame.draw.rect(s.surf, ACCENT, fill, border_radius=7)
            s.text(f"{int(100 * share)}%", (bar.right + 10, y), s.small, DIM)
        else:
            # No total yet: a stretch of the bar sweeps back and forth, so it never looks stuck
            seg = bar.copy()
            seg.w = bar.w // 4
            t = (pygame.time.get_ticks() / 1400) % 2
            seg.x = bar.x + int((bar.w - seg.w) * (t if t < 1 else 2 - t))
            pygame.draw.rect(s.surf, ACCENT, seg, border_radius=7)
        y = bar.bottom + int(s.small.get_linesize() * 0.9)
        if name:
            s.text(s.clip(name, s.small, width), (x, y), s.small, FG)
            y += s.small.get_linesize()
        if extra:
            s.text(extra, (x, y), s.small, DIM)
        s.flip()

    def run_with_progress(self, command, title, *args):
        """Runs a client command in the background with its progress on screen, then its summary. TITLE is the
        action's name, the title of both."""
        # A download under way keeps its progress on screen from the start
        if not self.roms_status():
            for f in (self.progress_file(), os.path.join(work_dir(), "step")):
                try:
                    os.remove(f)
                except OSError:
                    pass
        try:
            os.remove(self.details_file())
        except OSError:
            pass
        proc = subprocess.Popen(["sh", SCRIPT, command, *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        stopping = False
        while proc.poll() is None:
            parts = read_text(self.progress_file()).strip().split("\t")
            phase = parts[0]
            st = read_text(os.path.join(work_dir(), "step")).strip().split("\t")
            step = T["step"].format(n=st[0], m=st[1], title=T.get(f"st_{st[2]}", st[2])) if len(st) == 3 else ""
            # Games downloading: B stops them (the transfer under way is cut); games sent to the server: B leaves
            # them going on behind the menu
            downloading = phase in ("roms-plan", "roms-download")
            footer = T["stopping"] if stopping else T["stop_keys"] if downloading else T["back_keys"] if phase == "pulls" else ""
            self.draw_progress(title, step, parts, footer)
            for event in pygame.event.get():
                if "b" not in self.pad.actions(event):
                    continue
                if downloading and not stopping:
                    stopping = True
                    subprocess.Popen(["sh", SCRIPT, "roms-stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                elif phase == "pulls":
                    threading.Thread(target=proc.communicate, daemon=True).start()
                    return
            self.clock.tick(SPRITE_FPS)
        self.show_summary(title, proc.stdout.read() if proc.stdout else "")

    def show_summary(self, title, out):
        """The result of an action: one fact per line (only what is not zero), "All up to date" when nothing; a
        failure says why, with its details behind a button. Kept for the Status screen"""
        lines = out.splitlines()
        details = read_text(self.details_file()).strip().splitlines()
        try:
            with open(os.path.join(work_dir(), "last-summary"), "w", encoding="utf-8") as f:
                f.write("".join(l + "\n" for l in lines if l.startswith("sum\t")) + (f"fail\t{details[0]}\n" if details else ""))
        except OSError:
            pass
        facts = summary_facts(lines)
        if details:
            if self.menu(title, ["OK", T["details"]], info=facts + [(None, details[0], BAD)], big_info=len(facts) < 5) == 1:
                self.menu(T["details"], ["OK"], info=details[1:], wide=True)
            return
        self.message(None, title=title, lines=facts or [(None, T["up_to_date"], FG)])

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

    # ---------- deleting games that are in no list ----------

    def prune_state(self):
        """on, ask (files, bytes), hold (files, roms), intro (the choice was offered) and cleanable, from the client"""
        try:
            out = subprocess.run(["sh", SCRIPT, "prune"], capture_output=True, text=True, timeout=15).stdout
        except subprocess.TimeoutExpired:
            return {}
        return {p[0]: p[1:] for p in (line.split("\t") for line in out.splitlines()) if p}

    def prune_set(self, on):
        self.message(T["syncing"], wait=False)
        subprocess.run(["sh", SCRIPT, "prune", "set", "1" if on else "0"], capture_output=True, timeout=900)

    def prune_prompts(self):
        """What needs the user: the choice offered once, a change made in the web app, a held deletion"""
        st = self.prune_state()
        if st.get("intro") == ["0"]:
            pick = self.menu(T["title"], [T["prune_no"], T["prune_yes"]], info=[T["prune_intro"]])
            self.prune_set(pick == 1)
            st = self.prune_state()
        if "ask" in st:
            n, size = (st["ask"] + ["0", "0"])[:2]
            pick = self.menu(T["title"], [T["prune_keep"], T["prune_off"]], info=[T["prune_ask"].format(n=n, size=human(int(size or 0)))])
            if pick is not None:
                self.prune_set(pick == 0)
            st = self.prune_state()
        if "hold" in st and st.get("on") == ["1"]:
            n, total = (st["hold"] + ["0", "0"])[:2]
            pick = self.menu(T["title"], [T["prune_delete"], T["prune_off"], T["prune_later"]], info=[T["prune_hold"].format(n=n, total=total)])
            if pick == 0:
                self.run_with_progress("prune", T["p_prune"], "confirm")
            elif pick == 1:
                self.prune_set(False)

    def roms_status(self):
        """(done, total) of a game download under way (the daemon's), None when there is none"""
        try:
            out = subprocess.run(["sh", SCRIPT, "roms-status"], capture_output=True, text=True, timeout=10).stdout
        except subprocess.TimeoutExpired:
            return None
        if not out:
            return None
        parts = out.rstrip("\n").split("\t") + ["", ""]
        return parts[0], parts[1]

    def pulls_status(self):
        """(done, total, name, file share) of the copy the server asked for, None when there is none"""
        try:
            out = subprocess.run(["sh", SCRIPT, "pulls-status"], capture_output=True, text=True, timeout=10).stdout
        except subprocess.TimeoutExpired:
            return None
        parts = out.rstrip("\n").split("\t")
        if len(parts) < 4:
            return None
        try:
            return int(parts[0]), int(parts[1]), parts[2], float(parts[3] or 0) / 100
        except ValueError:
            return None

    def poll_live(self):
        while True:
            if self.live_on and self.linked():
                self.live = {"roms": self.roms_status(), "pulls": self.pulls_status()}
            time.sleep(2)

    def watch_pulls(self):
        """The copy the server asked for, on screen until it ends; B goes back to the menu and the copy goes on"""
        st = self.pulls_status()
        checked = pygame.time.get_ticks()
        while st:
            done, total, name, _ = st
            size = read_text(os.path.join(work_dir(), "pull-progress")).split("\t")
            self.draw_progress(T["st_pulls"], "", ["pulls", str(done), str(total), size[2] if len(size) > 2 else "0", "", name], T["back_keys"])
            for event in pygame.event.get():
                if "b" in self.pad.actions(event):
                    return
            self.clock.tick(SPRITE_FPS)
            if pygame.time.get_ticks() - checked > 1000:
                st, checked = self.pulls_status(), pygame.time.get_ticks()

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
            title = T["conflicts"].format(n=len(rows))
            pick = self.menu(title, [r[2][:40] for r in rows])
            if pick is None:
                return
            c = rows[pick]
            info = T["conflict_info"].format(game=c[2], mine=c[4][:16].replace("T", " "), theirs=c[5][:16].replace("T", " "), dev=c[6])
            choice = self.menu(title, [T["keep_device"], T["keep_server"]], info=[info])
            if choice is not None:
                self.run_with_progress("resolve", title, c[1], "device" if choice == 0 else "server")

    # ---------- the console's lists ----------

    def client(self, *args, timeout=30):
        """A client command's output lines split by tabs, None when it failed"""
        try:
            r = subprocess.run(["sh", SCRIPT, *args], capture_output=True, text=True, timeout=timeout, env={**os.environ, "HTTP_MAX": str(timeout - 5)})
        except subprocess.TimeoutExpired:
            return None
        return [line.split("\t") for line in r.stdout.splitlines()] if r.returncode == 0 else None

    def lists(self):
        """Each list ticked or not; A adds or removes one (a removal that deletes games says how many first, a single
        question). Leaving after a change brings the console in line with its lists at once, on screen. The last
        item but one downloads the lists' games now."""
        changed, at = False, None
        while True:
            self.message(T["checking"], wait=False)
            out = self.client("lists")
            if out is None:
                self.message(T["lists_fail"])
                break
            prune = ["prune", "1"] in out
            rows = [r for r in out if r[0] == "list" and len(r) >= 5]
            if not rows:
                self.message(T["no_lists"])
                break
            labels = [("[x] " if r[2] == "1" else "[  ] ") + r[4] + (f" @{r[5]}" if len(r) > 5 and r[5] else "") + f" ({r[3]})" for r in rows]
            # The cursor stays on the list just changed (the console's own lists come first, so it moves)
            start = next((i for i, r in enumerate(rows) if r[1] == at), 0)
            pick = self.menu(T["lists"], labels + [T["roms_now"], T["back"]], info=[T["lists_info"].format(n=sum(r[2] == "1" for r in rows))], start=start, wide=True)
            if pick == len(rows):
                # A change made here goes with it (the whole sync); otherwise just the download
                if changed:
                    changed = False
                    self.sync_now()
                else:
                    self.run_with_progress("roms", T["roms_now"])
                continue
            if pick is None or pick > len(rows):
                break
            r = rows[pick]
            at = r[1]
            keep = [x[1] for x in rows if x[2] == "1" and x[1] != r[1]] + ([] if r[2] == "1" else [r[1]])
            if r[2] == "1" and prune:
                self.message(T["p_server"], wait=False)
                p = {x[0]: x[1:] for x in self.client("lists-preview", *keep, timeout=60) or [] if x}
                gone = int((p.get("delete") or ["0"])[0] or 0)
                up = int((p.get("upload") or ["0"])[0] or 0)
                if gone + up:
                    size = sum(int((p.get(k) or ["0", "0"])[1] or 0) for k in ("delete", "upload"))
                    info = [T["list_drop"].format(name=r[4], n=gone + up, size=human(size))] + ([T["list_drop_up"].format(n=up)] if up else [])
                    if self.menu(T["lists"], [T["list_drop_go"].format(n=gone + up), T["cancel"]], info=info) != 0:
                        continue
            self.message(T["p_server"], wait=False)
            if self.client("lists-set", *keep) is None:
                self.message(T["lists_fail"])
            else:
                changed = True
        if changed:
            self.sync_now()

    # ---------- settings ----------

    def settings_menu(self):
        """The toggles (what each does under it), deleting the saves of deleted games, the account and disconnecting
        (asked first)"""
        sel = 0
        while True:
            cfg = self.settings()

            def yn(key, default):
                return T["yes"] if cfg.get(key, default) == "1" else T["no"]

            self.cleanable = (self.prune_state().get("cleanable") or ["0"])[0]
            items = [T["allow_pull"].format(v=yn("ALLOW_PULL", "1")), T["allow_ssh"].format(v=yn("ALLOW_SSH", "1")), T["prune"].format(v=yn("PRUNE_ROMS", "0")),
                     T["prune_clean"].format(n=self.cleanable), T["account"].format(user=self.cfg.get("USER") or "?", host=self.host()), T["logout"], T["back"]]
            notes = [T["allow_pull_note"], T["allow_ssh_note"], T["prune_note"], T["prune_clean_note"], "", "", ""]
            pick = self.menu(T["settings"], items, notes=notes, start=sel, wide=True)
            if pick is None or pick == 6:
                return
            sel = pick
            if pick == 0:
                self.toggle("ALLOW_PULL")
            elif pick == 1:
                self.toggle("ALLOW_SSH")
            elif pick == 2:
                self.prune_set(cfg.get("PRUNE_ROMS", "0") != "1")
            elif pick == 3:
                self.run_with_progress("prune", T["prune_clean"].format(n=self.cleanable), "clean")
            elif pick == 5 and self.logout():
                return

    def logout(self):
        """Disconnects this console once the user says so; True when it did"""
        if self.menu(T["logout_title"], [T["logout_go"], T["cancel"]], info=[T["logout_ask"].format(host=self.host())]) != 0:
            return False
        subprocess.run(["sh", SCRIPT, "unlink"], capture_output=True, timeout=30)
        self.cfg = {}
        self.message(T["logged_out"])
        return True

    # ---------- status ----------

    def status(self):
        """Version and install date, account and server, the last result, the last log lines (the only screen that
        shows them as they are)"""
        s = self.screen
        width = s.column(wide=True)
        info = [self.version_line(), T["account"].format(user=self.cfg.get("USER") or "?", host=self.host()),
                s.clip(f"{T['server']}: {self.cfg.get('SERVER', '')}", s.small, width), synced_at()]
        last = read_text(os.path.join(work_dir(), "last-summary"))
        if last or os.path.exists(os.path.join(work_dir(), "last-summary")):
            lines = last.splitlines()
            fails = [(None, l.split("\t", 1)[1], BAD) for l in lines if l.startswith("fail\t")]
            info += [T["last_result"]] + (summary_facts(lines) + fails or [(None, T["up_to_date"], FG)])
        log = read_text(os.path.join(self.state, "log")).splitlines()[-4:]
        # "HH:MM message" from "YYYY-MM-DD HH:MM:SS message"
        info += [T["log"]] + ([s.clip(l[11:16] + l[19:], s.small, width) for l in log] or [T["nolog"]])
        self.menu(T["status"], ["OK"], info=info, wide=True)

    def version_line(self):
        """The client's version and when this console first synced with it"""
        v = client_version()
        line = T["version"].format(v=v)
        try:
            with open(os.path.join(self.state, "version"), encoding="utf-8") as f:
                mark = f.read().strip().split("\t")
            if len(mark) == 2 and mark[0] == v:
                line += ", " + T["installed"].format(d=mark[1])
        except OSError:
            pass
        return line

    # ---------- home ----------

    def home_state(self):
        """The line under the title, the most urgent first: conflicts (warning colour), offline since, last sync"""
        n = self.conflict_count or 0
        if n:
            return (T["conflicts_line1"] if n == 1 else T["conflicts_line"].format(n=n)), WARN
        since = read_text(os.path.join(work_dir(), "offline-since")).strip()
        if since.isdigit():
            return T["offline_since"].format(t=time.strftime("%H:%M", time.localtime(int(since)))), DIM
        return synced_at(), DIM

    def home_live(self):
        """Work under way, only while it runs: a game download, games sent to the server"""
        roms, pulls = self.live.get("roms"), self.live.get("pulls")
        out = []
        if roms:
            out.append(T["w_roms"].format(n=f"{roms[0]}/{roms[1]}" if roms[1] else ""))
        if pulls:
            out.append(T["w_pulls"].format(n=f"{pulls[0]}/{pulls[1]}"))
        return out

    def home_entries(self):
        """(action, label) of the home screen: conflicts only when there are, the watch items only while they run"""
        e = [(self.sync_now, T["sync_now"])]
        if self.conflict_count:
            e.append((self.resolve_conflicts, T["conflicts"].format(n=self.conflict_count)))
        if self.live.get("roms"):
            e.append((self.sync_roms, T["roms_watch"]))
        if self.live.get("pulls"):
            e.append((self.watch_pulls, T["pulls_watch"]))
        return e + [(self.lists, T["lists"]), (self.settings_menu, T["settings"]), (self.status, T["status"]), (None, T["quit"])]

    def run(self):
        # Opened while the daemon downloads the lists' games: their progress first (B stops them)
        if self.linked() and self.roms_status():
            self.sync_roms()
        # Opened while the server fetches games from this console: that copy's progress first
        if self.linked():
            self.watch_pulls()
        while True:
            if self.linked():
                self.prune_prompts()
                self.live = {"roms": self.roms_status(), "pulls": self.pulls_status()}
                shown = {}

                def labels():
                    shown["e"] = self.home_entries()
                    return [label for _, label in shown["e"]]

                self.live_on = True
                choice = self.menu(T["title"], labels, info=self.home_live, sub=self.home_state)
                self.live_on = False
                action = shown["e"][choice][0] if choice is not None else None
            else:
                choice = self.menu(T["title"], [f"{T['server']}: {self.server}", T["login"], T["signup"], T["quit"]])
                action = [self.edit_server, self.login, self.signup, None][choice] if choice is not None else None
            if action is None:
                return
            action()
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
