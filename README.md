<p align="center"><img src="docs/logo.png" alt="Rommancer" width="200" /></p>

# Rommancer

Multi-user ROM collection manager: games and roms from DATs (No-Intro, Redump, FBNeo, hacks), checksum verification,
shareable lists, copying to consoles, romhack patches and synced saves between devices.

## Install

Rommancer installs with one command on Linux, macOS and Windows. It runs in containers, with Podman (recommended) or
Docker, so you don't need git, Node or MySQL.

- [Linux](docs/install.md#linux)
- [macOS](docs/install.md#macos)
- [Windows](docs/install.md#windows)

On Linux, with Podman installed (`sudo apt install podman curl` on Debian or Ubuntu):

```bash
curl -fsSL https://github.com/doctor-utsugi/rommancer/releases/latest/download/get.sh | sh
```

It downloads Rommancer ready-made, starts it and shows the address to open (http://your-ip:8096 by default), where
the browser asks for the database and your account. Your roms go in `~/rommancer-roms`.
The [install guide](docs/install.md) has the step-by-step commands, how to start, stop and update it, and the
unattended install.

More: [using Rommancer](docs/usage.md) · [development](docs/development.md).

## Docs

[Save sync](docs/sync.md) · [Journeys](docs/journeys.md) · [Storage](docs/storage.md) ·
[Console settings](docs/device-config.md) · [Lists](docs/lists.md)
