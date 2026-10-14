# Save sync e2e on real devices

- `save-roundtrip.sh SOURCE DIR TARGET DIR [TIMEOUT_S]` syncs SOURCE, then syncs TARGET until its copy of the save matches byte for byte. Devices are `adb:<serial>` (Rommancer Sync 0.14.0+, synced with `am broadcast ... .ShellSync`) or `ssh:<host>` (console client).
- `android-pad.sh BUTTON [ms]` holds a button of a rooted handheld's built-in controller (sendevent; the event device is set for the AYN Thor). Emulators like PPSSPP ignore `input keyevent`. Push it to `/data/local/tmp` and run it with `su -c`.

Creating the save is game specific: launch the rom (`am start ... -d file:///...`), drive it with `android-pad.sh` or held touches (`input swipe X Y X Y 200`), and check with `adb exec-out screencap -p`.

Verified on 2026-10-14: PPSSPP on the Thor → PPSSPP on a Knulli RG (`ULES00496`).
