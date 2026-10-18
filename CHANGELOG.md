# Changelog

What changes for you in each version of Rommancer. The update page in Administration shows the entries between
your version and the newest one.

## 1.105.0 (2026-10-18)

- The roms folder you pick in the installer goes straight into your library and is scanned, so your games show up
  without visiting Storage setup. An install that has no library folders yet gets its roms folder added the same
  way on its next start.
- The installer in the browser asks whether Rommancer starts with the computer. The one command no longer turns it
  into a service by itself, and Administration > Update works either way.
- Keeping the current roms folder also stops showing the computer's other folders to Rommancer.
- The database step just says "Preparing the database…".

## 1.104.0 (2026-10-18)

- Installed with the one command, Rommancer asks for your roms folder in the browser, as the installer's last step:
  you browse your computer's folders and pick it, and Rommancer starts again with it in a few seconds. The command
  no longer needs to know where your roms are.
- The installer in the browser goes on by itself once the database is ready. Before, it could stay on the first step
  until the page was reloaded.

## 1.103.0 (2026-10-18)

- Rommancer installs with one command and finishes in the browser:
  `curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/get.sh | sh`. It asks nothing,
  starts Rommancer as a service and shows the address where the browser asks for the database and your account.
  Your roms go in `~/rommancer-roms` unless you choose another folder.
- Installing and updating no longer build Rommancer on your computer: each version comes ready-made, for x86_64 and
  ARM, and only what changed is downloaded. Updates take a minute or two instead of several.

## 1.102.0 (2026-10-18)

- The update screen has a progress bar that shows the step and the percentage done. It turns red if the update goes
  back to the previous version.
- The update log no longer scrolls sideways: long lines wrap.

## 1.101.0 (2026-10-18)

- When a new version of Rommancer is out, Update in the menu shows a "New" badge. Opening the Update page clears it
  until the next version comes out.

## 1.100.0 (2026-10-18)

- While Rommancer updates, the whole web app becomes one update page for everyone, so nothing can be changed half
  way. It shows each step, and at the end whether the update worked or went back to the previous version.
- Install asks for Rommancer's web address when it will be reachable from the internet, for example
  https://roms.example.com. Consoles and phones connect through it. On a home network it stays empty.
  `--public-url` gives it beforehand.
- The update page titles each version's notes "Changelog vX".
- The ScreenScraper notice explains in plainer words how to get a developer id.

## 1.99.0 (2026-10-18)

- Devices with no consoles yet asks first how the console will connect, then shows only that way's steps: the app
  on the console, the app on your computer, or SSH. The computer way is new on this page: put a console's SD card in
  your computer, or plug the console in by USB, and the Rommancer app there syncs it. One app looks after all your
  consoles.

## 1.98.0 (2026-10-18)

- Rommancer updates itself: Administration > Update shows the new versions and what each one changes, and its button
  updates. The database is backed up first, and if the new version doesn't start, Rommancer goes back to the
  previous one by itself. The button needs Rommancer installed as a service; `rommancer.sh update` does the same from
  the console, and `rommancer.sh rollback` goes back by hand.
- Devices marks a console whose app is newer than the one the server hands out. The Android and desktop apps say
  when their server is older than them.

## 1.97.0 (2026-10-18)

- Devices with no consoles yet explains the two ways to connect one: Rommancer Sync on the console, with the steps
  and download for each firmware, or SSH with nothing installed. A table compares them.

## 1.96.0 (2026-10-18)

- Install no longer asks who may open Rommancer: it always opens to the local network, where the consoles reach it.
  `--listen local` keeps it to the computer it runs on, for setups behind a reverse proxy.

## 1.95.0 (2026-10-18)

- Install asks for the web's port. It proposes 8096, or the next free one, and refuses a port that is taken.
- Rommancer is reachable from the local network by default. Before, it only answered on the computer it runs on.

## 1.94.0 (2026-10-17)

- Rommancer runs on Podman (the default) or Docker. Install asks when both are installed, or takes `--engine`.

## 1.93.0 (2026-10-17)

- The console installer's waiting boxes show their text, and its first box says what Rommancer runs in.

## 1.92.0 (2026-10-17)

- Rename and sort lists every file it left in place and why: a name taken, no permission, a full disk or a file
  that went missing. A rom that can't move keeps its companion files with it.

## 1.91.0 (2026-10-17)

- Install asks whether to run Rommancer as a service that starts with the computer. `rommancer.sh service on|off`
  changes it later. Without a service, the last step shows how to start and stop it.

## 1.90.0 (2026-10-17)

- Rommancer installs on Linux, macOS and Windows. `docs/install.md` has the guide for each.
- The installer no longer asks for an email, and a password only has to be non-empty.
