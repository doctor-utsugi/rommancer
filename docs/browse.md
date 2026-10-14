# Browsing the server's games from a console

Rommancer Sync (Android app, Linux console client: Onion shell UI and pygame UI) lets the player browse the games the
server can send, by system or by a fuzzy name search, tick several games or whole systems, and download them to the
console. The player never manages a list, and the games show in the console's frontends afterwards.

## Where the picks live

Each device has one list of games picked for it: `Device.picksListId` → `List` (`kind = 'device'`, named
`→ <device name>`, renamed with the device). It is the same list the web app's "send to device" (`POST
/devices/:id/send`) fills, so both go through one helper (`devices/picks.ts`). The list is (re)assigned to the device
whenever games are added. An older `→ <name>` list assigned to the device is adopted the first time.

Being a list given to the device, the picks get the existing machinery: the download plan and its space budget
(`devicePlan`, `/agent/roms`), protection from "delete games in no list", the web app's progress, removal from the
web app (or unticking the list in Game lists), and a frontend collection.

Items are stored as roms (`r<romId>`) or romhacks (`h<hackId>`) through `toRomItems`, as the web's own list adds, so
what browse lists, what it sizes and what downloads are the same file. Games already on the device (any version, by the
inventory's game) or already planned by one of its lists are never added again.

A whole system is expanded when it is picked: every sendable game of that system that is neither here nor queued, one
version each (the best rom, as `toRomItems` picks it). Games the server gets later are not added.

A picked game whose system the device's filter leaves out turns that system back on for the device
(`excluded` minus it, `known` plus it) and a picked game left out by hand is given back (`excludedGames` minus it); the
space check counts what that brings from the other lists too.

## Agent endpoints (device token, plain text, always HTTP 200 for outcomes)

The shell client runs curl with `-f`, so outcomes the UI shows (no permission, no space) are text lines, not HTTP
errors. Every browse endpoint answers `denied` (one line) when the device's owner lacks `roms.download`.

`X-Space: <free> <total>` (bytes, measured live on the roms folder or the nearest existing parent) is accepted by
`check`, `add` and `GET /agent/roms`, and stored on the device like `/agent/sync` does, so the check and the download
budget use the same numbers.

1. `GET /agent/browse/systems` →
   `system<TAB>slug<TAB>games<TAB>bytes<TAB>here<TAB>name` per system with sendable games that this device's layout
   knows (layouts with an empty system map: every system). games = sendable games, bytes = their size, here = how many
   of them are on the device or queued.
2. `GET /agent/browse/games?system=SLUG&q=TEXT&offset=N&limit=M` → `total<TAB>n`, then
   `game<TAB>id<TAB>bytes<TAB>state<TAB>system<TAB>title`, state `here` | `queued` | `new`. Without `system`: every
   system the device knows. Without `q` (or under 2 characters): by title. With `q`: fuzzy ranking. limit ≤ 200 (50).
3. `POST /agent/browse/check` body lines: `game<TAB>id`, `system<TAB>slug`, `skip<TAB>id` (a game unticked inside a
   ticked system). Answer:
   - `need<TAB>bytes<TAB>games` — what the selection adds (new games only)
   - `have<TAB>games` — picked games already here or queued (skipped)
   - `pending<TAB>bytes` — what the device's lists still have to download before (with the filter after the change)
   - `space<TAB>usable<TAB>free<TAB>kept` — usable = free − kept, kept = max(reserve, 50 MB)
   - `fits<TAB>1|0`, fits = need + pending ≤ usable; when space is unknown: `fits<TAB>0` and `space<TAB>-`
4. `POST /agent/browse/add` same body → runs the same check; when it does not fit, the check's lines plus `nospace`
   and nothing changes; otherwise `added<TAB>games<TAB>bytes`. The client then downloads (`roms`) on screen.

`devicePlan`'s budget keeps the same `kept` (max(reserve, 50 MB)), so a download the check accepted is not cut by the
clients' per-file 50 MB margin.

## Fuzzy search

`modules/browse/index.ts` keeps the sendable games in memory: `{gameId, romId|hackId, systemSlug, title, bytes,
norm, tokens, trigrams}`. Rebuilt in the background when older than 2 minutes and the cheap signature
(`COUNT(*)`, `MAX(id)` of RomFile and RomHackFile) changed; requests are served from the previous index meanwhile.
Sizes follow `devicePlan`: the files `romFiles()` copies, `stat` for plain files, the parts' sum for archive entries.

Normalisation: lowercase, accents stripped, `&` → `and`, punctuation and brackets → space, roman numerals II–XX →
digits, `the`/`a`/`an` dropped. Each query token scores against the title's tokens: equal (best), prefix, substring,
then trigram Dice ≥ 0.45 (typos); acronyms of the title ("ff7", "smb3") and the query's tokens glued together
("mega man" ~ "megaman") count too. Every query token must match something; results sort by score, then title.

## Clients

Debounce: the search goes out **2 s** after the last edit of the text (the user's request); START / the keyboard's
Search key searches at once. The UI shows the pending state at once ("Searching…") so the wait reads as intended, and
only the answer to the latest query is shown (generation counter).

Selection model (all clients): `games` (id → bytes) and `systems` (slug → unticked ids). A system row is tri-state:
`[ ]`, `[-]` some games ticked, `[x]` all. Ticking a system clears its single game ticks. The running total in the sub
line is approximate; the review step shows the server's check.

Review before every download (all clients): `Download N games (1.2 GB)?`, `Usable space: 3.8 GB (10.2 GB free, 6.4 GB
kept free)`, `Already waiting from your lists: 1.1 GB` when pending > 0, a whole system says `all N games, one version
each; games the server gets later are not included`, and above 50 games or 2 GB: `This may take a long time: keep the
console charged`. No space: `Not enough space: needs 8.0 GB, 3.8 GB usable` (+ the pending line) and nothing is added.
Leaving browse with a selection asks `Discard N selected games?`.

After the download: `roms` then an inventory pass (`sync`), so "here" marks and the list's collection are right. The
result screen adds one fact about when the games show (`games-show` summary line, per platform):
- Onion, Knulli, Batocera, ROCKNIX: they show in the game list when you close Rommancer Sync
- ArkOS: EmulationStation restarts to show them when you close Rommancer Sync
- muOS, NextUI: they show in the game list
- Android ES-DE: close ES-DE and open it again to see them (with Shizuku ready: a **Restart ES-DE** button); Daijishō:
  sync their platforms in Daijishō

States: `Contacting the server...`, `The server has no games to send yet`, `No games match "q"`, `Could not reach the
server` (+ details), `Your account cannot download games` (and the home item is hidden once `denied` was seen).

### pygame UI (`rommancer-ui.py`)
- Home item **Browse games** after Game lists.
- `pick_list()` widget: returns (action, index) for a, x, y, start, b, keeps its scroll, pages with L1/R1
  (`pageup`/`pagedown`: added to the fallback map, buttons 4/5, and to the keyboard map), loads the next page in a
  background thread when the selection gets near the end (`Loading…` row), no wrap in paged lists.
- Held d-pad/hat/stick repeats (300 ms, then every 60 ms) in `next_action`, for every screen.
- Systems: `Search…` first, then `[x] Super Nintendo  124 · 1.2 GB  (12 here)`. Footer `A open  X tick all  Y search
  START download  B back`.
- Games: `[x] Title  4 MB`, `here`/`queued` dimmed and not tickable. Footer `A tick  L1/R1 page  Y search  START
  download  B back`.
- Search: its own screen; the keyboard with one status line under the field (`Searching…`, `12 games match`, `No
  games match "xyz"`); START opens the results (a Games list with the query in the sub line); Y or B there go back to
  the keyboard with the text kept. Debounce from text edits only. `ROMMANCER_SEARCH_DEBOUNCE` (default 2.0) and a
  `wait:SECONDS` token in `ROMMANCER_UI_TEST` for tests.
- Network calls run in threads; the shell's `browse-games` uses `http_once` and a short timeout.

### Onion (shell + `prompt`/`kbinput`)
- No X/Y on `prompt`: explicit rows. Systems menu: `Search…`, `Download selected (3 · 48 MB)` (when any), the systems
  (`[x]`/`[-]`/`[ ]`), `Back`. A system: `Select all 124 games (1.2 GB)` / `Unselect all`, `Download selected`, up to 90
  games, `More…`, `Back`. The selection lives in `$WORK/browse-sel`. The cursor stays on the toggled row (`-s`).
- Search: `kbinput` (no live typing on Onion: it runs when the keyboard closes), then the results as a games menu.

### Shell commands (both Linux UIs)
`browse-systems`, `browse-games SLUG|- OFFSET QUERY`, `browse-check FILE`, `browse-add FILE` (FILE: selection lines),
`browse-get` (roms then sync, with progress, prints the summary and `games-show`). Space measured on the roms folder
from `/agent/roots` (cached in `$STATE/roms-root`), walking up to an existing parent.

### Android
- Home item **Browse games** after Game lists. Browse screens have their own root without the outer `verticalScroll`
  (a `LazyColumn` with `weight(1f)`, header above, hint/selection bar below).
- Keys: A opens a system / ticks a game, X ticks a whole system, Y focuses the search, START opens the review, L1/R1
  page. Initial focus on the first row (no keyboard popping up); the IME Search action searches at once and moves focus
  to the results. One focus stop per row.
- Selection held in `Linked`; Back: games → systems → home (asking first when something is ticked).
- Space: `SyncEngine.space()` (roms folder from `/agent/roots`, nearest existing parent, StatFs); sent on check, add
  and `/agent/roms`. Without a measurement the add is refused client-side.
- Download: `roms()` then `sync()`, the existing progress screen, then Result with the `games-show` line.
