<p align="center"><img src="docs/logo.png" alt="Rommancer" width="200" /></p>

# Rommancer

Multi-user ROM collection manager: games and roms from DATs (No-Intro, Redump, FBNeo, hacks), checksum verification,
shareable lists, copying to consoles, romhack patches and synced saves between devices.

## Install

Linux with rootless Podman:

```bash
curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.tar.gz | tar xz
sh rommancer/deploy/podman/rommancer.sh install
```

It asks for your roms folder, the database and your account. Then open http://127.0.0.1:8096.

### Step by step

```bash
# 1. Download and extract (or get rommancer.zip from the releases page)
curl -fsSLO https://github.com/doctor-utsugi/rommancer/releases/latest/download/rommancer.tar.gz
tar xzf rommancer.tar.gz
cd rommancer

# 2. Build the images
sh deploy/podman/rommancer.sh build

# 3. Start Rommancer (your roms folder is mounted at /roms)
ROMMANCER_ROMS=/path/to/your/roms sh deploy/podman/rommancer.sh up

# 4. Install: in the console, or open http://127.0.0.1:8096 in a browser
sh deploy/podman/rommancer.sh setup
```

Once logged in, **Storage setup** adds your roms (under `/roms`) to the collection. Nothing in them is moved or renamed.

### Update

Extract the new release over the old folder, then:

```bash
sh deploy/podman/rommancer.sh build
sh deploy/podman/rommancer.sh up
```

Your data and settings live outside the folder.

More: [other ways to install](docs/install.md) (compose, systemd, unattended) · [using Rommancer](docs/usage.md) ·
[development](docs/development.md).

## Docs

[Save sync](docs/sync.md) · [Journeys](docs/journeys.md) · [Storage](docs/storage.md) ·
[Console settings](docs/device-config.md) · [Lists](docs/lists.md)
