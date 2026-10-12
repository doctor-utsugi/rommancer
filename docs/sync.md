# Rommancer Sync

Rommancer Sync keeps emulator saves and save states in step across handhelds and PCs, Steam Cloud style.
Each console runs a small client that talks to a self-hosted Rommancer server.

## How a console is set up

Everything happens on the console, with the gamepad:

1. Install the client (see below) and open **Rommancer Sync** (Apps on Onion, Ports on Knulli/Batocera).
2. Enter the server address with the on-screen keyboard.
3. **Log in** with a Rommancer account, or **create an account** if the server allows sign-up
   (Administration > Users > Open sign-up).
4. The console registers itself, runs a first sync and keeps syncing in the background.
   It starts again at power-on.

The same menu offers *Sync now*, *Status* and *Unlink this console*.

Alternatives for unattended setups:

- **Installer package**: Devices > *Onion installer* / *Knulli / Batocera installer* in the web app downloads a
  zip that already carries the server address and a one-time enrolment token (valid 30 days, one console).
  Unzip it on the SD card (Onion, NextUI), the `share` folder (Knulli/Batocera) or the EASYROMS partition
  (ArkOS); the console links itself. The ArkOS and NextUI packages are in Guides & downloads.
- **Pairing code**: `rommancer-sync.sh link SERVER` shows a code to approve at `SERVER/link`.

## Clients

| Platform | Client | Setup screen |
|---|---|---|
| Onion (Miyoo Mini) | `clients/linux/rommancer-sync.sh` | `rommancer-sync.sh setup`, built on Onion's `prompt` menu and `kbinput` keyboard |
| Knulli, Batocera, ROCKNIX | `rommancer-sync.sh` + `rommancer-ui.py` | pygame app; buttons come from EmulationStation's `es_input.cfg` |
| ArkOS, dArkOS | `rommancer-sync.sh` in `/roms/rommancer`, launcher in Options > Tools | the launcher links, installs and syncs (runs the client with `sudo`) |
| NextUI | `rommancer-sync.sh` in `/mnt/SDCARD/rommancer`, `Tools/<platform>/Rommancer Sync.pak` | the pak links, installs and syncs |
| muOS, PCs | `rommancer-sync.sh` | command line (`link`, `sync`, `daemon`) |
| Android | `clients/android` (Kotlin, Compose) | two-column screen like the pygame app, gamepad navigation |
| SD card only (Nintendo DS with TWiLight Menu++, consoles without network) | `rommancer-sync.sh sd MOUNT` on a computer | command line |

The shell client is POSIX `sh` for busybox: it needs `curl` (or `wget`), `sha1sum` and `base64`.
It ships `cacert.pem` because some firmwares (Onion) have `curl` without root certificates, and it sets the
clock by NTP when it is clearly wrong (consoles without a battery-backed clock boot in the past and TLS fails).

Client commands: `setup`, `link SERVER`, `enroll`, `sync`, `daemon`, `boot`, `install`, `status`, `unlink`, `hints`.

### When saves are uploaded

- **Linux daemon**: checks sizes and mtimes of the save files every 15 s and syncs once they have stayed unchanged
  for 3 s (an emulator may still be writing). Knulli/Batocera also sync right after a game ends (`gameStop` event)
  and fetch the server's saves right before it starts. ArkOS does the same through EmulationStation's
  `game-start`/`game-end` scripts (`~/.emulationstation/scripts/`), with the daemon as a systemd service, and
  NextUI through its hooks (`.userdata/<platform>/.hooks/boot.d`, `pre-launch.d/*.sync.sh`, `post-launch.d`).
- **NextUI names**: minarch keeps saves in `Saves/<tag>/<rom file with its extension>.sav` (the tag is the text
  in the roms folder's last parentheses) and states in `.userdata/shared/<tag>-<core>/<rom file>.st0`..`.st7`,
  `.st9` being the auto-resume one (layout `minui`). Only its default save format (*MinUI*) is understood. Saves
  are shared with RetroArch consoles; states only between NextUI consoles with the same core.
- **Android**: a foreground service (`WatchService`, with a silent notification) watches the save folders with
  `FileObserver` and syncs 5 s after the last write; it also polls the server every 15 s for requests from the web
  app and starts at boot. WorkManager runs a full pass every 15 minutes as a fallback. Menu: *Upload when saving*.

### Copying a console's games to the server

The device page shows how many games the console has that a database knows and the collection lacks, and how
the collection's completeness would change (overall and in the console's systems). *Copy all* queues one request
per file (`DevicePull`); the console sends them one at a time:

- The Linux daemon sees `pull` in its 15 s poll and starts `rommancer-sync.sh pulls` as a separate process, so
  saves keep syncing during a long copy; Android runs it on its own thread. Over SSH the server runs `pulls` itself.
- A transfer cut halfway (console off, network gone, client killed) puts the request back to `pending` on the
  server: the body must reach its `Content-Length` before anything is stored. Stalled uploads (under 1 KB/s for a
  minute) are dropped by the client and sent again later. A file gone from the device is reported (`X-Missing`) and
  closed instead of retried.
- On Knulli/Batocera copies wait while a game runs (`game-start`/`game-stop` events, checked against a running
  emulator so a crashed game does not pause them forever).
- `GET /devices/:id/pull-progress` reports files, bytes, the file being received and its bytes so far;
  `DELETE /devices/:id/pulls` cancels what has not been sent.

### The server's SSH channel

The server can also reach a console itself, over SSH, and run the same client there (one sync algorithm,
whichever side starts it):

- **Consoles with the app**: when an SSH server listens on port 22 and *Server SSH access* is on (`ALLOW_SSH=1`,
  the default), the client adds the server's public key (`GET /agent/ssh-key`) to the console's
  `~/.ssh/authorized_keys` and reports `X-Ssh: user@address:22` and its own path (`X-Client-Path-B64`) on every sync.
  Turning the option off removes the key and reports `X-Ssh: 0`.
- **Consoles without the app**: Devices > *Add over SSH* (admins). The server logs in (password only the first time,
  or the server key added by hand), copies the client and its link, installs the server key, hooks the client to
  boot and runs a first sync; the password is then dropped. An address typed there is kept (`sshManual`) even when
  the console reports another one (NAT, VPN).
- **When**: every minute the server looks at admins' consoles with SSH whose daemon has been quiet for 2 minutes.
  It runs `rommancer-sync.sh all` and `pulls` over SSH right away when the web app asked for something since the
  last attempt (*Refresh now*, roms to bring), and every 10 minutes otherwise. *Sync over SSH* on the device page
  runs it on demand. The client's own lock keeps an SSH run and the daemon from syncing at the same time.
- The key pair (RSA, PKCS#1) is created on first use and kept encrypted in the `Setting` table.

### SD cards synced from a computer

For consoles that only have an SD card, the card itself is the device:

```
rommancer-sync.sh sd /media/me/DSCARD link https://rommancer.example.com   # once: approve the code in the web app
rommancer-sync.sh sd /media/me/DSCARD                                      # every time the card is inserted
```

The link, settings and hash cache live on the card (`.rommancer/`), so any computer with the script can sync it.
A pass uploads changed saves, downloads newer ones, sends roms the server asked for and copies the roms of the
card's lists. The mount point changes between computers: the client sends it in `X-Device-Root-B64` and the server
updates the device's root before resolving paths. The default firmware is `nds-twilight` (roms in `roms/nds`, saves
in `roms/nds/saves`, layout `rom-saves`); set `ROMMANCER_FIRMWARE`/`ROMMANCER_MODEL` for other cards.

### Protocol details added later

- Rom lines carry the file size as a fifth field: `rom<TAB>path<TAB>sha1<TAB>headerless sha1<TAB>size` (empty hashes for
  files too big to hash). Older clients send four fields; the server then uses the catalog's size when it knows the rom.
- `GET /link/android/version` (`code`, `name`, `size`) and `/link/android/rommancer-sync.apk`: the Android app offers
  *Update the app* when the server has a higher version code (`clients/android/release/version.txt`, "<code> <name>").
- Layouts defined by the user in the desktop app are device overrides on the generic `retroarch-desktop` firmware;
  `systemMapOnly: true` makes the device hold just its own systems (a one-system card). Systems without an emulator in
  the map use RetroArch's usual core for them (`raDefaults`).
- Systems: 89, from libretro-database (No-Intro cartridges, Redump discs, FBNeo); their DATs download by themselves
  (`dats/presets.ts`) and the committed seed carries them for a fresh server.

### Savestates: screenshots, core versions and sharing

- **Screenshots.** RetroArch writes `<state>.png` beside each state when `savestate_thumbnail_enable` is on
  (Batocera and Knulli turn it on at every launch; on Onion, muOS, ArkOS and Android Rommancer sets it with the
  user's other console settings). NextUI's minarch keeps one per slot in
  `.userdata/shared/.minui/<tag>/<rom file>.<slot>.bmp` (PNG data despite the name). The client sends it after the
  state and writes the server's copy beside a state it receives, so the emulator's menu shows the right picture.
  Standalone emulators (PPSSPP, DuckStation...) are left out.
- **Core versions.** The shell client reads RetroArch's core info files (`libretro_info_path` from
  `retroarch.cfg`, then the usual folders) and reports each core's `display_version`. Every state version keeps
  the version of the core that made it; the web app warns when another console of the user has a different one,
  because a state may not load there. States still sync: the console's previous file stays in the history.
  Android cannot read RetroArch's core folder, and SD cards synced from a computer have no cores to read.
- **Sharing.** Any version of a save or state can be shared with every user of the server, with a note. Others
  see it in the game's *Saves* tab (or *Saves > Shared*) with its screenshot and core version, and copy it into
  their own saves: a state into the slot they pick (same emulator only), a save into the one they already have
  for the game, converted to its emulator's format. Whatever they had becomes history. Shared versions are kept
  past the 50-version history limit until their owner stops sharing them.

### Memory cards (PS1)

A memory card is a container: a small filesystem whose entries are the saves of several games. Rommancer syncs
the entries, never the card file as a whole.

- **Entries.** Each save inside a card is a save of kind `ENTRY` in one of the user's memory cards (`MemoryCard`,
  "Main" until phase 4 adds more), keyed by its full name in the card's directory (`BASCUS-94163FF7-S01`). One game
  often writes several entries, so the game is only a label: it comes from the product code in the name matched
  against the Redump serial (`SCUS-94163`, `SCUS-94163-0`...), or from the card's own game. Entries keep history,
  conflicts and sharing like any save; they download as `.mcs` single saves.
- **Card files.** A `DeviceCard` is a card file on a device: a per-game card named after the rom (RetroArch
  `<rom>.srm`, NextUI `<rom file>.sav`, DuckStation `.mcd`), one named after a serial (`SCUS-94163_1.mcd`), or a card
  every game shares (`pcsx-card1.mcd`/`pcsx-card2.mcd` from PCSX-ReARMed, on by default since May 2026;
  `duckstation_shared_card_N.mcd` from SwanStation; DuckStation's `shared_card_N.mcd`; Beetle PSX's
  `mednafen_psx_libretro_shared.N.mcr`). A per-game card gets the entries of its game; a shared card those of games
  without a card of their own on that device. Per-game cards the device lacks are made; shared ones are left to the
  emulator.
- **Bases per card file.** For every card file and entry the server keeps the version last synced and the entry's
  sha1 there (`CardEntryBase`), so the same entry in two card files of one console syncs apart. An entry taken out
  on the device is not put back until it changes somewhere else.
- **Reading.** The device sends the whole file (`put`); the server takes its entries out (upload, adopt or
  conflict) and keeps an image of it (`CardSnapshot`, the last 30 read or sent per card file, downloadable from
  *Saves > Memory cards*).
- **Writing.** The server builds the card from the image it last read, with newer entries put in and every other
  entry left in its blocks, and checks it reads back. What does not fit is left out and the card file shows why; a
  damaged card is never written. The device gets a `cget` line and swaps the file in only if it is still the one
  the server read and no emulator runs (emulators keep the card in memory and write it back whole). The entries
  sent count as synced only once the device is seen holding them: an emulator that wrote the old card back leaves
  the old entry, which is sent again instead of being taken for a newer save.
- **Clients.** The shell client checks running processes and swaps the file with `mv`; at game start it writes
  before the emulator loads the card. The desktop app writes SD cards (no emulator runs on them). Servers syncing an
  SD card or a console over SSH write it themselves, over SSH only when `ps` shows no emulator. The Android app
  only sends its cards for now: it cannot tell whether an emulator is running.
- **Whole cards from before.** PS1 cards stored whole as one save are split into entries when the server starts
  and kept, marked superseded, out of the lists. A card uploaded in the web app is split the same way.

### Memory cards (GameCube)

GameCube saves use the same machinery, through a codec per kind of card file (`cardcodec.ts`): a PS1 card, a
GameCube card image, or a single `.gci` file, which is a card holding one entry. The user has one card per family
(`ps1`, `gc`), so a save moves between every kind of card of its family.

- **Entries.** Keyed as Dolphin names its files: maker, game code and the file name inside the card
  (`01-GALE-SuperSmashBros0110290334`); one game often writes several (F-Zero GX's ghosts, PSO's characters). The
  game comes from the game code matched against the Redump serial (`DL-DOL-GALE-USA`). Entries are stored as
  canonical `.gci`: no block position, no copy counter, and the card serial PSO and F-Zero GX sign their system
  file with (and its checksum) blanked, so the same save reads the same from any card. Dolphin signs those again
  when it loads a `.gci`; written into a card image they are signed for that card. They download as `.gci`.
- **Card images** (`gccard.ts`): Dolphin's `GC/MemoryCardA.<USA|EUR|JAP>.raw`, read and written as
  `GCMemcard.cpp` does (header, two directory and two allocation table copies picked by update counter, checksums).
  The updated tables go into the copies not in use, so the previous ones stay whole; a card with a damaged copy is
  read but never written. An image is shared by every game of its region and gets that region's saves (by the game
  code's last letter); Rommancer never makes one, since only Dolphin knows the serial it formats it with. Checked
  against Dolphin's own code: same formatted card byte for byte, cards it validates, same signatures.
- **GCI folders** (Dolphin's default since 2017): `GC/<region>/Card A/*.gci`, or `GC/<region>/*.gci` when the folder
  is set in `Dolphin.ini` (ROCKNIX). Each file is a card file of its own. Saves of the folder's region it lacks get a
  file named as Dolphin would; those wait until every file already in the folder has been read, since one not read
  yet may hold any save. A save deleted in Dolphin (it renames the file to `.gci.deleted`) stays out until it
  changes elsewhere; a folder found empty that held saves (a new card, a reinstall) gets them all back. Dolphin reads
  the folder when a game starts and rewrites only the saves that game changed, so files are written only while no
  Dolphin runs (`dolphin-emu` in the process list), like PS1 cards.
- **Where they are.** Batocera and Knulli (standalone Dolphin, SM8250 on Knulli): `/userdata/saves/dolphin-emu/GC`;
  the RetroArch core: `/userdata/saves/gamecube/User/GC`; ROCKNIX: `/storage/roms/bios/GC` (a card image unless the
  GCI folder is chosen in ES). Both sit inside the folders clients already scan; the server asks for `.gci` and
  `.raw` files where the device's layout has GameCube. Desktop Dolphin (`~/.local/share/dolphin-emu/GC`) is not
  scanned yet.
- **Android** (app 0.8.0). Dolphin keeps its user folder in `Android/data`, out of other apps' reach, but shares it
  through its documents provider (`org.dolphinemu.dolphinemu.user`, document ids `root/<path>`). The menu entry
  *GameCube saves (Dolphin)* opens the system folder picker (Dolphin is in its side menu); the granted tree is kept
  for good. Its `.gci` files go to the server as `/dolphin-saf/<path in Dolphin's folder>`, a path outside the device
  root that names the GCI folder like any other. The app writes only `.gci` files ("cget": a temporary file beside it,
  then the old one replaced), never card images: Android cannot tell whether Dolphin is running, and Dolphin only
  writes back the saves a game changed, so a save written while it runs is simply sent again later. Old builds that
  kept the folder in shared storage (`dolphin-emu`, `mmjr-revamp`, `dolphin-mmjr`) are read as plain files. The app
  lists Dolphin's saves only when the server's `exts` include `.gci`, so an older server never sees them.

## Credits

The spinning save point of the setup screen is pre-rendered by `tools/render_savepoint.py` from
["Save Point" by FFVII-Collector](https://www.thingiverse.com/thing:3485640) (CC BY). The STL itself is not in the repo.

## Sync protocol

All endpoints are under `/api/v1`. Console endpoints answer plain text, `key<TAB>value` per line, so busybox
clients need no JSON parser.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /link/info` | none | server URL and whether sign-up is open |
| `POST /link/login` | username + password | registers the console, returns its device token |
| `POST /link/signup` | sign-up open | creates a USER account and registers the console |
| `POST /link/start`, `GET /link/poll` | none | pairing-code flow |
| `POST /link/enroll` | package token | one-time self-registration |
| `GET /agent/roots` | device token | folders to scan and save extensions |
| `POST /agent/sync` | device token | full-device plan (below) |
| `GET /agent/file`, `POST /agent/upload` | device token | transfer one save |
| `GET /agent/thumb`, `POST /agent/thumb` | device token | a savestate's screenshot (`?v=versionId`) |
| `GET /agent/card` | device token | a memory card with the server's entries put in (`?expect=sha1` or `-`) |
| `GET /agent/lists` | device token | the lists the device's owner may give it: `prune<TAB>0\|1`, then `list<TAB>id<TAB>on<TAB>items<TAB>name<TAB>owner` (owner empty for their own; the device's lists first) |
| `POST /agent/lists/preview` | device token | ids in the body (one per line): what having only those lists would delete (`delete`, `upload`, `stuck` lines with files and bytes) |
| `POST /agent/lists` | device token | ids in the body: the device gets exactly those lists (and is asked to look at them again) |

The console screens (Onion's menu, the pygame app, the Android app) use the three list endpoints for "This console's
lists": A adds or removes a list; a removal that would delete roms (deleting roms in no list is on) says how many,
once, before it is made; leaving the screen after a change runs a full sync with the lists' roms on screen.

`POST /agent/sync` receives one line per rom and per save file:

```
rom<TAB>/path/to/rom<TAB>sha1<TAB>headerless sha1
file<TAB>/path/to/save<TAB>sha1
core<TAB>mGBA<TAB>0.10.3
```

and answers what to move:

```
put<TAB>/path/to/save<TAB>/path/to/rom
get<TAB>/path/to/save<TAB>versionId<TAB>/path/to/rom
tget<TAB>/path/to/state.png<TAB>versionId
tput<TAB>/path/to/state.png<TAB>versionId
cget<TAB>/path/to/card.srm<TAB>sha1 or -<TAB>/path/to/rom or -
```

`tget` follows the `get` of a state whose version has a screenshot; `tput` asks for the screenshot of a state the
server already has without one. `POST /agent/upload` of a new state answers `uploaded` plus a `tput` line. Clients
that do not know these lines skip them.

`cget` asks the client to fetch `GET /agent/card?expect=<sha1>` (header `X-Path-B64`) and to replace the card file
only if its sha1 is still `expect` (`-`: no file) and no emulator runs; the server answers 409 when the card it read
is no longer the device's and 204 when nothing has to change. Card files named for no rom are uploaded with rom
`-`. The upload of a card answers a `cget` line at once when the server has entries for it.

## Decisions

- **No clocks.** For every save and device the server remembers the last version synced there and the file's
  sha1 on the device. Only the device changed: upload. Only the server changed: download, converted to the
  emulator's format. Both changed: both versions are kept, the device keeps its file and a conflict is raised.
- **Games, not file names.** A rom is identified by its DAT name, or by its content hash (full and headerless),
  so `Crystalis (U) [!].nes` on one console and `crystalis.nes` on another share one save.
  Roms up to 64 MB are hashed once and cached by size and mtime.
- **Emulator from the folder.** In per-core layouts the core folder a save lives in names the emulator, so a
  gpSP save is not taken for an mGBA one even if the firmware default is mGBA.
- **Layouts**: `flat`, `system`, `core`, `rom` and `rom-core` (RetroArch on Android: next to the content, per core).
- **Self-hosted.** Every user runs their own server; consoles are configured with its address.
