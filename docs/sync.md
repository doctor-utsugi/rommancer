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
  Unzip it on the SD card (Onion) or the `share` folder (Knulli/Batocera); the console links itself.
- **Pairing code**: `rommancer-sync.sh link SERVER` shows a code to approve at `SERVER/link`.

## Clients

| Platform | Client | Setup screen |
|---|---|---|
| Onion (Miyoo Mini) | `clients/linux/rommancer-sync.sh` | `rommancer-sync.sh setup`, built on Onion's `prompt` menu and `kbinput` keyboard |
| Knulli, Batocera, ROCKNIX | `rommancer-sync.sh` + `rommancer-ui.py` | pygame app; buttons come from EmulationStation's `es_input.cfg` |
| muOS, PCs | `rommancer-sync.sh` | command line (`link`, `sync`, `daemon`) |
| Android | planned (Kotlin) | native screens |

The shell client is POSIX `sh` for busybox: it needs `curl` (or `wget`), `sha1sum` and `base64`.
It ships `cacert.pem` because some firmwares (Onion) have `curl` without root certificates, and it sets the
clock by NTP when it is clearly wrong (consoles without a battery-backed clock boot in the past and TLS fails).

Client commands: `setup`, `link SERVER`, `enroll`, `sync`, `daemon`, `boot`, `install`, `status`, `unlink`, `hints`.

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
