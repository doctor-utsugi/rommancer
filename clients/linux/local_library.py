import re
import unicodedata

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


def normalize(text):
    text = "".join(c for c in unicodedata.normalize("NFD", text.lower()) if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", " ", text, flags=re.UNICODE).strip()


def matches(query, *values):
    haystack = normalize(" ".join(values))
    return all(word in haystack for word in normalize(query).split())


def library_rows(games, system=None, query=""):
    result = []
    if system is None:
        for slug in sorted({g[3] for g in games}, key=system_name):
            if not query.strip() or matches(query, slug, system_name(slug)):
                result.append(("system", slug, system_name(slug), f"{sum(g[3] == slug for g in games)} games"))
    if system is not None or query.strip():
        result.extend(("game", g[1], g[2].rsplit(".", 1)[0], system_name(g[3]))
                      for g in sorted(games, key=lambda row: row[2].lower())
                      if (system is None or system == g[3]) and matches(query, g[2], g[3], system_name(g[3])))
    return result


def page_target(index, direction, count, size):
    return max(0, min(max(count - 1, 0), (index // max(size, 1) + direction) * max(size, 1)))


def page_bindings(mapping):
    aliases = {"leftshoulder": "pageup", "rightshoulder": "pagedown", "l1": "pageup", "r1": "pagedown"}
    return {aliases.get(name, name): value for name, value in mapping.items()}
