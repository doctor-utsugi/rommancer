import re
import unicodedata
from datetime import datetime

SYSTEM_NAMES = {
    "gba": "Game Boy Advance", "gb": "Game Boy", "gbc": "Game Boy Color", "nes": "NES / Famicom",
    "snes": "Super Nintendo", "md": "Mega Drive / Genesis", "sms": "Master System", "gg": "Game Gear",
    "n64": "Nintendo 64", "nds": "Nintendo DS", "psx": "PlayStation", "psp": "PlayStation Portable",
    "pce": "PC Engine", "a2600": "Atari 2600", "a7800": "Atari 7800", "lynx": "Atari Lynx",
    "ngp": "Neo Geo Pocket", "ngpc": "Neo Geo Pocket Color", "ws": "WonderSwan", "wsc": "WonderSwan Color",
    "unknown": "Other consoles",
}


def system_name(slug):
    return SYSTEM_NAMES.get(slug, slug.upper())


def slot_updated(value):
    try:
        date = datetime.fromtimestamp(int(value)).astimezone() if value.isdigit() else datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
        return "Updated: " + date.strftime("%d %b %Y · %H:%M")
    except (ValueError, OverflowError, OSError):
        return "Update date unavailable"


def normalize(text):
    text = "".join(c for c in unicodedata.normalize("NFD", text.lower()) if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", " ", text, flags=re.UNICODE).strip()


def matches(query, *values):
    haystack = normalize(" ".join(values))
    return all(word in haystack for word in normalize(query).split())


def game_system_name(game):
    """GAME rows carry the server's console name fifth; older servers sent only the slug"""
    return game[4] if len(game) > 4 and game[4] else system_name(game[3])


def plural(n, word):
    return f"{n} {word}" + ("" if n == 1 else "s")


def library_rows(games, system=None, query="", enrolled=()):
    """Without a query the top level lists the games with slots (ENROLLED rom ids) first, then the consoles"""
    result = []
    names = {g[3]: game_system_name(g) for g in games}
    ordered = sorted(games, key=lambda row: (row[1] not in enrolled, row[2].lower()))
    if system is None and not query.strip():
        result.extend(("game", g[1], g[2].rsplit(".", 1)[0], names[g[3]] + " · Slots ready") for g in ordered if g[1] in enrolled)
    if system is None:
        for slug in sorted(names, key=lambda s: names[s].lower()):
            if not query.strip() or matches(query, slug, names[slug]):
                result.append(("system", slug, names[slug], plural(sum(g[3] == slug for g in games), "game")))
    if system is not None or query.strip():
        result.extend(("game", g[1], g[2].rsplit(".", 1)[0], ("Slots ready" if g[1] in enrolled else "") if system else names[g[3]] + (" · Slots ready" if g[1] in enrolled else ""))
                      for g in ordered
                      if (system is None or system == g[3]) and matches(query, g[2], g[3], names[g[3]]))
    return result


def page_target(index, direction, count, size):
    return max(0, min(max(count - 1, 0), (index // max(size, 1) + direction) * max(size, 1)))


def page_bindings(mapping):
    aliases = {"leftshoulder": "pageup", "rightshoulder": "pagedown", "l1": "pageup", "r1": "pagedown"}
    return {aliases.get(name, name): value for name, value in mapping.items()}


class LocalSearch:
    def __init__(self, games, system=None, enrolled=()):
        self.games, self.system, self.enrolled = games, system, enrolled
        self.applied = ""
        self.rows = library_rows(games, system, enrolled=enrolled)

    def accept(self, draft):
        query = draft.strip()
        if query != self.applied:
            self.rows = library_rows(self.games, self.system, query, self.enrolled)
            self.applied = query
        return self.rows
