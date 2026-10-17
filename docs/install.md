# Installing Rommancer

Rommancer runs in three containers (the web, the server and its MySQL database) on [Podman](https://podman.io). On
Linux they run directly; on macOS and Windows, Podman runs them inside a small Linux virtual machine that it sets up
for you. You don't need git, Node or MySQL.

- [Linux](#linux)
- [macOS](#macos)
- [Windows](#windows)
- [What the installer asks](#what-the-installer-asks)
- [Once it is installed](#once-it-is-installed)
- [Other ways to install](#other-ways-to-install): unattended, podman-compose, systemd

On every system you need about 10 GB of free disk besides your roms, and internet access while installing.
Linux is where Rommancer runs every day. The macOS and Windows scripts have not been tried on a real Mac or Windows
PC yet; if something fails there, keep what the terminal printed, since that is what it takes to fix it.

## Linux

You need Podman 4 or newer, used as your normal user (not root), plus `curl` and `tar`. On Debian or Ubuntu:

```bash
sudo apt install podman curl whiptail
```

`whiptail` is optional: with it the installer shows dialog boxes, without it it asks plain questions.

Install with one command:

```bash
curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.tar.gz | tar xz
sh rommancer/deploy/podman/rommancer.sh install
```

It builds Rommancer (a few minutes the first time), asks you [three things](#what-the-installer-asks) and ends with
Rommancer running at http://127.0.0.1:8096. At the end it offers to start Rommancer when the computer starts, which
runs `sudo loginctl enable-linger $USER` once.

The same, step by step:

```bash
# 1. Download and extract
curl -fsSLO https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.tar.gz
tar xzf rommancer.tar.gz
cd rommancer

# 2. Build the images
sh deploy/podman/rommancer.sh build

# 3. Start it, with your roms folder
ROMMANCER_ROMS=/path/to/your/roms sh deploy/podman/rommancer.sh up

# 4. Set it up: in the console, or open http://127.0.0.1:8096 in a browser
sh deploy/podman/rommancer.sh setup
```

Your data lives in `~/rommancer-data`, outside the extracted folder.

## macOS

Install Podman, either [Podman Desktop](https://podman-desktop.io) or the command line alone:

```bash
brew install podman
```

Then, in Terminal, from your home folder:

```bash
curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.tar.gz | tar xz
sh rommancer/deploy/podman/rommancer.sh install
```

The first time, the script creates Podman's virtual machine (4 GB of memory) and starts it. Then it carries on as on
Linux, with plain questions instead of dialog boxes, and Rommancer ends up at http://127.0.0.1:8096. It also adds a
login item (`~/Library/LaunchAgents/com.rommancer.start.plist`), so Rommancer starts every time you log in.

Two things differ from Linux:

- **Your roms** have to be in your home folder or on a disk under `/Volumes`: those are the only places the virtual
  machine can see. If you already had a Podman machine made without `/Volumes`, the script says so; remove that
  machine with `podman machine rm` and run the install again.
- **Your data** (database, settings, covers) lives in Podman volumes inside the virtual machine:
  `rommancer-mysql`, `rommancer-data` and `rommancer-secrets`. MySQL doesn't work reliably on folders shared from the
  Mac. `podman machine rm` deletes those volumes too, so back them up first with
  `podman volume export rommancer-data -o rommancer-data.tar`, and the same for the other two.

## Windows

Install Podman from PowerShell (or install [Podman Desktop](https://podman-desktop.io)), then open a new PowerShell
window:

```powershell
winget install RedHat.Podman
```

Podman needs WSL 2. If you don't have it, the installer of Podman or the first `podman machine init` offers to install
it, and Windows asks to restart.

Then, in PowerShell, from the folder where you want Rommancer:

```powershell
curl.exe -fLO https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.zip
tar -xf rommancer.zip
powershell -ExecutionPolicy Bypass -File rommancer\deploy\podman\rommancer.ps1 install
```

`-ExecutionPolicy Bypass` lets this one script run without changing Windows' policy for any other. The script
creates and starts Podman's virtual machine the first time, asks for your roms folder (you can drag the folder onto
the window), builds Rommancer and runs the same installer as on Linux. Rommancer ends up at http://127.0.0.1:8096, and
a shortcut in your Startup folder starts it every time you log in to Windows.

The step-by-step commands are the same as on Linux with `powershell -ExecutionPolicy Bypass -File
rommancer\deploy\podman\rommancer.ps1` in place of `sh deploy/podman/rommancer.sh`, and
`$env:ROMMANCER_ROMS = 'D:\roms'` before `up` to choose the roms folder.

Your data lives in Podman volumes inside the virtual machine, as on macOS. Roms on `C:` or `D:` are read through WSL,
which is slower than a Linux disk: the first scan of a large collection takes longer.

## What the installer asks

1. **Your roms folder.** It is mounted at `/roms` and remembered in `~/.config/rommancer/deploy.conf` for the next
   `up`. Rommancer reads it as it is: nothing in it is moved, renamed or deleted. If your roms are on several disks,
   choose a folder that holds them all.
2. **The database.** The one that comes with Rommancer is ready to use and needs nothing filled in. The other choice
   is a MySQL 8 or MariaDB server of yours, where the database must already exist.
3. **Your account:** a username and a password. The email is optional; add it later in your profile.

Every other setting (public address, sync schedule, data seed, ScreenScraper keys) starts with a value that works and
is in Administration > Server. On its first start Rommancer generates its secrets into `data/secrets` (on macOS and
Windows, the `rommancer-secrets` volume). Keep them in your backups: they hold the key that encrypts the stored
credentials.

The installer is the same in the browser and in the console. Once logged in, **Storage setup** adds your roms (under
`/roms`) to the collection.

## Once it is installed

Rommancer keeps running in the background; you can close the terminal. Use the same script to handle it
(`rommancer.ps1` on Windows):

| Command | Does |
|---|---|
| `rommancer.sh status` | says whether the three containers are running |
| `rommancer.sh down` | stops Rommancer |
| `rommancer.sh up` | starts it again (also after an update) |
| `rommancer.sh logs [api\|web\|mysql]` | follows what one of them is doing |
| `rommancer.sh setup` | the installer in the console, if you closed it halfway |
| `rommancer.sh start` | starts the containers `up` made; it is what runs at login on macOS and Windows |

To reach Rommancer from other devices, put a reverse proxy (nginx, Caddy) in front of `127.0.0.1:8096`, or change
`ROMMANCER_WEB_PORT`.

**Updating:** download the new release and extract it over the old folder, then run `build` and `up`. Your data and
settings live outside the folder.

These variables change the defaults: `ROMMANCER_ROMS`, `ROMMANCER_DATA` (Linux only), `ROMMANCER_WEB_PORT`.
`~/.config/rommancer/rommancer.env` is optional (overrides, as in `.env.example`): a variable set there wins over the
panel, which then shows it locked.

## Other ways to install

### Unattended

Every answer can be given as an option, and then nothing is asked (`deploy/install.sh --help` lists them):

```bash
ROMMANCER_ADMIN_PASSWORD='your password' sh rommancer/deploy/podman/rommancer.sh install \
  --roms /srv/roms --lang en --db bundled --admin admin
```

`ROMMANCER_DB_PASSWORD` gives an external database's password the same way.

### podman-compose

From the extracted folder (web on port 8080):

```bash
ROMS_DIR=/path/to/my/roms podman-compose --profile full up -d --build
sh deploy/install.sh http://localhost:8080
```

### Quadlet (systemd)

```bash
podman build -t rommancer-mysql -f deploy/mysql/Containerfile .
podman build -t rommancer-api -f backend/Containerfile .
podman build -t rommancer-web -f frontend/Containerfile .
mkdir -p ~/.config/containers/systemd ~/rommancer/data/secrets
cp deploy/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start rommancer-web
sh deploy/install.sh http://localhost:8080
```

The roms are mounted from `~/roms` (edit `rommancer-api.container` to change it).
