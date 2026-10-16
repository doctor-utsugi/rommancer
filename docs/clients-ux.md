# Client UX guide

One structure, one vocabulary and one way of reporting for every Rommancer client: the console app (Onion's
`prompt` UI in `rommancer-sync.sh` and the pygame UI in `rommancer-ui.py`), the Android app and the desktop app.
A user who knows one knows the others.

## Language and vocabulary

The clients' UI is English only: no translations, no language detection, English dates and numbers.

| Concept | Word |
|---|---|
| save file (SRAM) | save |
| savestate | savestate |
| rom | game |
| this device | this console / this device / this PC |
| rom upload the server asked for | sending games to the server |
| delete roms in no list | delete games in no list |

- Never show log shorthand (`up`, `down`, `sync:`, `roms:`, `pull`, `prune`) to the user; the log is shown only in
  Status.
- Numbers with units (`1.2 GB`, `734 MB`), never raw KB.

## Home screen (same order everywhere)

Header, one fact per line:
1. `Rommancer Sync` and, small next to it, the client version.
2. The state line, the most urgent first:
   - `2 saves in conflict` (warning colour)
   - `Offline since 18:02`
   - `Synced: today, 18:52` / `Not synced yet`
3. Live work, only while it runs: `Downloading games 3/12` or `Sending games to the server 2/5`.

Items:
1. **Sync now**: everything (saves, settings, deletions, list games, sending games).
2. **Conflicts (N)**: only when N > 0. Warning colour and prominent (Android: a tinted button above Sync now; desktop: a
   banner at the top of Home besides the tab), one tap from choosing. N is refreshed as soon as a sync ends, so the
   entry is there right after it. With a single conflict, Android opens its screen directly.
3. **Watch game download** / **Watch games being sent**: only while one runs.
4. **Game lists**: tick lists; leaving after a change syncs. The screen also has **Download the lists' games now**.
   **Journeys** sits next to game-related actions on Android and pygame. Its first list shows the games that already
   have slots on this console, then the consoles (with the server's console names, not folder slugs); a console
   opens its games, a game opens its save slots. The lists look and move like Browse server games: one-line
   rows, the D-pad walks the whole list, L/R page, Y opens the search. The search field never takes the focus by
   itself: D-pad up reaches the search button, and only A or Y on it opens the keyboard. Typing edits a draft;
   Accept, the keyboard's Done or START applies it, and results are computed once per accepted query.
   The slot list fits on one screen: number, name, what it holds and its last update on one line, **IN USE**
   (green fill, border and badge) on the one this console uses. **A on a slot uses it at once**; A on the slot in
   use, or **X** on any, opens its options (use, copy into a new slot, rename, keep both versions). The last row,
   **Empty slot**, starts a new game straight away named after the date ("New game · 16 Oct 14:01"); renaming is
   in the options. A queued change shows as an extra row only while one waits.
   A successful change returns to the slot list with a one-line result above it, never a blocking screen.
   A game without slots on this console says what setting them up does (its current saves become a slot of their
   own, the other consoles' slots appear next to it) above one **Set up save slots** row.
   Slot numbers come from the server (creation order per ROM, archived slots included so no number ever moves), so
   every console and the web show the same number for a slot; synchronized identity is still the Journey UUID. A
   console only numbers a slot itself when the server sends none (older servers, offline).
   The web's Journeys tab lists slots in that order, asks which consoles a request goes to (all but those already on
   the slot ticked) and shows a request's state only while it is under way.
5. **Browse server games**: the server's games by system or by search, ticked one by one or a whole system, then a
   review and the download (docs/browse.md). The games already on the console are left out unless the toggle on top
   (`Show games already on this console: no/yes`) says otherwise. Hidden when the account may not download games.
6. **Settings** (submenu, see below).
7. **Status**: version, install date, account, server, last sync result (the summary below), last log lines.
8. **Exit** (consoles only; Android and PC use their system back/close).

## Paging and focus

- Android and pygame list screens accept **L/R** (L1/R1) and Page Up/Page Down. At the ends, stay on the
  first/last page. A selects and B returns one level. Search has a Y shortcut where available.
- Journey screens use the full viewport without the decorative save-point column. Android Journey lists share
  Browse's lazy list and pager; pygame's slot list pages by its visible row count.
- Desktop standard-gamepad shoulders generate page keys: the focused list handles them first, otherwise its
  scroll container pages and moves focus. Existing typing controls retain normal text input.
- Onion uses the firmware's native prompt binary; its button behavior is not changed by pygame/Android code.

Before anything replaces save files (using, copying or creating a slot, setting a game up), the client checks
whether an emulator runs. Android asks once through root or Shizuku when it has them: none running goes ahead
without asking; a running one (RetroArch keeps running after Close Content) shows **"RetroArch is open"** with
**Cancel** focused first and **The game is closed**; without a way to tell it asks **Is the game closed?** with
**Yes, continue** first. These are rows of the screen, not a dialog window, so the pad's A and B work on them
like anywhere else. Linux checks the processes and only asks when it cannot tell. Entering from ES-DE alone is
not evidence that another emulator has closed.

## Settings (submenu)

Each toggle reads `Name: yes/no` and says what it does in one line under it where the UI has room (pygame, Android,
desktop) or in the menu message (Onion).
- Sync before each game, Ask about conflicts before a game (consoles; both on by default)
- Upload saves when saved (Android, PC)
- Server may request games
- Server SSH access (consoles)
- Delete games in no list
- Delete saves of deleted games (N)
- WiFi networks / emulator settings (where the platform has them)
- Account: `user @ server`, **Disconnect this console** (always asks first)

## Sync summary

Clients print machine-readable summary lines (`sum<TAB>key<TAB>n[<TAB>extra]`) next to their log lines; each UI
renders them, **one fact per line, only facts that are not zero**:

| key | Shown |
|---|---|
| `saves-up` n | ↑ n saves sent to the server |
| `saves-down` n | ↓ n saves received |
| `states-up` / `states-down` | ↑/↓ n savestates … |
| `games-down` n | ↓ n games downloaded |
| `games-sent` n | ↑ n games sent to the server |
| `games-deleted` n | n games deleted (in no list) |
| `saves-cleaned` n | n saves of deleted games removed |
| `games-stopped` | Game download stopped |
| `games-nospace` name | No room for "name" |
| `games-show` platform | When the downloaded games show in the frontend (docs/browse.md) |
| `conflicts` n | ⚠ n saves in conflict |
| `errors` n | ⚠ n errors (Show details) |

A sync the user started on screen (Sync now, a list change, a conflict choice) that ends with `conflicts` n > 0 goes
straight to the conflict screens at the end of the same window instead of the summary (the summary stays in Status),
and after each choice shows the next one until none are left. Android opens the first conflict; the desktop app opens
Conflicts. **Later** (Android: Back, then Later; desktop: Decide later) leaves them for the home entry. Syncs nobody
is watching (watch service, background, polling) never open anything: they keep the notification and the state line.

Nothing at all: **All up to date**. Title of the result screen: the action (`Sync now`). Errors keep the existing
reason + **Show details**.

## Progress

Steps are numbered so the bar never seems to go backwards: `Step 2 of 4 · Saves`. Lines:
1. Step title (`Saves`, `Settings`, `Games in no list`, `List games`, `Sending to the server`).
2. What it does now (`Transferring saves 3/7`).
3. The bar with its percent.
4. The current file on its own line, with its own percent or size.
Hints (`B to stop`) go in the footer, never in the text.

## The PC is a device

The desktop app gets **This PC** at the top of its sidebar, with the same home screen as a console:
- linking it creates a device of console "PC" with the RetroArch it finds (saves and states folders read from
  `retroarch.cfg`) and a folder for list games the user picks;
- it syncs on its own like a console: watching the save folders, polling the server, every 15 minutes;
- its lists, conflicts, deletions and sending games work like on a console.

Cards and folders of other consoles stay below, under **Console cards**.
