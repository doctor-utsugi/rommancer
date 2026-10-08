# Storage on the server

Rommancer keeps one collection spread over any number of folders and disks. It **maps** folders, it does not
own them: what you already have stays where it is, with your names, and Rommancer only writes where you allow it.

## Sources and destinations

- **Sources**: every folder you add. They are scanned fully (subfolders included) and are **read-only** by default:
  Rommancer never moves, renames or deletes anything there.
- **Destinations**: folders where Rommancer may write (uploads, roms fetched from consoles, patches). A new rom goes
  by a fixed rule, never guessing from where other roms are:
  1. the destinations assigned to its system, by priority (lower first);
  2. then the general destinations;
  3. the first one that is reachable and keeps its free-space reserve after the write. Each file goes whole to one
     destination (a game is never split across disks);
  4. if none can take it, the upload fails with `507` and a message that says why. Only a server with no folders at
     all falls back to `DATA_DIR/library`.
- Inside a destination, the folder scheme is configurable: per system, flat, or a firmware's folder names.

Destination writes go to `<destination>/.rommancer-tmp/`, are fsynced and renamed into place, so a crash or a full
disk never leaves a half file under its final name. Bytes being written are held per disk, so concurrent uploads do
not all pass the same free-space check. Leftovers older than an hour are cleaned by the health watch.

## A folder that is not there

A disk that is unplugged or not mounted usually leaves an empty mount point. Before scanning (and every five
minutes) each folder is checked:

| Check | Offline reason |
|---|---|
| The path does not exist / is not a folder / cannot be read | `missing`, `not-directory`, `unreadable` |
| It was a mount point and now lives on its parent's disk | `not-mounted` |
| Its `.rommancer-id` marker names another folder | `other-volume` |
| It is empty while the index holds files for it | `empty` |

An offline folder keeps its index untouched, is not scanned, and is never chosen as a destination. When the disk
comes back it turns online by itself. A folder mounted at another path is recognised by its marker: adding it again
answers `409 SAME_FOLDER`, and *It is at another path* (`POST /admin/paths/:id/relink`) updates the path.

Other protections:

- Subfolders that cannot be read keep their entries instead of being dropped.
- A scan that would remove more than half of a folder (with 50+ files) removes nothing and leaves a warning;
  *Confirm they were deleted* rescans with `allowMassRemoval`.
- Removed files are remembered for 30 days (`RomFileGone`): when the same file shows up in another folder (moved,
  copied to another disk), its hashes are reused instead of hashing it again. Large files are matched by quick hash
  (size + first and last MiB) without comparing dates, so copies that change the date are recognised too.
- Overlapping folders (one inside another) are refused unless forced.

## Setup wizard

*Admin → Storage setup* (also offered on the home page of a server with no destinations):

1. Pick the folders with roms. The server lists the disks it can see; inside a container only its mounts are
   visible, and the wizard says how to add one to the compose file.
2. A quick survey of each folder (no hashing): systems by folder name or extension, and the folders nothing could be
   told about, which you can assign to a system (`RomPath.folderSystems`).
3. Where new roms go: a general destination (created if missing) and, per system, one of your folders. Folders that
   are not destinations stay read-only. Then every folder is scanned.

## Reorganizer

Optional, per writable folder, with a preview. Patches, saves and cheats with the same name move with their rom;
multi-file games (cue/bin, gdi, m3u) are left alone because their files point at each other by name. Each run is
written to `.rommancer-organize.json` first: a run cut halfway is finished next time, and *Undo the last one* puts
the files back.

## Space on devices

Clients report their storage (`X-Space: <free> <total>`). Each device keeps a free-space reserve (5% by default).
List roms are copied in list order while the reserve holds; what does not fit waits and is reported on the device
page, which shows a tree of systems and games by size to leave things out (`systemFilter.excludedGames`). Subscribing
a list warns at once when it does not fit.
