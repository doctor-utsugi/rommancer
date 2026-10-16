#!/usr/bin/env python3
"""Rommancer Sync setup screen for handhelds with Python + pygame (Knulli, Batocera, ROCKNIX).

Everything is done with the gamepad: server address, log in or create an account, sync now,
status and sign out. Syncing itself is done by rommancer-sync.sh next to this file.
"""
import functools
import base64
from local_library import LocalSearch, system_name, game_system_name, plural, page_target, page_bindings, slot_updated
import json
import math
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
        "game_sync": "Sync before each game: {v}",
        "game_sync_note": "Fetches the game's saves right before it starts.",
        "game_ask": "Ask about conflicts before a game: {v}",
        "game_ask_note": "A save in conflict is settled on screen before the game starts.",
        "game_msg": "Save note when a game starts: {v}",
        "game_msg_note": "A short note on the game's screen: whether it plays the server's latest save.",
        "game_up_msg": "Note on each save uploaded in a game: {v}",
        "game_up_msg_note": "Every save made in a game goes up at once; this also says so on the game's screen.",
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
        "save_conflict": "Save conflict",
        "kind_save": "save",
        "kind_state": "savestate",
        "this_console": "This console",
        "this_console_short": "this console",
        "newer_tag": "NEWER",
        "older_tag": "OLDER",
        "keep_one": "Keep {who}'s ({at})",
        "decide_later": "Decide later: play this console's",
        "conflict_zone": "Times in {tz}.",
        "conflict_since": "Both changed after {when}.",
        "conflict_history": "The one you don't keep stays in the save's history on the web.",
        "conflict_keys": "A choose   B back",
        "conflict_keys_start": "A choose   B decide later",
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
        "show_close": "They show in the game list when you close Rommancer Sync",
        "show_arkos": "EmulationStation restarts to show them when you close Rommancer Sync",
        "show_list": "They show in the game list",
        "st_games": "Games",
        "browse": "Browse server games",
        "b_where": "Server games",
        "b_hide": "Hide owned",
        "b_search_all": "Search every system…",
        "b_search_in": "Search {name}…",
        "b_sec_systems": "Systems · {n} with games to download",
        "b_sec_systems_all": "Systems · {n}",
        "b_sec_games": "Games · {n}",
        "b_sec_results": "Results · {n} games",
        "b_sec_results1": "Results · 1 game",
        "b_sec_search": "Results",
        "b_type": "Type two letters or more to search",
        "b_hint_systems": "X tick all",
        "b_hint_games": "L1/R1 page",
        "b_review": "review",
        "b_allhave": "You already have every game the server can send to this console",
        "search_keys": "A key  B delete  X shift  Y space  START results  SELECT close",
        "b_systems_keys": "A open  X tick all  Y search  B back",
        "b_games_keys": "A tick  L1/R1 page  Y search  B back",
        "b_found_keys": "A tick  L1/R1 page  Y edit  B close the search",
        "b_counts": "{n} to download · {size}",
        "b_here_n": "({n} on this console)",
        "b_allhere": "all on this console",
        "b_games_n": "{n} games",
        "b_todo_n": "{n} to download",
        "b_here": "on this console",
        "b_queued": "downloading soon",
        "b_nonew": "Every game here is on this console already or downloading soon",
        "b_selected": "{n} games selected · {size}",
        "b_selected1": "1 game selected · {size}",
        "loading": "Loading…",
        "searching": "Searching the server…",
        "b_nomatch": "No games match “{q}”",
        "b_none": "The server has no games to send yet",
        "b_denied": "Your account cannot download games",
        "b_have": "Nothing to download: those games are on this console already or downloading soon",
        "b_ask": "Download {n} games ({size})?",
        "b_ask1": "Download 1 game ({size})?",
        "b_usable": "Usable space: {usable} ({free} free, {kept} kept free)",
        "b_pending": "Already waiting from your lists: {size}",
        "b_whole": "{name}: all {n} games, one version each; games the server gets later are not included",
        "b_long": "This may take a long time: keep the console charged",
        "b_nospace": "Not enough space: needs {need}, {usable} usable",
        "b_nospace_unknown": "Not enough space: the free space of this console could not be measured",
        "b_dl_go": "Download",
        "b_discard": "Discard {n} selected games?",
        "b_discard1": "Discard 1 selected game?",
        "b_discard_go": "Discard",
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
        pygame.K_SPACE: "y", pygame.K_F1: "start", pygame.K_PAGEUP: "pageup", pygame.K_PAGEDOWN: "pagedown",
    }
    DIRS = ("up", "down", "left", "right")
    # A direction held on a hat, a stick or a d-pad button repeats: after 300 ms, then every 60 ms (keys repeat by
    # SDL's own key repeat)
    REPEAT_AFTER, REPEAT_EVERY = 0.3, 0.06

    def __init__(self):
        pygame.joystick.init()
        self.joys = [pygame.joystick.Joystick(i) for i in range(pygame.joystick.get_count())]
        self.maps = {}
        for j in self.joys:
            m = page_bindings(es_mapping(j))
            # Generic fallback: SDL's usual south/east buttons and the first hat
            self.maps[j.get_instance_id()] = m or {"a": ("button", 0, 1), "b": ("button", 1, 1), "x": ("button", 2, 1), "y": ("button", 3, 1),
                                                   "pageup": ("button", 4, 1), "pagedown": ("button", 5, 1),
                                                   "select": ("button", 6, 1), "start": ("button", 7, 1)}
        self.axis_held = {}
        # (direction, what holds it, when it fires next)
        self.held = None

    def hold(self, acts, source):
        """A direction pressed by SOURCE starts repeating; SOURCE let go (or pressed elsewhere) stops it"""
        d = next((a for a in acts if a in self.DIRS), None)
        if d:
            self.held = (d, source, time.time() + self.REPEAT_AFTER)
        elif self.held and self.held[1] == source:
            self.held = None
        return acts

    def repeat(self):
        """The held direction when it is due again, else None"""
        if not self.held or time.time() < self.held[2]:
            return None
        self.held = (self.held[0], self.held[1], time.time() + self.REPEAT_EVERY)
        return self.held[0]

    def actions(self, event):
        if event.type == pygame.KEYDOWN:
            return [self.KEYS[event.key]] if event.key in self.KEYS else []
        if event.type == pygame.TEXTINPUT:
            return [("char", event.text)]
        m = self.maps.get(getattr(event, "instance_id", None), {})
        if event.type == pygame.JOYBUTTONDOWN:
            acts = [name for name, (kind, ident, _) in m.items() if kind == "button" and ident == event.button]
            return self.hold(acts, ("button", event.instance_id, event.button)) if any(a in self.DIRS for a in acts) else acts
        if event.type == pygame.JOYBUTTONUP:
            self.hold([], ("button", event.instance_id, event.button))
            return []
        if event.type == pygame.JOYHATMOTION:
            x, y = event.value
            acts = [d for d, ok in (("left", x < 0), ("right", x > 0), ("up", y > 0), ("down", y < 0)) if ok]
            return self.hold(acts, ("hat", event.instance_id, event.hat))
        if event.type == pygame.JOYAXISMOTION:
            key = (event.instance_id, event.axis)
            direction = 0 if abs(event.value) < 0.6 else (1 if event.value > 0 else -1)
            if direction == self.axis_held.get(key, 0):
                return []
            self.axis_held[key] = direction
            if direction == 0:
                return self.hold([], ("axis",) + key)
            named = [n for n, (kind, ident, val) in m.items() if kind == "axis" and ident == event.axis and val == direction]
            if not named:
                named = [("down" if direction > 0 else "up") if event.axis % 2 else ("right" if direction > 0 else "left")]
            return self.hold(named, ("axis",) + key)
        return []


# ---------- drawing ----------

BG = (18, 20, 28)
FG = (235, 235, 240)
DIM = (140, 145, 160)
ACCENT = (110, 170, 255)
SLOT_GREEN = (112, 229, 160)
SLOT_ACTIVE_BG = (18, 60, 41)
BAD = (255, 120, 120)
WARN = (255, 190, 90)
# The browse screens' bars, the search field, the keyboard's keys
BAR = (30, 34, 46)
FIELD = (40, 44, 60)
KEY = (50, 55, 72)


def mix(a, b, t):
    """Colour A moved T of the way to B"""
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


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

SUM_ORDER = ["saves-up", "saves-down", "states-up", "states-down", "games-down", "games-show", "games-sent", "games-deleted",
             "saves-cleaned", "games-stopped", "games-nospace", "conflicts", "errors"]
SUM_ICONS = {"saves-up": "up", "states-up": "up", "games-sent": "up", "saves-down": "down", "states-down": "down",
             "games-down": "down", "conflicts": "warn", "errors": "warn", "games-nospace": "warn"}
# When games just downloaded show, by firmware (the "games-show" line)
GAMES_SHOW = {"onion": "show_close", "knulli": "show_close", "batocera": "show_close", "rocknix": "show_close",
              "arkos": "show_arkos", "muos": "show_list", "nextui": "show_list"}


def summary_facts(lines):
    """One (icon, text, colour) per fact that is not zero, in the guide's order; the same keys added up (conflicts:
    the last count; a game with no room: each one)"""
    vals, conflicts, nospace, stopped, shows = {}, 0, [], False, ""
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
        elif p[1] == "games-show":
            shows = p[3] if len(p) > 3 else ""
        else:
            vals[p[1]] = vals.get(p[1], 0) + int(p[2])
    vals.update({"conflicts": conflicts, "games-stopped": int(stopped)})
    facts = []
    for k in SUM_ORDER:
        color = WARN if SUM_ICONS.get(k) == "warn" else FG
        if k == "games-nospace":
            facts += [("warn", T["f_games-nospace"].format(x=x), color) for x in nospace]
        elif k == "games-show":
            if shows in GAMES_SHOW:
                facts.append((None, T[GAMES_SHOW[shows]], FG))
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

    def magnifier(self, center, size, color):
        """The search icon, drawn (no font has it for sure): a ring and its handle, SIZE across"""
        w = max(2, size // 8)
        r = int(size * 0.34)
        cx, cy = center[0] - size // 8, center[1] - size // 8
        pygame.draw.circle(self.surf, color, (cx, cy), r, w)
        d = int(r * 0.72)
        pygame.draw.line(self.surf, color, (cx + d, cy + d), (center[0] + size // 2 - w // 2, center[1] + size // 2 - w // 2), w + 1)

    def tick(self, x, y, size, color):
        """A tick mark, SIZE across, drawn"""
        pygame.draw.lines(self.surf, color, False, [(x, y + size * 0.55), (x + size * 0.38, y + size * 0.9), (x + size, y + size * 0.12)], max(2, size // 6))

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
INPUT_KEYS = [list(line) for line in KEYBOARD] + [["Accept"]]

# ---------- browsing the server's games (docs/browse.md) ----------

BROWSE_PAGE = 50


def spinner(surf, center, radius):
    """A ring of dots turning (drawn: the default font may lack the glyphs), brightest at the head"""
    head = int(time.time() * 12) % 8
    dot = max(2, radius // 4)
    for i in range(8):
        k = (i - head) % 8
        a = 2 * math.pi * i / 8
        c = tuple(int(DIM[j] + (ACCENT[j] - DIM[j]) * (1 - k / 7)) for j in range(3))
        pygame.draw.circle(surf, c, (int(center[0] + (radius - dot) * math.sin(a)), int(center[1] - (radius - dot) * math.cos(a))), max(1, dot - k // 3))


class Picks:
    """The games ticked while browsing: single games (id → (bytes, system)) and whole systems (slug → the games left
    out of it, id → bytes). Ticking a system clears its single ticks"""

    def __init__(self):
        self.games, self.systems = {}, {}

    def __bool__(self):
        return bool(self.games or self.systems)

    def clear(self):
        self.games, self.systems = {}, {}

    def ticked(self, gid, slug):
        return gid not in self.systems[slug] if slug in self.systems else gid in self.games

    def toggle(self, gid, size, slug):
        if slug in self.systems:
            skip = self.systems[slug]
            if gid in skip:
                del skip[gid]
            else:
                skip[gid] = size
        elif gid in self.games:
            del self.games[gid]
        else:
            self.games[gid] = (size, slug)

    def toggle_system(self, slug):
        """The whole system ticked; one ticked in full is unticked"""
        full = slug in self.systems and not self.systems[slug]
        self.games = {g: v for g, v in self.games.items() if v[1] != slug}
        if full:
            del self.systems[slug]
        else:
            self.systems[slug] = {}

    def mark(self, slug):
        """[x] the whole system, [-] some of its games, [  ] none"""
        if slug in self.systems:
            return "[-]" if self.systems[slug] else "[x]"
        return "[-]" if any(v[1] == slug for v in self.games.values()) else "[  ]"

    def totals(self, systems):
        """(games, bytes), approximate (the review asks the server): a whole system counts its games not here yet"""
        n, b = len(self.games), sum(v[0] for v in self.games.values())
        for slug, skip in self.systems.items():
            s = systems.get(slug)
            if s and s["games"]:
                n += s["games"] - s["here"] - len(skip)
                b += s["new_bytes"] - sum(skip.values())
        return max(n, 0), max(b, 0)

    def body(self):
        return "".join([f"game\t{g}\n" for g in self.games] + [f"system\t{s}\n" for s in self.systems]
                       + [f"skip\t{g}\n" for skip in self.systems.values() for g in skip])


class Paged:
    """The games of a system or of a search (SYSTEM "-"), fetched a page at a time in a thread while the list keeps
    drawing. GEN: the search's generation, so only the latest answer shows; SHOW_ALL: the games already here or queued
    too (the server leaves them out otherwise)"""

    def __init__(self, app, system="-", query="", gen=0, show_all=False):
        self.app, self.system, self.query, self.gen, self.show_all = app, system, query, gen, show_all
        # (id, bytes, state, system, title)
        self.rows, self.total = [], None
        self.loading = self.failed = self.denied = False
        self.load()

    def load(self):
        if self.loading or self.failed or self.denied or (self.total is not None and len(self.rows) >= self.total):
            return
        self.loading = True
        threading.Thread(target=self._fetch, args=(len(self.rows),), daemon=True).start()

    def _fetch(self, offset):
        out = self.app.client("browse-games", self.system, str(offset), self.query, str(BROWSE_PAGE),
                              "all" if self.show_all else "new", timeout=20)
        if out is None:
            self.failed = True
        elif ["denied"] in out:
            self.denied = True
        else:
            got = [(p[1], int(p[2]), p[3], p[4], "\t".join(p[5:])) for p in out if p[0] == "game" and len(p) >= 6 and p[2].isdigit()]
            total = next((int(p[1]) for p in out if p[0] == "total" and len(p) > 1 and p[1].isdigit()), None)
            self.rows += got
            # A page that brings nothing ends the list, whatever the total said
            self.total = len(self.rows) if total is None or not got else total
        self.loading = False


def check_lines(out):
    """A check or add answer: bytes and games it adds, what the lists still have to bring, the space, whether it fits"""
    d = {p[0]: p[1:] for p in out if p}

    def num(v):
        return int(v) if v and v.lstrip("-").isdigit() else None

    need = (d.get("need") or []) + ["0", "0"]
    space = (d.get("space") or ["-"]) + ["-", "-"]
    usable = num(space[0])
    return {"bytes": num(need[0]) or 0, "games": num(need[1]) or 0, "pending": num((d.get("pending") or ["0"])[0]) or 0,
            "usable": None if usable is None else max(usable, 0), "free": num(space[1]) or 0, "kept": num(space[2]) or 0,
            "fits": (d.get("fits") or ["0"])[0] == "1"}


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
        self.queue, self.wait_until = [], 0.0
        # Browsing: hidden once the server said the account may not download; the searches' generation (only the
        # latest one's answer shows)
        self.browse_off, self.search_gen = False, 0
        # Whether the games already on this console are listed too (the Hide owned chip off): one setting for the whole
        # browse session
        self.browse_all = False
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

    # Input: real events, or a scripted list in tests (ROMMANCER_UI_TEST="down,a,type:zel,wait:2.5,...": "wait:S" lets
    # S seconds pass with no input, for what arrives in the background)
    def next_action(self, timeout=None):
        """Next gamepad action; None when TIMEOUT seconds pass without one (to animate)."""
        start = time.time()
        while True:
            if self.script or time.time() < self.wait_until:
                if time.time() < self.wait_until:
                    if timeout is not None and time.time() - start >= timeout:
                        return None
                    time.sleep(0.016)
                    continue
                time.sleep(0.05)
                a = self.script.pop(0)
                if a.startswith("wait:"):
                    self.wait_until = time.time() + float(a[5:])
                    continue
                return ("char", a[5:]) if a.startswith("type:") else a
            if os.environ.get("ROMMANCER_UI_TEST") is not None:
                return "quit"
            # Every event of the batch is read (a release left unread would keep a direction repeating)
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return "quit"
                self.queue += self.pad.actions(event)
            if not self.queue:
                r = self.pad.repeat()
                if r:
                    self.queue.append(r)
            if self.queue:
                return self.queue.pop(0)
            if timeout is not None and time.time() - start >= timeout:
                return None
            time.sleep(0.016)

    def menu(self, title, items, info=(), start=0, notes=None, sub=None, wide=False, big_info=False, slots=None, keys=(), footer=None):
        """ITEMS: labels, or a function giving them (called again every second, for what arrives later or changes:
        the conflicts, a download under way); the selection stays on its label. INFO: lines above them, texts or
        facts (icon, text, colour), or a function giving them. NOTES: per item, a line under the selected one saying
        what it does. SUB: the line under the title (text, colour), or a function giving it. START is the item
        selected at first; items that do not fit scroll with the selection. WIDE: the whole width, without the save
        point (long labels); BIG_INFO: the info in the items' size (a summary). KEYS: more buttons that pick the selection
        (besides A and START); the one pressed is left in self.menu_key. FOOTER: the keys' hint instead of the usual one."""
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
            s.frame(title, footer or T["menu_keys"] + "   L / R: Page", head)
            if not wide:
                s.sprite()
            x, width = s.left(), s.column(wide)
            y = s.lines(lines, x, int(s.h * 0.2), width, s.font if big_info else s.small)
            y += int(s.h * 0.04)
            n = len(labels)
            step = int(s.font.get_linesize() * (1.4 if n <= 5 else 1.12 if n <= 7 else 1.0 if n <= 8 else 0.92))
            if slots:
                step = s.font.get_linesize() + s.small.get_linesize() * (2 if any(len(c) > 3 and c[3] for c in slots) else 1) + 24
            note = notes[sel] if notes and sel < len(notes) else ""
            note_h = s.small.get_linesize() if note else 0
            # As many as fit above the footer; the window follows the selection
            fit = max(1, (int(s.h * 0.9) - y - note_h) // step)
            first = (sel // fit) * fit
            s.text(f"{sel // fit + 1} / {max(1, (n + fit - 1) // fit)}", (s.w - x - 65, int(s.h * .14)), s.small, DIM)
            # Small triangles say there is more above or below (the default font may lack arrow glyphs)
            tri = max(4, step // 6)
            top_y = y
            if first:
                pygame.draw.polygon(s.surf, DIM, [(x - 8, top_y + tri), (x - 8 - tri, top_y + 3 * tri), (x - 8 + tri, top_y + 3 * tri)])
            for i in range(first, min(n, first + fit)):
                if slots:
                    number, detail, badge = slots[i][:3]
                    updated = slots[i][3] if len(slots[i]) > 3 else ""
                    active = badge == "IN USE"
                    rect = pygame.Rect(x, y, width, step - 8)
                    pygame.draw.rect(s.surf, SLOT_ACTIVE_BG if active else BAR, rect, border_radius=10)
                    pygame.draw.rect(s.surf, SLOT_GREEN if active else ACCENT if i == sel else DIM, rect, 3 if i == sel else 2 if active else 1, border_radius=10)
                    s.text(str(number).zfill(2) if isinstance(number, int) else number, (x + 14, y + 10), s.font, SLOT_GREEN if active else ACCENT)
                    left = x + s.font.size("00")[0] + 30
                    badge_width = s.small.size(badge)[0] + 16 if badge else 0
                    s.text(s.clip(labels[i], s.font, width - (left - x) - 28 - badge_width), (left, y + 8), s.font, FG)
                    s.text(s.clip(detail, s.small, width - (left - x) - 20), (left, y + 10 + s.font.get_linesize()), s.small, DIM)
                    if updated:
                        s.text(s.clip(updated, s.small, width - (left - x) - 20), (left, y + 10 + s.font.get_linesize() + s.small.get_linesize()), s.small, (183, 245, 207) if active else DIM)
                    if badge:
                        badge_rect = pygame.Rect(rect.right - badge_width - 10, y + 8, badge_width, s.small.get_linesize() + 4)
                        if active:
                            pygame.draw.rect(s.surf, SLOT_GREEN, badge_rect, border_radius=4)
                        s.text(badge, (badge_rect.x + 8, badge_rect.y + 2), s.small, (8, 35, 21) if active else ACCENT)
                    y += step
                    continue
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
            elif a in ("pageup", "pagedown"):
                sel = page_target(sel, -1 if a == "pageup" else 1, n, fit)
            elif a in ("a", "start") or a in keys:
                self.menu_key = a
                return sel
            elif a in ("b", "quit"):
                return None

    def browse_layout(self, kb):
        """Where the browse screens' parts go: the bar, the section line, the rows, the keyboard (KB) and the footer"""
        s = self.screen
        m, mx = max(4, int(s.h * 0.02)), max(14, int(s.w * 0.03))
        bar = pygame.Rect(mx, m, s.w - 2 * mx, s.font.get_height() + 2 * int(s.h * 0.018))
        sec_y = bar.bottom + int(m * 0.6)
        fh = s.small.get_linesize() + 2 * int(s.h * 0.018)
        foot = pygame.Rect(0, s.h - fh, s.w, fh)
        kh = int(s.h * 0.075)
        # The keyboard sits over the footer and leaves the bar and a few rows in sight
        keys = pygame.Rect(mx, foot.top - m - len(INPUT_KEYS) * kh, s.w - 2 * mx, len(INPUT_KEYS) * kh) if kb else None
        return {"m": m, "x": mx, "w": s.w - 2 * mx, "bar": bar, "sec_y": sec_y, "top": sec_y + s.small.get_linesize() + int(m * 0.5),
                "bottom": (keys.top if kb else foot.top) - int(m * 0.5), "keys": keys, "kh": kh, "foot": foot,
                "step": s.font.get_linesize() + int(s.h * 0.012)}

    def bar_button(self, rect, focused, on=False):
        """A bar item: filled with the accent while focused, outlined in it while ON (a filter that is on); the colour
        its contents take"""
        s = self.screen
        radius = rect.h // 2
        if focused or on:
            pygame.draw.rect(s.surf, ACCENT if focused else mix(BAR, ACCENT, 0.2), rect, border_radius=radius)
        pygame.draw.rect(s.surf, ACCENT if focused or on else mix(BAR, DIM, 0.5), rect, 1, border_radius=radius)
        return BG if focused else ACCENT if on else FG

    def browse_bar(self, lay, where, focus, search):
        """The bar, one line: where this is, then the magnifier and the Hide owned chip, or the open search field in
        their place. FOCUS: the bar item focused (0 magnifier or field, 1 chip), None"""
        s = self.screen
        bar = lay["bar"]
        pygame.draw.rect(s.surf, BAR, bar, border_radius=bar.h // 3)
        inset = max(3, int(s.h * 0.008))
        ih = bar.h - 2 * inset
        tx = bar.x + int(s.w * 0.02)
        ty = bar.y + (bar.h - s.font.get_height()) // 2
        if search is None:
            pad = int(ih * 0.45)
            tick = int(s.small.get_height() * 0.6) if not self.browse_all else 0
            chip_w = 2 * pad + s.small.size(T["b_hide"])[0] + (tick + pad // 2 if tick else 0)
            chip = pygame.Rect(bar.right - inset - chip_w, bar.y + inset, chip_w, ih)
            mag = pygame.Rect(chip.x - inset * 2 - ih, bar.y + inset, ih, ih)
            s.text(s.clip(where, s.font, mag.x - tx - inset * 2), (tx, ty), s.font, FG)
            color = self.bar_button(mag, focus == 0)
            s.magnifier(mag.center, int(ih * 0.62), color)
            color = self.bar_button(chip, focus == 1, on=not self.browse_all)
            x = chip.x + pad
            if tick:
                s.tick(x, chip.centery - tick // 2, tick, color)
                x += tick + pad // 2
            s.text(T["b_hide"], (x, chip.centery - s.small.get_height() // 2), s.small, color)
            return
        # The search open: the field takes the place of the magnifier and the chip
        title_w = min(s.font.size(where)[0], int(bar.w * 0.34))
        s.text(s.clip(where, s.font, title_w), (tx, ty), s.font, FG)
        field = pygame.Rect(tx + title_w + int(s.w * 0.02), bar.y + inset, 0, ih)
        field.w = bar.right - inset - field.x
        hot = focus == 0 and not search["kb"]
        pygame.draw.rect(s.surf, ACCENT if hot else FIELD, field, border_radius=ih // 3)
        if search["kb"]:
            pygame.draw.rect(s.surf, ACCENT, field, 2, border_radius=ih // 3)
        icon = int(ih * 0.6)
        s.magnifier((field.x + ih // 2, field.centery), icon, BG if hot else ACCENT)
        x = field.x + ih
        right = field.right - int(ih * 0.3)
        if search["busy"]:
            r = s.small.get_height() // 2
            spinner(s.surf, (right - r, field.centery), r)
            right -= 2 * r + int(ih * 0.3)
        text, color = search["text"], BG if hot else FG
        if search["kb"]:
            text += "_"
        if not search["text"]:
            text, color = (search["hint"], BG if hot else DIM) if not search["kb"] else ("_", FG)
        # The end of a long text stays in sight
        while s.font.size(text)[0] > right - x and len(text) > 1:
            text = text[1:]
        s.text(text, (x, field.centery - s.font.get_height() // 2), s.font, color)

    def browse_keyboard(self, lay, kb):
        """The on-screen keyboard over the bottom of the list, KB its state (row, col, upper)"""
        s = self.screen
        keys = lay["keys"]
        pygame.draw.rect(s.surf, BG, (0, keys.top - lay["m"] // 2, s.w, lay["foot"].top - keys.top + lay["m"] // 2))
        kw, kh = keys.w // 10, lay["kh"]
        gap = max(3, kh // 10)
        for r, line in enumerate(INPUT_KEYS):
            for c, ch in enumerate(line):
                accept = ch == "Accept"
                ch = ch.upper() if kb["upper"] and not accept else ch
                rect = pygame.Rect(keys.x + c * kw, keys.y + r * kh, (keys.w if accept else kw) - gap, kh - gap)
                hot = (r, c) == (kb["row"], kb["col"])
                pygame.draw.rect(s.surf, ACCENT if hot else KEY, rect, border_radius=6)
                img = s.font.render(ch, True, BG if hot else FG)
                s.surf.blit(img, img.get_rect(center=rect.center))

    def browse_footer(self, lay, foot, hint):
        """The fixed footer: FOOT (what is ticked, then START review) when something is, else the keys' HINT"""
        s = self.screen
        r = lay["foot"]
        pygame.draw.rect(s.surf, BAR, r)
        ty = r.y + (r.h - s.small.get_height()) // 2
        if not foot:
            s.text(s.clip(hint, s.small, s.w - 2 * lay["x"]), (s.w // 2, ty), s.small, DIM, center=True)
            return
        label = T["b_review"]
        lw, kw = s.small.size(label)[0], s.small.size("START")[0]
        pad = max(4, int(s.h * 0.01))
        kx = r.right - lay["x"] - lw - pad * 3 - kw
        key = pygame.Rect(kx, ty - pad // 2, kw + 2 * pad, s.small.get_height() + pad)
        pygame.draw.rect(s.surf, ACCENT, key, border_radius=key.h // 3)
        s.text("START", (key.x + pad, ty), s.small, BG)
        s.text(label, (key.right + pad, ty), s.small, FG)
        s.text(s.clip(foot, s.small, kx - 2 * lay["x"]), (lay["x"], ty), s.small, ACCENT)

    def browse_list(self, where, rows, view, section, hint, keys, foot=None, near_end=None, tail=None, search=None, poll=None, faded=None):
        """The browse screens: the bar, the section line, one-line rows and a fixed footer, all with the pad.
        ROWS: a function giving (label, right text, colour) per row, read every frame (pages arrive meanwhile); a right
        text may be a tuple of choices, longest first (the first that leaves the label whole shows). VIEW: a dict
        keeping the selection, the scroll, the bar's focus ("bar": None, 0 the magnifier or field, 1 the chip) and the
        keyboard's state between calls. SECTION(): (text, busy) for the line under the bar, HINT its right end; KEYS:
        the footer's hint, FOOT(): its text when something is ticked. NEAR_END(): called while the selection is near
        the last row; TAIL(): a dim line after the rows, never selected. SEARCH: None (closed) or a dict with "text",
        "hint" (the field's placeholder), "kb" (the keyboard is open), "busy" (the spinner) and "edit" (called with each
        new text), or a function giving it. POLL(): called every frame; FADED(): whether the rows are a stale answer.
        Returns (action, row index or None): a, x, start; "search" (Y, or A on the magnifier or field), "owned" (A on
        the chip), "submit" (START on the keyboard: the focus goes to the results), "close" (SELECT on the keyboard,
        or B with the field empty), b, quit"""
        s = self.screen
        kb = view.setdefault("kb", {"row": 0, "col": 0, "upper": False})
        live = search
        while True:
            if poll:
                poll()
            search = live() if callable(live) else live
            typing = bool(search and search["kb"])
            lay = self.browse_layout(typing)
            items = rows()
            n = len(items)
            sel = min(max(view.get("sel", 0), 0), max(n - 1, 0))
            bar_n = 1 if search else 2
            focus = view.get("bar")
            if focus is not None:
                focus = min(focus, bar_n - 1)
            s.surf.fill(BG)
            self.browse_bar(lay, where, None if typing else focus, search)
            text, busy = section()
            x, width = lay["x"], lay["w"]
            sx = x + int(s.w * 0.012)
            if busy:
                r = s.small.get_height() // 2 - 1
                spinner(s.surf, (sx + r, lay["sec_y"] + s.small.get_height() // 2), r)
                sx += 2 * r + int(s.w * 0.012)
            hw = s.small.size(hint)[0] if hint else 0
            if hint:
                s.text(hint, (x + width - hw - int(s.w * 0.012), lay["sec_y"]), s.small, DIM)
            s.text(s.clip(text.upper(), s.small, x + width - hw - sx - int(s.w * 0.04)), (sx, lay["sec_y"]), s.small, ACCENT if busy else DIM)
            top, step = lay["top"], lay["step"]
            extra = tail() if tail else ""
            fit = max(1, (lay["bottom"] - top) // step - (1 if extra else 0))
            first = (sel // fit) * fit
            stale = bool(faded and faded())
            on_rows = focus is None and not typing
            y = top
            for i in range(first, min(n, first + fit)):
                label, right, color = items[i]
                if isinstance(right, tuple):
                    right = next((r for r in right if s.small.size(r)[0] + s.font.size(label)[0] + 40 <= width), right[-1])
                rw = s.small.size(right)[0] if right else 0
                hot = i == sel and on_rows
                row = pygame.Rect(x, y - 4, width, s.font.get_height() + 8)
                # The cursor row is a filled bar, its texts in the background colour; outlined while the focus is elsewhere
                if hot:
                    pygame.draw.rect(s.surf, ACCENT, row, border_radius=8)
                elif i == sel:
                    pygame.draw.rect(s.surf, mix(BG, ACCENT, 0.45), row, 1, border_radius=8)
                dim, fg = (BG, BG) if hot else (DIM, color)
                if stale and not hot:
                    dim, fg = mix(BG, dim, 0.45), mix(BG, fg, 0.45)
                if right:
                    s.text(right, (x + width - rw - 10, y + (s.font.get_height() - s.small.get_height()) // 2), s.small, dim)
                s.text(s.clip(label, s.font, width - rw - 36), (x + 10, y), s.font, fg)
                y += step
            if extra and first + fit >= n:
                s.text(s.clip(extra, s.font, width - 20), (x + 10, y), s.font, DIM)
            tri = max(4, step // 6)
            ax = x // 2
            if first:
                pygame.draw.polygon(s.surf, DIM, [(ax, top + tri), (ax - tri, top + 3 * tri), (ax + tri, top + 3 * tri)])
            if first + fit < n:
                b = top + (fit - 1) * step
                pygame.draw.polygon(s.surf, DIM, [(ax - tri, b + tri), (ax + tri, b + tri), (ax, b + 3 * tri)])
            if typing:
                self.browse_keyboard(lay, kb)
            page_hint = f"L / R: Page  {sel // fit + 1}/{max(1, (n + fit - 1) // fit)}"
            self.browse_footer(lay, None if typing else foot() if foot else None, T["search_keys"] if typing else keys + "   " + page_hint)
            s.flip()
            view["first"] = first
            if near_end and not typing and n - sel <= 10:
                near_end()
            a = self.next_action(timeout=0)
            if a is None:
                self.clock.tick(SPRITE_FPS)
                continue
            if typing:
                value = search["text"]
                if a in ("pageup", "pagedown"):
                    view["bar"] = None
                    view["sel"] = page_target(sel, -1 if a == "pageup" else 1, n, fit)
                    return "leave-edit", None
                if isinstance(a, tuple):
                    value += a[1]
                elif a in ("up", "down"):
                    kb["row"] = (kb["row"] + (1 if a == "down" else -1)) % len(INPUT_KEYS)
                    kb["col"] = min(kb["col"], len(INPUT_KEYS[kb["row"]]) - 1)
                elif a in ("left", "right"):
                    kb["col"] = (kb["col"] + (1 if a == "right" else -1)) % len(INPUT_KEYS[kb["row"]])
                elif a == "a":
                    ch = INPUT_KEYS[kb["row"]][kb["col"]]
                    if ch == "Accept":
                        view["bar"], view["sel"], view["first"] = None, 0, 0
                        return "submit", None
                    value += ch.upper() if kb["upper"] else ch
                elif a == "b":
                    if not value:
                        return "close", None
                    value = value[:-1]
                elif a == "x":
                    kb["upper"] = not kb["upper"]
                elif a == "y":
                    value += " "
                elif a == "start":
                    view["bar"], view["sel"], view["first"] = None, 0, 0
                    return "submit", None
                elif a == "select":
                    return "close", None
                elif a == "quit":
                    return "quit", None
                if value != search["text"]:
                    search["edit"](value)
                continue
            if a in ("pageup", "pagedown"):
                view["bar"] = None
                sel = page_target(sel, -1 if a == "pageup" else 1, n, fit)
            elif focus is not None:
                if a == "down":
                    view["bar"] = None
                elif a in ("left", "right"):
                    view["bar"] = min(max(focus + (1 if a == "right" else -1), 0), bar_n - 1)
                elif a == "a":
                    return ("owned" if focus == 1 else "search"), None
            elif a == "up":
                if sel > 0:
                    sel -= 1
                else:
                    view["bar"] = 0
            elif a == "down":
                sel = min(sel + 1, max(n - 1, 0))
            elif a == "pageup":
                sel = max(0, sel - fit)
            elif a == "pagedown":
                sel = min(max(n - 1, 0), sel + fit)
            elif a in ("a", "x"):
                view["sel"] = sel
                return a, (sel if n else None)
            # Kept as asked while rows are still arriving (the first page), so the selection lands where it was meant
            view["sel"] = sel
            if a == "y":
                return "search", None
            if a == "start":
                return a, (sel if n else None)
            if a in ("b", "quit"):
                return a, None

    def keyboard(self, title, value="", secret=False):
        """The on-screen keyboard: the text on START, None on SELECT"""
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
            for r, line in enumerate(INPUT_KEYS):
                for c, ch in enumerate(line):
                    accept = ch == "Accept"
                    ch = ch.upper() if upper and not accept else ch
                    rect = pygame.Rect(30 + c * kw, int(s.h * 0.3) + r * kh, (10 * kw if accept else kw) - 6, kh - 6)
                    hot = (r, c) == (row, col)
                    pygame.draw.rect(s.surf, ACCENT if hot else (50, 55, 72), rect, border_radius=6)
                    img = s.font.render(ch, True, BG if hot else FG)
                    s.surf.blit(img, img.get_rect(center=rect.center))
            s.flip()
            a = self.next_action()
            if isinstance(a, tuple):
                value += a[1]
            elif a == "up":
                row = (row - 1) % len(INPUT_KEYS)
                col = min(col, len(INPUT_KEYS[row]) - 1)
            elif a == "down":
                row = (row + 1) % len(INPUT_KEYS)
                col = min(col, len(INPUT_KEYS[row]) - 1)
            elif a == "left":
                col = (col - 1) % len(INPUT_KEYS[row])
            elif a == "right":
                col = (col + 1) % len(INPUT_KEYS[row])
            elif a == "a":
                ch = INPUT_KEYS[row][col]
                if ch == "Accept":
                    return value
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

    def toggle(self, key, default="1"):
        on = self.settings().get(key, default) == "1"
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
            keep = self.conflict_screen(rows[pick])
            if keep:
                self.run_with_progress("resolve", title, rows[pick][1], keep)

    def conflict_screen(self, c, start=False):
        """One conflict (a server \"conflict\" line, split): both saves side by side, the newer first and selected, where
        and when each was made, the time zone, since when they differ. \"device\" or \"server\" for the one kept; None
        (B, or \"decide later\" before a game) leaves it"""
        c = c + ["-"] * (13 - len(c))
        game, kind, dev, here_name = c[2], c[3], c[6], c[7]
        mine = c[8] if c[8] != "-" else c[4][:16].replace("T", " ")
        theirs = c[9] if c[9] != "-" else c[5][:16].replace("T", " ")
        newer = c[12] if c[12] in ("device", "server") else ("device" if c[4] >= c[5] else "server")
        here = {"side": "device", "who": T["this_console"], "when": mine}
        there = {"side": "server", "who": dev if dev != "-" else "web", "when": theirs}
        cards = [here, there] if newer == "device" else [there, here]
        options = [T["keep_one"].format(who=k["who"] if k is there else T["this_console_short"], at=k["when"].split()[-1]) for k in cards]
        sides = [k["side"] for k in cards]
        if start:
            options.append(T["decide_later"])
        foot = []
        if c[10] != "-":
            foot.append(T["conflict_zone"].format(tz=c[10]))
        if c[11] != "-":
            foot.append(T["conflict_since"].format(when=c[11]))
        foot.append(T["conflict_history"])
        sel = 0
        while True:
            s = self.screen
            s.frame(T["save_conflict"], T["conflict_keys_start" if start else "conflict_keys"], (f"{game} · {T['kind_state' if kind == 'STATE' else 'kind_save']}", FG))
            x, width = s.left(), s.column(True)
            gap = int(s.w * 0.03)
            pad = int(s.w * 0.02)
            cw, top = (width - gap) // 2, int(s.h * 0.17)
            ch = 2 * pad + 2 * s.small.get_linesize() + s.font.get_linesize()
            for i, k in enumerate(cards):
                cx = x + i * (cw + gap)
                is_new = i == 0
                pygame.draw.rect(s.surf, ACCENT if is_new else DIM, (cx, top, cw, ch), 2, border_radius=10)
                y = top + pad
                s.text(T["newer_tag"] if is_new else T["older_tag"], (cx + pad, y), s.small, ACCENT if is_new else DIM)
                y += s.small.get_linesize()
                s.text(s.clip(k["who"], s.small, cw - 2 * pad), (cx + pad, y), s.small, FG)
                y += s.small.get_linesize()
                s.text(s.clip(k["when"], s.font, cw - 2 * pad), (cx + pad, y), s.font, FG)
            y = s.lines(foot, x, top + ch + int(s.h * 0.02), width)
            y += int(s.h * 0.02)
            step = int(s.font.get_linesize() * 1.25)
            for i, label in enumerate(options):
                r = s.text(s.clip(label, s.font, width - 20), (x + 10, y), s.font, ACCENT if i == sel else FG)
                if i == sel:
                    pygame.draw.rect(s.surf, ACCENT, r.inflate(20, 8), 2, border_radius=8)
                y += step
            s.flip()
            a = self.next_action(timeout=0)
            if a is None:
                self.clock.tick(SPRITE_FPS)
            elif a == "up":
                sel = (sel - 1) % len(options)
            elif a == "down":
                sel = (sel + 1) % len(options)
            elif a in ("a", "start"):
                return sides[sel] if sel < len(sides) else None
            elif a in ("b", "quit"):
                return None

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

    # ---------- browsing the server's games (docs/browse.md) ----------

    def in_thread(self, fn, text):
        """FN's result, run in a thread while TEXT shows (the screen keeps drawing)"""
        box = {}
        th = threading.Thread(target=lambda: box.update(r=fn()), daemon=True)
        th.start()
        while th.is_alive():
            self.message(text, wait=False)
            pygame.event.pump()
            self.clock.tick(30)
        return box.get("r")

    def browse_fail(self):
        """Could not reach the server, with the details behind a button"""
        details = read_text(self.details_file()).strip().splitlines()
        if not details:
            self.message(T["lists_fail"], BAD)
        elif self.menu(T["browse"], ["OK", T["details"]], info=[(None, T["lists_fail"], BAD), details[0]]) == 1:
            self.menu(T["details"], ["OK"], info=details[1:], wide=True)

    def browse_denied(self):
        self.browse_off = True
        self.message(T["b_denied"], BAD)

    def picks_foot(self, picks, systems):
        """The footer's text: what is ticked so far (approximate; the review asks the server), None when nothing is"""
        if not picks:
            return None
        n, size = picks.totals(systems)
        return T["b_selected1" if n == 1 else "b_selected"].format(n=n, size=human(size))

    def browse_systems(self):
        """slug → system the server can send here; None when there is nothing to browse (said on screen)"""
        out = self.in_thread(lambda: self.client("browse-systems", timeout=20), T["checking"])
        if out is None:
            self.browse_fail()
            return None
        if ["denied"] in out:
            self.browse_denied()
            return None
        systems = {}
        for p in out:
            if p[0] == "system" and len(p) >= 6 and all(v.isdigit() for v in p[2:5]):
                games, size, here = int(p[2]), int(p[3]), int(p[4])
                # newBytes: the size of the games not here yet (servers before it: a share of the whole size)
                new_bytes = int(p[6]) if len(p) >= 7 and p[6].isdigit() else (size * (games - here) // games if games else 0)
                systems[p[1]] = {"slug": p[1], "games": games, "bytes": size, "here": here, "new_bytes": new_bytes, "name": p[5] or p[1]}
        if not systems:
            self.message(T["b_none"])
            return None
        return systems

    def browse(self):
        """The systems: A opens one, X ticks it whole, Y (or the magnifier) searches every system, the chip shows or
        hides the systems with nothing left to download, START reviews and downloads what is ticked. Leaving with games
        ticked asks first"""
        systems = self.browse_systems()
        if systems is None:
            return
        picks, view = Picks(), {"sel": 0}
        self.browse_all = False
        while True:
            # With owned games hidden, the systems with nothing left to download are left out
            order = [s for s in systems.values() if self.browse_all or s["games"] > s["here"]]

            def system_right(s):
                new = s["games"] - s["here"]
                if not new:
                    return T["b_allhere"]
                todo = T["b_counts"].format(n=new, size=human(s["new_bytes"]))
                return (f"{todo}  {T['b_here_n'].format(n=s['here'])}", todo) if s["here"] else todo

            def rows():
                return [(f"{picks.mark(s['slug'])} {s['name']}", system_right(s), FG) for s in order]

            def section():
                return T["b_sec_systems_all" if self.browse_all else "b_sec_systems"].format(n=len(order)), False

            act, i = self.browse_list(T["b_where"], rows, view, section, T["b_hint_systems"], T["b_systems_keys"],
                                      foot=lambda: self.picks_foot(picks, systems), tail=lambda: "" if order else T["b_allhave"])
            r = None
            if act == "quit":
                return
            if act == "b":
                n = picks.totals(systems)[0]
                if not picks or self.menu(T["browse"], [T["b_discard_go"], T["cancel"]], info=[T["b_discard1" if n == 1 else "b_discard"].format(n=n)]) == 0:
                    return
            elif act == "owned":
                self.browse_all = not self.browse_all
            elif act == "search":
                r = self.browse_games(picks, systems)
            elif act == "start":
                r = self.browse_review(picks, systems)
            elif act == "x" and i is not None:
                picks.toggle_system(order[i]["slug"])
            elif act == "a" and i is not None:
                r = self.browse_games(picks, systems, system=order[i])
            if r == "leave":
                return
            if r == "done":
                # The "here" counts changed
                systems = self.browse_systems()
                if systems is None:
                    return

    def browse_games(self, picks, systems, system=None):
        """Browse a system or all games; Accept/START applies the draft query once."""
        slug = system["slug"] if system else "-"
        q = {"open": system is None, "kb": system is None, "text": "", "applied": ""}
        # PAGED is shown; NEXT is the answer on its way for the latest query, swapped in once it comes
        st = {"paged": Paged(self, slug, show_all=self.browse_all) if system else None, "next": None}
        view = {"sel": 0}
        frozen = {"rows": None}

        def wanted():
            t = q["text"].strip()
            return t if len(t) >= 2 else ""

        def ask():
            q["applied"] = wanted()
            if not system and not q["applied"]:
                st["paged"], st["next"] = None, None
                return
            self.search_gen += 1
            st["next"] = Paged(self, slug, q["applied"], gen=self.search_gen, show_all=self.browse_all)

        def edit(value):
            q["text"] = value

        def close():
            q.update(open=False, kb=False, text="")
            view["bar"] = None
            if q["applied"] or st["next"]:
                q["applied"] = ""
                ask()

        def poll():
            n = st["next"]
            if n and (n.total is not None or n.failed or n.denied):
                st["paged"], st["next"] = n, None
                view["sel"], view["first"] = 0, 0

        def pending():
            p = st["paged"]
            return bool(st["next"] or (p and p.total is None and not (p.failed or p.denied)))

        def rows():
            if q["kb"] and frozen["rows"] is not None:
                return frozen["rows"]
            p = st["paged"]
            out = []
            for gid, size, state, sys_slug, title in list(p.rows) if p else []:
                where = systems[sys_slug]["name"] if not system and sys_slug in systems else ""
                if state in ("here", "queued"):
                    right = T[f"b_{state}"]
                    out.append((f"       {title}", (f"{where} · {right}", right) if where else right, DIM))
                else:
                    out.append((f"{'[x]' if picks.ticked(gid, sys_slug) else '[  ]'} {title}", (f"{where} · {human(size)}", human(size)) if where else human(size), FG))
            frozen["rows"] = out if q["kb"] else None
            return out

        def tail():
            p = st["paged"]
            if not p:
                return "" if pending() else T["b_type"]
            if p.denied:
                return T["b_denied"]
            if p.failed:
                return T["lists_fail"]
            if p.loading:
                return T["loading"]
            if p.total == 0:
                return T["b_nomatch"].format(q=p.query) if p.query else T["b_none"] if p.show_all else T["b_nonew"]
            return ""

        def section():
            p = st["paged"]
            if pending():
                return T["searching" if q["open"] and (q["text"].strip() or q["applied"]) else "loading"], True
            if p and p.total is not None and p.query:
                return T["b_sec_results1" if p.total == 1 else "b_sec_results"].format(n=p.total), False
            if p and p.total is not None:
                return T["b_sec_games"].format(n=p.total), False
            return T["b_sec_search"], False

        def search():
            if not q["open"]:
                return None
            return {"text": q["text"], "kb": q["kb"], "busy": pending(), "edit": edit,
                    "hint": T["b_search_in"].format(name=system["name"]) if system else T["b_search_all"]}

        where = system["name"] if system else T["b_where"]
        while True:
            keys = T["b_found_keys"] if q["open"] and system else T["b_games_keys"]
            act, i = self.browse_list(where, rows, view, section, T["b_hint_games"], keys,
                                      foot=lambda: self.picks_foot(picks, systems), near_end=lambda: st["paged"] and st["paged"].load(),
                                       tail=tail, search=search, poll=poll, faded=lambda: bool(st["paged"] and st["next"]))
            paged = st["paged"]
            if paged and paged.denied:
                self.browse_off = True
                return "leave"
            if act == "quit":
                return "leave"
            if act in ("b", "close"):
                if not q["open"] or not system:
                    return None
                close()
            elif act == "search":
                q["open"] = q["kb"] = True
            elif act == "leave-edit":
                q["kb"] = False
                q["text"] = q["applied"]
            elif act == "submit":
                q["kb"] = False
                # At once, unless this very text's answer is there or on its way
                if wanted() != q["applied"] or (st["paged"] is None and st["next"] is None):
                    ask()
            elif act == "owned":
                # The list again from the server, with or without the games already here
                self.browse_all = not self.browse_all
                if system or q["applied"]:
                    self.search_gen += 1
                    st["next"] = Paged(self, slug, q["applied"], gen=self.search_gen, show_all=self.browse_all)
            elif act == "start":
                r = self.browse_review(picks, systems)
                if r:
                    return r
            elif act == "a" and paged and paged.failed:
                # A tries again
                paged.failed = False
                paged.load()
            elif act == "a" and paged and i is not None and i < len(paged.rows):
                gid, size, state, sys_slug, _ = paged.rows[i]
                if state == "new":
                    picks.toggle(gid, size, sys_slug)

    def browse_nospace(self, c):
        line = T["b_nospace"].format(need=human(c["bytes"]), usable=human(c["usable"])) if c["usable"] is not None else T["b_nospace_unknown"]
        info = [(None, line, WARN)] + ([T["b_pending"].format(size=human(c["pending"]))] if c["pending"] else [])
        self.menu(T["browse"], ["OK"], info=info)

    def browse_review(self, picks, systems):
        """Before every download: what the server says the selection adds and the room for it, then the download on
        screen. "done" once games downloaded, "leave" when the account may not download, None otherwise"""
        if not picks:
            return None
        body = os.path.join(work_dir(), "browse-body")
        try:
            with open(body, "w", encoding="utf-8") as f:
                f.write(picks.body())
        except OSError:
            return None
        out = self.in_thread(lambda: self.client("browse-check", body, timeout=35), T["checking"])
        if out is None:
            self.browse_fail()
            return None
        if ["denied"] in out:
            self.browse_denied()
            return "leave"
        c = check_lines(out)
        if not c["games"]:
            self.message(T["b_have"])
            return None
        if not c["fits"]:
            self.browse_nospace(c)
            return None
        info = [(None, T["b_ask1" if c["games"] == 1 else "b_ask"].format(n=c["games"], size=human(c["bytes"])), FG),
                T["b_usable"].format(usable=human(c["usable"] or 0), free=human(c["free"]), kept=human(c["kept"]))]
        if c["pending"]:
            info.append(T["b_pending"].format(size=human(c["pending"])))
        for slug, skip in picks.systems.items():
            s = systems.get(slug)
            if s:
                info.append(T["b_whole"].format(name=s["name"], n=max(s["games"] - s["here"] - len(skip), 0)))
        if c["games"] > 50 or c["bytes"] > 2 * 1024 ** 3:
            info.append((None, T["b_long"], WARN))
        if self.menu(T["browse"], [T["b_dl_go"], T["cancel"]], info=info, wide=True) != 0:
            return None
        out = self.in_thread(lambda: self.client("browse-add", body, timeout=65), T["checking"])
        if out is None:
            self.browse_fail()
            return None
        if ["denied"] in out:
            self.browse_denied()
            return "leave"
        if ["nospace"] in out:
            self.browse_nospace(check_lines(out))
            return None
        if not any(p[0] == "added" for p in out):
            self.browse_fail()
            return None
        picks.clear()
        self.run_with_progress("browse-get", T["browse"])
        return "done"

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
            items = [T["game_sync"].format(v=yn("GAME_SYNC", "1")), T["game_ask"].format(v=yn("GAME_ASK", "1")),
                     T["game_msg"].format(v=yn("GAME_MSG", "1")), T["game_up_msg"].format(v=yn("GAME_UP_MSG", "0")), T["allow_pull"].format(v=yn("ALLOW_PULL", "1")), T["allow_ssh"].format(v=yn("ALLOW_SSH", "1")), T["prune"].format(v=yn("PRUNE_ROMS", "0")),
                     T["prune_clean"].format(n=self.cleanable), T["account"].format(user=self.cfg.get("USER") or "?", host=self.host()), T["logout"], T["back"]]
            notes = [T["game_sync_note"], T["game_ask_note"], T["game_msg_note"], T["game_up_msg_note"], T["allow_pull_note"], T["allow_ssh_note"], T["prune_note"], T["prune_clean_note"], "", "", ""]
            pick = self.menu(T["settings"], items, notes=notes, start=sel, wide=True)
            if pick is None or pick == 10:
                return
            sel = pick
            if pick == 0:
                self.toggle("GAME_SYNC")
            elif pick == 1:
                self.toggle("GAME_ASK")
            elif pick == 2:
                self.toggle("GAME_MSG")
            elif pick == 3:
                self.toggle("GAME_UP_MSG", "0")
            elif pick == 4:
                self.toggle("ALLOW_PULL")
            elif pick == 5:
                self.toggle("ALLOW_SSH")
            elif pick == 6:
                self.prune_set(cfg.get("PRUNE_ROMS", "0") != "1")
            elif pick == 7:
                self.run_with_progress("prune", T["prune_clean"].format(n=self.cleanable), "clean")
            elif pick == 9 and self.logout():
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
        e.append((self.lists, T["lists"]))
        e.append((self.journeys, "Journeys"))
        if not self.browse_off:
            e.append((self.browse, T["browse"]))
        return e + [(self.settings_menu, T["settings"]), (self.status, T["status"]), (None, T["quit"])]

    def journeys(self):
        decode = lambda value: base64.b64decode(value).decode("utf-8")
        rows = self.in_thread(lambda: self.client("journeys", "games", timeout=60), "Loading your games")
        if rows is None:
            self.message("Could not load your games. Check the server connection.", BAD)
            return
        enrolled = {p[2]: p[1] for p in rows if len(p) >= 3 and p[0] == "enrolled"}
        games = [(p[0], p[1], decode(p[2]), p[3]) + ((decode(p[4]),) if len(p) > 4 else ()) for p in rows if len(p) >= 4 and p[0] == "game"]
        if not games:
            self.message("No games here can use save slots yet. Run Sync now so the server knows this console's games.")
            return
        names = {g[3]: game_system_name(g) for g in games}
        system = None
        views, searches, local_searches = {}, {}, {}
        while True:
            key = system or "all"
            view = views.setdefault(key, {"sel": 0, "first": 0, "bar": None})
            search = searches.setdefault(key, {"text": "", "hint": "Search consoles and games" if system is None else "Search this console's games", "kb": False, "busy": False})
            if key not in local_searches:
                local_searches[key] = LocalSearch(games, system, set(enrolled))
            local = local_searches[key]
            def edit(value):
                search["text"] = value
            search["edit"] = edit
            def found():
                return local.rows
            display = [(r[2], r[3], FG) for r in found()]
            def section():
                if local.applied:
                    return (plural(len(found()), "result") + f" for “{local.applied}”", False)
                if system is None:
                    return (plural(len(enrolled), "game") + " with slots · " + plural(len(names), "console"), False)
                return (plural(len(found()), "game"), False)
            action, at = self.browse_list(
                "Journeys" if system is None else "Journeys · " + names.get(system, system_name(system)),
                lambda: display, view, section,
                "Save slots", "A: Open   B: Back   Y: Search", search=search,
                tail=lambda: "No matches. Try another name." if not found() else "")
            if action in ("b", "quit"):
                if system is None or action == "quit":
                    return
                system = None
                continue
            if action == "search":
                search["kb"] = True
                continue
            if action in ("submit", "close", "leave-edit"):
                search["kb"] = False
                view["bar"] = None
                if action != "submit":
                    edit(local.applied)
                else:
                    local.accept(search["text"])
                    view["sel"], view["first"] = 0, 0
                continue
            if action != "a" or at is None:
                continue
            chosen = found()[at]
            if chosen[0] == "system":
                system = chosen[1]
                continue
            game = next(g for g in games if g[1] == chosen[1])
            identity = enrolled.get(game[1])
            if identity is None:
                if self.menu(game[2].rsplit(".", 1)[0], ["Set up save slots", "Back"], wide=True, info=[
                        "This game has no save slots on this console yet.",
                        "Setting them up keeps the saves and states it has now in a slot of their own.",
                        "The slots you made on other consoles appear next to it, ready to use."]) != 0:
                    continue
                if not self.journey_close_notice():
                    continue
                result = self.in_thread(lambda: self.client("journeys", "enroll", game[1], timeout=180), "Keeping your saves in a slot")
                identity = next((p[1] for p in (result or []) if len(p) >= 2 and p[0] == "enrolled"), None)
                if not identity:
                    self.message("Could not set up save slots. Your saves are kept as they were.", BAD)
                    continue
                enrolled[game[1]] = identity
                local_searches.clear()
            self.journey_slots(identity, game[2].rsplit(".", 1)[0], decode)

    def journey_close_notice(self):
        state = self.in_thread(lambda: self.client("journeys", "runtime", timeout=10), "Checking game")
        if state and ["runtime", "stopped"] in state:
            return True
        return self.menu("Is the game closed?", ["Yes, continue", "Cancel"], wide=True, info=[
            "An emulator with this game loaded would write its old save over the slot when it exits.",
            "Close the game first (Quick Menu > Close Content), then continue."]) == 0

    def journey_slots(self, identity, title, decode):
        cursor = 0
        focus_active = True
        cached_only = False
        note = None
        while True:
            rows = self.in_thread(lambda: self.client("journeys", "list", identity, *( ["cached"] if cached_only else [] ), timeout=180), "Loading save slots")
            cached_only = False
            if rows is None:
                self.message("Save slots need attention. Check Status for details.", BAD)
                return
            active = next((p[1] for p in rows if p[0] == "active"), None)
            cached = {p[1] for p in rows if p[0] == "cached"}
            slots = [p for p in rows if len(p) >= 4 and p[0] == "journey"]
            conflicts = {p[1] for p in rows if p[0] == "conflict"}
            incompatible = {p[1] for p in rows if p[0] == "incompatible"}
            numbers = {p[1]: int(p[2]) for p in rows if len(p) >= 3 and p[0] == "slot"}
            counts = {p[1]: int(p[2]) for p in rows if len(p) >= 3 and p[0] == "content"}
            updated = {p[1]: slot_updated(p[2]) for p in rows if len(p) >= 3 and p[0] == "modified"}
            pending_sync = {p[1] for p in rows if len(p) >= 2 and p[0] == "pending-sync"}
            queued = any(p[0] == "pending" for p in rows)
            slots.sort(key=lambda p: numbers.get(p[1], 999999))
            def content(p):
                if p[1] in conflicts:
                    return "Two versions of this progress · X to choose"
                if p[1] not in cached:
                    return "Needs a download · connect to use it"
                n = counts.get(p[1], 0)
                return ("No saves yet" if n == 0 else "1 save file" if n == 1 else f"{n} saves and states") + (" · waiting to sync" if p[1] in pending_sync else "")
            empty_name = "New game · " + time.strftime("%d %b %H:%M")
            labels = [decode(p[3]) for p in slots] + ["Empty slot"]
            def when(p):
                text = updated.get(p[1], slot_updated(p[4] if len(p) > 4 else ""))
                return text.removeprefix("Updated: ") if text.startswith("Updated: ") else ""
            cards = [(numbers.get(p[1], i + 1), " · ".join(x for x in (content(p), when(p)) if x),
                      "IN USE" if p[1] == active else "TWO VERSIONS" if p[1] in conflicts else "OTHER CORE" if p[1] in incompatible else "", "") for i, p in enumerate(slots)]
            cards.append(("+", f"Start a new game as “{empty_name}”. Your other slots keep their progress", "", ""))
            if queued:
                labels.append("Apply the queued change")
                cards.append(("»", "Once the game is closed", "", ""))
            active_index = next((i for i, slot in enumerate(slots) if slot[1] == active), None)
            if focus_active and active_index is not None:
                cursor = active_index
            focus_active = False
            info = [(None, f"IN USE · Slot {numbers.get(active, active_index + 1)} · {decode(slots[active_index][3])}", SLOT_GREEN)] if active_index is not None else ["No slot in use on this console."]
            if note:
                info.append((None, note[0], note[1]))
                note = None
            at = self.menu(title, labels, info=info, start=cursor, wide=True, slots=cards, keys=("x",), footer="A use slot   X options   B back   L / R: Page")
            if at is None:
                return
            cursor = at
            key = getattr(self, "menu_key", "a")
            if at >= len(slots):
                if at == len(slots):
                    args, done = ("new", identity, empty_name, "1"), "Now using a new empty slot. Your other slots keep their progress."
                else:
                    args, done = ("sync", identity, "1"), "Queued change applied."
            else:
                target = slots[at]
                name = decode(target[3])
                current = target[1] == active
                if current or key == "x":
                    actions = [] if current else [("switch", "Use this slot")]
                    if current:
                        actions.append(("duplicate", "Copy into a new slot"))
                    actions.append(("rename", "Rename"))
                    if current and active in conflicts:
                        actions.append(("keep-both", "Keep both versions"))
                    choice = self.menu(f"Slot {numbers.get(target[1], at + 1):02d} · {name}", [a[1] for a in actions], wide=True,
                                       info=["In use on this console" if current else "Not in use on this console"])
                    if choice is None:
                        continue
                    selected = actions[choice][0]
                else:
                    selected = "switch"
                if selected == "rename":
                    new = self.keyboard("Slot name", name)
                    if new:
                        self.in_thread(lambda: self.client("journeys", "rename", identity, target[1], new, timeout=30), "Saving slot name")
                    continue
                if target[1] not in cached:
                    note = ("That slot needs a download. Connect and open it again.", WARN)
                    continue
                if selected == "switch":
                    args, done = ("switch", identity, target[1], "1"), f"Now using {name}. Start the game to play it."
                elif selected == "duplicate":
                    args, done = ("duplicate", identity, f"{name} copy"[:80], "1"), f"Now using the copy. {name} stays as it was."
                else:
                    args, done = ("keep-both", identity, "Recovered progress", "1"), "Your progress is now in its own slot."
            if not self.journey_close_notice():
                continue
            result = self.in_thread(lambda: self.client("journeys", *args, timeout=180), "Changing slot")
            if result is None:
                note = ("Could not change slots. Your saves are kept.", BAD)
            else:
                text = " ".join("\t".join(p) for p in result)
                note = (text if "queued" in text.lower() else done, WARN if "queued" in text.lower() else SLOT_GREEN)
                focus_active = True
                cached_only = True

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


class Prompt(App):
    """The conflict screen alone, without the setup app's network work: the console script shows it before a game starts
    ("conflict LINE [start]") and reads the save kept on stdout ("device" or "server"; nothing: left for later)"""

    def __init__(self):
        self.screen = Screen()
        self.pad = Pad()
        self.script = [a.strip() for a in os.environ.get("ROMMANCER_UI_TEST", "").split(",") if a.strip()]
        self.clock = pygame.time.Clock()
        self.queue, self.wait_until = [], 0.0


def main():
    try:
        if len(sys.argv) > 2 and sys.argv[1] == "conflict":
            keep = Prompt().conflict_screen(sys.argv[2].split("\t"), start=sys.argv[3:4] == ["start"])
            if keep:
                print(keep)
            return 0
        App().run()
    finally:
        pygame.quit()


if __name__ == "__main__":
    sys.exit(main())
