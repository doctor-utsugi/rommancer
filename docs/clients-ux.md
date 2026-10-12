# Client UX guide

One structure, one vocabulary and one way of reporting for every Rommancer client: the console app (Onion's
`prompt` UI in `rommancer-sync.sh` and the pygame UI in `rommancer-ui.py`), the Android app and the desktop app.
A user who knows one knows the others.

## Vocabulary (Spanish UI / English UI)

| Concept | ES | EN |
|---|---|---|
| save file (SRAM) | partida | save |
| savestate | savestate | savestate |
| rom | juego | game |
| this device | esta consola / este móvil / este PC (by device kind) | this console / phone / PC |
| server | el servidor | the server |
| list | lista | list |
| rom upload the server asked for | envío de juegos al servidor | sending games to the server |
| delete roms in no list | borrar juegos fuera de listas | delete games in no list |

- Never show log shorthand (`up`, `down`, `sync:`, `roms:`, `pull`, `prune`) to the user. Logs stay English; the UI
  never shows a raw log line except in Estado › registro.
- Proper accents and `ñ` everywhere the font allows them (Onion: checked on the device).
- Numbers with units (`1,2 GB`, `734 MB`), never raw KB.

## Home screen (same order everywhere)

Header, one fact per line:
1. `Rommancer Sync` and, small next to it, the client version.
2. The state line, the most urgent first:
   - `2 partidas en conflicto` (warning colour)
   - `Sin conexión desde las 18:02`
   - `Sincronizado: hoy, 18:52` / `Sin sincronizar todavía`
3. Live work, only while it runs: `Descargando juegos 3/12` or `Enviando juegos al servidor 2/5`.

Items:
1. **Sincronizar ahora**: everything (saves, settings, deletions, list games, sending games).
2. **Conflictos (N)**: only when N > 0.
3. **Ver descarga de juegos** / **Ver envío de juegos al servidor**: only while one runs.
4. **Listas de esta consola**: tick lists; leaving after a change syncs. The screen also has
   **Descargar ahora los juegos de las listas**.
5. **Ajustes** (submenu, see below).
6. **Estado**: version, install date, account, server, last sync result (the summary below), last log lines.
7. **Salir** (consoles only; Android and PC use their system back/close).

## Ajustes (submenu)

Each toggle reads `Name: sí/no` and says what it does in one line under it where the UI has room (pygame, Android,
desktop) or in the menu message (Onion).
- Subir las partidas al guardarlas (Android, PC)
- El servidor puede pedir juegos
- Acceso SSH del servidor (consoles)
- Borrar juegos fuera de listas
- Borrar partidas de juegos borrados (N)
- Redes WiFi / Ajustes de emuladores (where the platform has them)
- Cuenta: `usuario @ servidor`, **Desconectar esta consola** (always asks first)

## Sync summary

Clients print machine-readable summary lines (`sum<TAB>key<TAB>n[<TAB>extra]`) next to their log lines; each UI
renders them translated, **one fact per line, only facts that are not zero**:

| key | ES |
|---|---|
| `saves-up` n | ↑ n partidas subidas al servidor |
| `saves-down` n | ↓ n partidas recibidas |
| `states-up` / `states-down` | ↑/↓ n savestates … |
| `games-down` n | ↓ n juegos descargados |
| `games-sent` n | ↑ n juegos enviados al servidor |
| `games-deleted` n | n juegos borrados (fuera de listas) |
| `saves-cleaned` n | n partidas de juegos borrados quitadas |
| `games-stopped` | Descarga de juegos parada |
| `games-nospace` name | No cabe «name»: falta espacio |
| `conflicts` n | ⚠ n partidas en conflicto |
| `errors` n | ⚠ n errores (Ver detalles) |

Nothing at all: **Todo al día**. Title of the result screen: the action (`Sincronizar ahora`). Errors keep the
existing reason + **Ver detalles**.

## Progress

Steps are numbered so the bar never seems to go backwards: `Paso 2 de 4 · Partidas`. Lines:
1. Step title (`Partidas`, `Ajustes`, `Juegos que sobran`, `Juegos de las listas`, `Envío al servidor`).
2. What it does now (`Pasando partidas 3/7`).
3. The bar with its percent.
4. The current file on its own line, with its own percent or size.
Hints (`B para parar`) go in the footer, never in the text.

## The PC is a device

The desktop app gets **Este PC** at the top of its sidebar, with the same home screen as a console:
- linking it creates a device of console "PC" with the RetroArch it finds (saves and states folders read from
  `retroarch.cfg`) and a folder for list games the user picks;
- it syncs on its own like a console: watching the save folders, polling the server, every 15 minutes;
- its lists, conflicts, deletions and sending games work like on a console.

Cards and folders of other consoles stay below, under **Tarjetas de consolas**.
