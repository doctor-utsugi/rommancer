# Installing Rommancer

Rommancer runs in three containers (the web, the server and its MySQL database) on [Podman](https://podman.io) or
Docker. On Linux they run directly; on macOS and Windows, Podman or Docker Desktop runs them inside a small Linux
virtual machine. Everything Rommancer needs goes inside the containers: you don't need git, Node or MySQL.

Podman is the default and the recommended one: it runs as your user, with no service running as root. If you already
use Docker, Rommancer works with it too. When both are installed, the installer asks which one to use (Podman comes
first), and `install --engine podman|docker` answers it beforehand. Every later command uses the same one.

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

With Docker instead, your user has to be able to run it without sudo (`sudo usermod -aG docker $USER`, then log in
again). The files Rommancer writes in `~/rommancer-data` then belong to root and MySQL's user, so deleting that folder
by hand takes sudo.

Install with one command:

```bash
curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.tar.gz | tar xz
sh rommancer/deploy/podman/rommancer.sh install
```

It builds Rommancer (a few minutes the first time), asks you [three things](#what-the-installer-asks) and ends with
Rommancer running at the address it shows (http://your-ip:8096 by default). Last, it asks whether to install Rommancer as a
[service](#running-it-as-a-service) that starts with the computer.

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

# 4. Set it up: in the console, or open http://your-ip:8096 in a browser
sh deploy/podman/rommancer.sh setup
```

Your data lives in `~/rommancer-data`, outside the extracted folder.

## macOS

Install Podman, either [Podman Desktop](https://podman-desktop.io) or the command line alone (Docker Desktop works
too):

```bash
brew install podman
```

Then, in Terminal, from your home folder:

```bash
curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.tar.gz | tar xz
sh rommancer/deploy/podman/rommancer.sh install
```

The first time, the script creates Podman's virtual machine (4 GB of memory) and starts it. Then it carries on as on
Linux, with plain questions instead of dialog boxes, and Rommancer ends up at the address it shows. Installed as a
service, it starts every time you log in to the Mac.

Two things differ from Linux:

- **Your roms** have to be in your home folder or on a disk under `/Volumes`: those are the only places the virtual
  machine can see. If you already had a Podman machine made without `/Volumes`, the script says so; remove that
  machine with `podman machine rm` and run the install again.
- **Your data** (database, settings, covers) lives in Podman volumes inside the virtual machine:
  `rommancer-mysql`, `rommancer-data` and `rommancer-secrets`. MySQL doesn't work reliably on folders shared from the
  Mac. `podman machine rm` deletes those volumes too, so back them up first with
  `podman volume export rommancer-data -o rommancer-data.tar`, and the same for the other two.

## Windows

Install Podman from PowerShell (or install [Podman Desktop](https://podman-desktop.io); Docker Desktop works too), then
open a new PowerShell window:

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
the window), builds Rommancer and runs the same installer as on Linux. Rommancer ends up at the address it shows.
Installed as a service, it starts every time you log in to Windows.

The step-by-step commands are the same as on Linux with `powershell -ExecutionPolicy Bypass -File
rommancer\deploy\podman\rommancer.ps1` in place of `sh deploy/podman/rommancer.sh`, and
`$env:ROMMANCER_ROMS = 'D:\roms'` before `up` to choose the roms folder.

Your data lives in Podman volumes inside the virtual machine, as on macOS. Roms on `C:` or `D:` are read through WSL,
which is slower than a Linux disk: the first scan of a large collection takes longer.

## What the installer asks

1. **What runs the containers**, only when both Podman and Docker are installed. Podman is the default.
2. **Your roms folder.** It is mounted at `/roms` and remembered in `~/.config/rommancer/deploy.conf` for the next
   `up`. Rommancer reads it as it is: nothing in it is moved, renamed or deleted. If your roms are on several disks,
   choose a folder that holds them all.
3. **The port.** It proposes 8096, or the first free one after it when another program already uses 8096. If you
   type a port that is taken, it says so and asks again.
4. **The database.** The one that comes with Rommancer is ready to use and needs nothing filled in. The other choice
   is a MySQL 8 or MariaDB server of yours, where the database must already exist.
5. **Your account:** a username and a password. The email is optional; add it later in your profile.

Rommancer opens to your local network, since that is where your consoles reach it. Behind a reverse proxy you can
keep it to the computer it runs on with `install --listen local`. Your choices of engine, roms folder and port are kept in `~/.config/rommancer/deploy.conf`, and every later
`up` uses them. Every other setting (public address, sync schedule, data seed, ScreenScraper keys) starts with a value that works and
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
| `rommancer.sh stop` | stops Rommancer |
| `rommancer.sh start` | starts it again |
| `rommancer.sh logs [api\|web\|mysql]` | follows what one of them is doing |
| `rommancer.sh service on` / `off` | installs or removes Rommancer as a service |
| `rommancer.sh up` | makes the containers anew, after an update or a change of roms folder |
| `rommancer.sh down` | removes the containers (your data stays) |
| `rommancer.sh setup` | the installer in the console, if you closed it halfway |

### Running it as a service

Without a service, Rommancer stays off after a reboot until you run `rommancer.sh start`. As a service it starts by
itself: on Linux with the computer, even with nobody logged in; on macOS and Windows when you log in.

- **Linux:** a systemd user unit, `~/.config/systemd/user/rommancer.service` (`systemctl --user status rommancer`).
  To start before anyone logs in, your user needs lingering, so the first time it runs
  `sudo loginctl enable-linger $USER`, which asks for your password.
- **macOS:** a login item, `~/Library/LaunchAgents/com.rommancer.start.plist`.
- **Windows:** a shortcut in your Startup folder, `rommancer.cmd`.

`install --service yes` (or `no`) answers the question beforehand.

To serve Rommancer under a domain with HTTPS, put a reverse proxy (nginx, Caddy) in front of its port.

**Updating:** download the new release and extract it over the old folder, then run `build` and `up`. Your data and
settings live outside the folder.

To change a choice later, give it to `up` once and it is remembered: `ROMMANCER_WEB_PORT=9000 rommancer.sh up`,
`ROMMANCER_LISTEN=local rommancer.sh up` (or `network`), `ROMMANCER_ROMS=/other/folder rommancer.sh up`.
`ROMMANCER_DATA` (Linux only) moves the data folder.
`~/.config/rommancer/rommancer.env` is optional (overrides, as in `.env.example`): a variable set there wins over the
panel, which then shows it locked.

## Other ways to install

### Unattended

Every answer can be given as an option, and then nothing is asked (`deploy/install.sh --help` lists them):

```bash
ROMMANCER_ADMIN_PASSWORD='your password' sh rommancer/deploy/podman/rommancer.sh install \
  --roms /srv/roms --port 8096 --service yes --lang en --db bundled --admin admin
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
