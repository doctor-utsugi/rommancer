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
   `system<TAB>slug<TAB>games<TAB>bytes<TAB>here<TAB>name<TAB>newBytes` per system with sendable games that this
   device's layout knows (layouts with an empty system map: every system). games = sendable games, bytes = their size,
   here = how many of them are on the device or queued, newBytes = the size of the games not here yet (what can still
   be downloaded: games − here games, newBytes). Clients reading a server without the 7th field take
   `bytes × (games − here) / games`.
2. `GET /agent/browse/games?system=SLUG&q=TEXT&offset=N&limit=M&show=new` → `total<TAB>n`, then
   `game<TAB>id<TAB>bytes<TAB>state<TAB>system<TAB>title`, state `here` | `queued` | `new`. Without `system`: every
   system the device knows. Without `q` (or under 2 characters): by title. With `q`: fuzzy ranking. limit ≤ 200 (50).
   `show=new` leaves out the games here or queued (total counts what is left); the clients send it unless the
   "show games already on this console" toggle is on.
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

States: `Contacting the server...`, `Searching the server…` (a search pending or in flight), `The server has no games
to send yet`, `No games match "q"`, `Every game here is on this console already or downloading soon` (a list empty
with the toggle off), `Could not reach the server` (+ details), `Your account cannot download games` (and the home item
is hidden once `denied` was seen).

Games already on the console (all clients): hidden by default. Onion has a toggle row on top of the systems screen and
of every games screen (system or search) reading `Show games already on this console: no` / `yes`; pygame, Android and
the desktop app have the `Hide owned` chip in the top bar instead (on = `no`). One setting for the whole browse session,
starting with them hidden. Toggling a games screen asks the server for the list again (with or without
`show=new`). With it off, systems with nothing left to download are left out. With it on, the states read `on this
console` (here) and `downloading soon` (queued), dimmed and not tickable; the words here/queued never show on screen.

System rows (all clients) show what can still be downloaded: `Super Nintendo  112 to download · 1.1 GB` (games − here,
newBytes), `(12 on this console)` after it when here > 0 and it fits (pygame, Android; Onion drops it), and `all on this
console` for a system with nothing left (shown only with the toggle on).

### pygame UI (`rommancer-ui.py`)
- Home item **Browse server games** after Game lists. Gamepad only, laid out for 640x480 and up (sizes scale with the
  screen's height).
- The browse screens are one widget, `browse_list()`, with the Android/desktop layout and no title or save point:
  - **Top bar, one line**: where this is (`Server games`, or the system), a drawn magnifier (ring and handle) and the
    `Hide owned` chip (a drawn tick while on; on by default). UP from the first row moves into the bar, LEFT/RIGHT
    between the magnifier and the chip; the focused one is filled with the accent, like the cursor row (which is then
    only outlined). A on the chip toggles it; A on the magnifier, or Y anywhere, opens the search.
  - **Search in the bar**: the field takes the place of the magnifier and the chip (hidden meanwhile), with the
    magnifier inside it, the placeholder `Search Super Nintendo…` / `Search every system…`, and the drawn spinner at
    its right end while the debounce runs or the request is out. Typing uses the on-screen keyboard, drawn over the
    bottom of the list (bar, section line and about six rows stay in sight at 480p); the list filters on the server as
    typed (debounce from text edits only), the old answer faded until the new one comes, and only the latest query's
    answer shows. Keyboard keys: `A key  B delete  X shift  Y space  START results  SELECT close`; B on an empty field
    closes the search too. START moves the focus to the results (searching at once if the text changed); there Y or A
    on the field edits again, and B closes the search and clears it (back to the system's games, or to the systems).
    In a system the search is limited to it; from the systems screen it searches every system (its own screen, opened
    with the keyboard, the system's name on each row).
  - **Section line** under the bar, upper case: `SYSTEMS · 10 WITH GAMES TO DOWNLOAD` (`SYSTEMS · 12` with owned games
    shown), `GAMES · 236`, `RESULTS · 6 GAMES`, or the spinner with `SEARCHING THE SERVER…` (`LOADING…` for a system's
    first page), with the list's own key on the right (`X tick all`, `L1/R1 page`).
  - **Rows** on one line, the cursor row a filled accent bar with its texts in the background colour. A row's right
    text may be a tuple of choices, longest first (the first that leaves the label whole shows). Systems: `[x] Super
    Nintendo  112 to download · 1.1 GB  (12 on this console)`; games: `[x] Title  4 MB`, with owned games shown `on
    this console`/`downloading soon` dimmed and not tickable. A tail line, never selected, says `Loading…`, `No games
    match "xyz"`, `Could not reach the server` (A tries again) and the like.
  - **Fixed footer**: `N games selected · size` with a `START` cap and `review` when something is ticked, else the
    keys: `A open  X tick all  Y search  B back` (systems), `A tick  L1/R1 page  Y search  B back` (games), `A tick
    L1/R1 page  Y edit  B close the search` (a system's search).
- Paging: L1/R1 (`pageup`/`pagedown`: added to the fallback map, buttons 4/5, and to the keyboard map) move a page;
  the next page loads in a background thread when the selection gets near the end; no wrap. X ticks a whole system,
  START opens the review from any screen, B leaves (asking first when something is ticked).
- Held d-pad/hat/stick repeats (300 ms, then every 60 ms) in `next_action`, for every screen.
- `ROMMANCER_SEARCH_DEBOUNCE` (default 2.0) and a `wait:SECONDS` token in `ROMMANCER_UI_TEST` for tests (with `up`,
  `down`, `left`, `right`, `a`, `b`, `x`, `y`, `start`, `select`, `pageup`, `pagedown` and `type:TEXT`).
- Network calls run in threads; the shell's `browse-games` uses `http_once` and a short timeout.

### Onion (shell + `prompt`/`kbinput`)
- No X/Y on `prompt`: explicit rows. Systems menu: the toggle row, `Search the server...`, `Download selected (3 · 48
  MB)` (when any), the systems (`[x] Super Nintendo  112 to download · 1.1 GB`, `[-]`/`[ ]`), `Back`. A system: the
  toggle row, `Select all 112 games (1.1 GB)` (the games not here yet; no row when there are none) / `Unselect all`,
  `Download selected`, up to 90 games, `More…`, `Back`. The toggle is `B_ALL`; the systems shown are
  `$WORK/browse-systems.shown`. The selection lives in `$WORK/browse-sel`. The cursor stays on the toggled row (`-s`).
- Search: `kbinput` (no live typing on Onion: it runs when the keyboard closes), then the results as a games menu; a
  `Searching the server...` panel shows while the request runs.

### Shell commands (both Linux UIs)
`browse-systems`, `browse-games SLUG|- OFFSET QUERY [LIMIT [new|all]]` (`new`, the default, sends `show=new`),
`browse-check FILE`, `browse-add FILE` (FILE: selection lines), `browse-get` (roms then sync, with progress, prints the
summary and `games-show`). Space measured on the roms folder from `/agent/roots` (cached in `$STATE/roms-root`),
walking up to an existing parent.

### Android
- Home item **Browse server games** after Game lists. Browse screens have their own root without the outer
  `verticalScroll`, and take the whole screen (no app title, no save point): a `LazyColumn` with `weight(1f)` between
  the top bar and a fixed footer.
- Top bar on one line, as on the desktop: back, where this is (`Browse server games`, the system, `All systems`), a
  magnifier and the `Hide owned` chip (on by default; off shows the games already here). The magnifier (or Y) turns
  into the search field in the bar, hiding the chip: it filters as typed (2 s debounce; the IME Search key searches at
  once and moves focus to the results), a spinner inside it while the debounce runs or the request is out, the list
  faded until the answer comes. X or B closes it (and clears it); on the systems screen the magnifier opens the search
  over every system. Every bar button is a focus stop, filled while focused.
- Under the bar the section line (`SYSTEMS · 10 WITH GAMES TO DOWNLOAD`, `GAMES · 236`, `RESULTS · 1 GAME`, or the
  spinner with `SEARCHING THE SERVER…`) with the list's own key on the right (`X tick all`, `L1/R1 page`).
- Rows on one line, the cursor row filled with the accent: tick, title, the system (searching every system), size or
  `On this console` (green ✓) / `Downloading soon` (↓). A tap on the row opens a system / ticks a game; a tap on the
  box ticks a whole system.
- Footer: `N games selected · size` with **Review download · START**, or the keys' hint when nothing is ticked.
- Keys: A opens a system / ticks a game, X ticks a whole system, Y opens the search, START opens the review, L1/R1
  page. Initial focus on the first row (no keyboard popping up). The activity resizes for the keyboard
  (`adjustResize`).
- Selection held in `Linked`; Back: games → systems → home (asking first when something is ticked).
- Space: `SyncEngine.space()` (roms folder from `/agent/roots`, nearest existing parent, StatFs); sent on check, add
  and `/agent/roms`. Without a measurement the add is refused client-side.
- Download: `roms()` then `sync()`, the existing progress screen, then Result with the `games-show` line.

### Desktop app (`clients/desktop`)
- Tab **Browse server games** after Lists, on this PC and on every linked card (`src/Browse.tsx`). Each device browses
  as itself (its token); the Rust commands are `browse_systems`, `browse_games` (`all`: no `show=new`), `browse_check`
  and `browse_add` (`src-tauri/src/browse.rs`).
- Top bar on one line: back, the breadcrumb (`Server games › system`), a magnifier that turns into the search field
  (it takes the place of the `Hide owned` / `Show owned` chip; owned games hidden by default), with `Searching the
  server…` and a spinner inside it while the 2 s debounce runs or the request is out; Enter searches at once, Escape or
  X closes it and clears the search. Under it the section line (`SYSTEMS · 18 with games to download`, `RESULTS · 6
  games`), then dense one-line rows; games page by `offset` (100) as the end of the list comes into view.
- Keys: arrows / PageUp / PageDown / Home / End move the filled cursor row, Space ticks, Enter opens a system (ticks a
  game), `/` or Ctrl+F opens the search, Escape or Backspace goes back. Everything works with the mouse too.
- A fixed footer with `N games selected · size` and **Review download**: the server's check in a dialog, then
  `browse_add`. Space: the roms folder this PC knows (a card: the server's roms folder), nearest existing parent,
  measured on `check`, `add` and `/agent/roms`; without a measurement the add is refused here.
- Download: a `games` sync (the list games, then the inventory pass), queued after a sync already running; on this
  PC the frontends' collections are written and ES-DE/Pegasus are named to restart, as after a full sync.
