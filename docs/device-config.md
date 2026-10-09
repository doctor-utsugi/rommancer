# Device configuration

Rommancer keeps some of your settings applied on your consoles, and keeps copies of each console's
configuration files so they can be read, edited and put back.

## Your settings

In the profile page, "Settings for your consoles":

- **RetroAchievements**: user and password. Rommancer checks them with RetroAchievements' login and keeps
  the password (encrypted) and the token it returns. Knulli and Batocera up to v41 log in with the password;
  RetroArch, Onion and newer Batocera get the token.
- **WiFi networks**, in order of preference, each with its band: `2.4 and 5 GHz` (the same name on both
  bands), `2.4 GHz` or `5 GHz only`, and whether it is hidden.

Each device has "Keep my settings up to date" (on by default). When the settings change, the device gets them
at its next sync.

## WiFi bands

A device is only given networks it can see. Its bands come from, in this order:

1. what the user set on the device's Configuration tab;
2. what its client reported: the Linux client reads `iw list` (or `iwlist`) and sends `X-Wifi-Bands`, the
   Android app asks `WifiManager.is5GHzBandSupported()`;
3. its console model (`Console.wifiBands`, seeded for the common handhelds).

A 2.4 GHz device skips networks marked `5 GHz only`; a device without WiFi gets none.

ArkOS and NextUI are not supported yet: Rommancer does not know their folders, and ArkOS imports one network
only when it is in range.

Networks Rommancer does not manage (set up on the console itself) are kept. Networks it manages and that no
longer apply (removed from your list, or not visible to that device) are removed.

## Where each firmware keeps them

| Firmware | RetroAchievements | WiFi | Copied by a backup |
|---|---|---|---|
| Knulli, Batocera | `system/batocera.conf` (`global.retroachievements.*`) | same file: `wifi`, `wifi2`, `wifi3` (`.ssid`, `.key`, `#;$` escaped) and `wifi.hidden` | `batocera.conf`, `es_settings.cfg`, `es_input.cfg`, RetroArch core options and remaps, `custom.sh` |
| Onion | `RetroArch/.retroarch/retroarch.cfg` (`cheevos_*`, token) | `/appconfigs/wpa_supplicant.conf` (internal memory) | `retroarch.cfg` and overrides, `.tmp_update/config/`, profile config, `/appconfigs/system.json`, `wpa_supplicant.conf` |
| muOS | `/opt/muos/share/info/config/retroarch.cfg` and `retroarch.cheevos.cfg` (appended at each launch; internal) | one profile per network in `MUOS/network/rommancer-*.ini` on the card (`pass` is the derived 64-hex key; priority 1 wins) | the network profiles and both RetroArch files |
| ROCKNIX | `.config/system/configs/system.cfg` (`global.retroachievements.*`, password; RetroArch's config is rebuilt from it) | NetworkManager keyfiles `rommancer-*.nmconnection` in `/storage/.config/NetworkManager/system-connections/`, mode 600 (only the console or SSH writes them) | `system.cfg` and the keyfiles |
| Android | RetroArch's `retroarch.cfg` (`RetroArch/` or `Android/data/com.retroarch*/files/`) and PPSSPP's `PSP/SYSTEM/ppsspp.ini` (`[Achievements]`) with its token in `ppsspp_retroachievements.dat` | handed to Android with `ACTION_WIFI_ADD_NETWORKS`: the user confirms them in a system dialog | those files and ES-DE's `es_settings.xml` |

Nothing is reloaded live. RetroArch reads its config at the next game, and the firmwares read WiFi networks at
boot, so a sync running over WiFi is never cut short.

## Android and Shizuku

Most emulators keep their configuration under `Android/data`, which Android keeps from other apps. With
[Shizuku](https://shizuku.rikka.app/) running and allowed, the app reads and writes there with shell
permissions, and stops the emulator before changing its files; an emulator that is open is never stopped (the
work waits for the next sync). Without Shizuku only the public folders are changed and the device shows the
`needShizuku` note.

## Copies

A copy (`DeviceConfigVersion`) is a list of files, stored by content in `DATA_DIR/device-config/blobs`.

- **backup**: asked for in the web app ("Copy its configuration").
- **before**: taken automatically before anything is written; the last 15 per device are kept.
- **edit**: a file changed in the web app; it is sent to the device as a restore of that file.

Any copy can be opened, downloaded as a zip (files outside the device root go under `_root/`), restored
whole or one file at a time.

## Protocol

Work is queued per device (`DeviceConfigOp`: `backup`, `settings`, `restore`). Settings are not queued when
they change: the server compares a hash of what the device should have with the last one applied, and
creates the work when a channel asks. Whichever channel reaches the device first does it:

- the console's client (`rommancer-sync.sh config`, also run after each full sync, never while a game runs);
- the server over SSH, which runs that same client when the console is quiet;
- the desktop app, on the card (`X-Channel: sd`). Paths outside the device root (Onion's `/appconfigs`) are out
  of reach there; settings that need them stay pending for the console itself.

Steps, all under `/api/v1/agent/config` with the device token:

1. `GET /plan`: `op<TAB>id<TAB>kind`, then `get<TAB>path` for a file or `dir<TAB>path/` for every file in a
   folder. Paths are relative to the device root, or absolute outside it. Empty: nothing to do.
2. `POST /file/:op` for each one: the file as body, `X-Path-B64` names it, `X-Missing: 1` if it is not there.
3. `POST /ready/:op`: the server keeps the copy and answers `put<TAB>n<TAB>path` for each file to write.
4. `GET /out/:op/:n`: the content to write (clients write `path.rommancer-tmp`, set the mode when the `put` line
   has a fourth field, then rename). `del<TAB>n<TAB>path` lines remove a file; the server only sends them for
   Rommancer's own files (`rommancer-*`), such as a network the user dropped.
5. `POST /done/:op`: `ok`, or `error<TAB>writeFailed:path`.

Work a channel took and did not finish is offered again after 30 minutes. Settings that failed are not retried
for an hour unless they change.

`GET /agent/config/wifi` gives the user's networks to clients that hand them to their system (the Android app):
`wifi<TAB>ssid (base64)<TAB>password (base64)<TAB>band<TAB>hidden`.

Notes and errors are stored as codes (`missing:path`, `wifiInternal`, `wifiFull:list`...) that the web app
words in the user's language.
