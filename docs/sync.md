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

`POST /agent/sync` receives one line per rom and per save file:

```
rom<TAB>/path/to/rom<TAB>sha1<TAB>headerless sha1
file<TAB>/path/to/save<TAB>sha1
```

and answers what to move:

```
put<TAB>/path/to/save<TAB>/path/to/rom
get<TAB>/path/to/save<TAB>versionId<TAB>/path/to/rom
```

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
