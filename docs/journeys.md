# Journeys

A Journey holds a living block of saves and savestates for one exact ROM and one user. Each console selects
its own Journey for that ROM. Selecting one does not change other consoles; devices selecting the same
Journey synchronize its progress. Journeys are not emulator state slots or historical backups.

## Current implementation

The initial adapter supports RetroArch raw-save games on Android and supported Linux layouts. It discovers
SRAM, numbered `.state` slots (including slots beyond 9), `.state.auto` and their PNG thumbnails. The local
store keeps immutable file copies, complete manifests, a durable outbox and a switch recovery journal.

| Capability | Implementation / verification |
|---|---|
| Exact ROM identity | Platform plus SHA-1 of the actual ROM file. No name/game fallback. CUE/M3U sets are excluded. Different archive/container bytes remain different identities. |
| Per-console selection | Device/identity binding and monotonic selection generations. Tested with two API devices. |
| Empty creation / duplication | Local create-and-switch; duplicate-and-switch preserves the source. Web creation/duplication leaves console selections alone. |
| Whole-block synchronization | Immutable manifests, verified blobs, CAS commits and preserved conflict checkpoints. |
| Offline use | Cached switching and local creation/duplication, with queued publication. Metadata lists distinguish cached content from required downloads. |
| Storage | Prefetch current revisions for all known Journeys of enrolled ROMs until the measured reserve is reached. No automatic deletion of caches or unsynchronized work. |
| Recovery | Linux working-set rollback and metadata/selection restoration; tested with interrupted replacement fixtures. Android has a durable journal and verified replacements; device lifecycle testing remains outstanding. |
| Linux launch hooks | Existing `game-start`/`game-stop` paths prepare/recover Journeys under the sync lock. Pending requests can apply at these safe boundaries. |
| Android lifecycle | Usage/foreground alone is not proof of exit. A complete privileged process snapshot may establish stopped/running; otherwise state is unknown and changes need explicit closed-game confirmation. |
| Live override | Not enabled by the initial adapter. A running game queues the change; the UI explains that it must close. |
| Notifications | Android emits a one-time Journey warning when an emulator is observed opening. Linux uses `notify-send` when available and retains the change in the client log. Launcher-specific visibility has not been certified. |
| Web | Saves > Journeys and the game Saves section: browse, create, duplicate, rename, archive/unarchive, inspect/download checkpoints, restore and request selection on eligible consoles. |
| Conflict recovery | Web can select a preserved checkpoint as current. Clients can keep both and continue local progress in a new Journey. |

Savestates are scoped to the emulator and its last-reported core version. If no version is known, they are
isolated to the originating device instead of assuming compatibility. Raw in-game saves use a shared raw
adapter within the exact ROM identity. Other-core states remain in the Journey but are not installed.

Not enabled: Onion game-switcher integration, NextUI/minarch resume metadata, shared memory cards, standalone
emulator directory saves, SAF-only folders, CUE/M3U content sets and desktop Journey UI parity. The server
rejects enrollment on unsupported adapters. Existing legacy sync continues for unenrolled ROMs. Changing
an enrolled console's storage mount, save paths or reported core version requires adapter reconciliation;
the server blocks ambiguous operations rather than silently reinterpreting its working files.

Real Android devices and RetroDECK are not certified by compilation or filesystem fixtures. There was no
ADB device attached during the implementation checks. Android process-exit switching still needs device
validation; live write-destination overrides, cache eviction/pinning UI and automatic ROM relocation remain follow-up work.

## Console flow

Android 0.23.0 (61) and Linux 1.83.0 rebuilt the console screens after testing them with the pad on the Thor
(2026-10-16). The previous paged cards fitted one slot or two consoles per page on a 1080p screen, D-pad up
dropped into the search field and opened a full-screen keyboard that kept the pad's keys, the Android warning was
a dialog whose first A press was lost, and changing slots took four presses with a warning that never checked
anything (the switch went ahead with RetroArch running). Now the lists are Browse-style rows, the first list shows
the games with slots, A uses a slot at once, X opens its options, an empty slot starts a dated new game, and the
emulator check uses root or Shizuku when available. The server sends console names with the game list.
See docs/clients-ux.md.

Deployed client revision: Android 0.22.0 (60) and Linux 1.82.0 make the active slot visibly green and show
the last local/server update time. A completed switch returns to the slot list without a success dialog;
pending synchronization is displayed on the slot. This revision was published as `powerquest-20261015-60`,
with previous client/web files backed up in `/home/salamando/rommancer-backups/powerquest-20261015-60/`.

Android 0.20.0 and Linux 1.80.0 introduced a console-first selector with local search and game-style
save slots. The top-level search includes all local games and matching console names. A console's search
filters only its games. L/R changes pages; B returns one level, preserving the query and page. Slots show a
persistent local number, name, file count and **IN USE**. An empty slot starts a new game; copying and renaming
are actions inside slot details. The technical Journey identifier and synchronization behavior are unchanged.
These versions were deployed on 2026-10-15. Android and Linux downloads include the new selector and paging.
Desktop paging code is included in the repository; a new native desktop installer has not been published.

The client revision deployed on 2026-10-15 (Android 0.21.0 / 59 and Linux 1.81.0) replaces search-as-you-type
with explicit **Accept** / START. Draft edits do not search locally or query the catalog. Local results are
cached rather than rebuilt every render frame. The Linux keyboard has a selectable Accept row; Android
provides an Accept button and the keyboard's Done action. Slot buttons no longer include “Game closed”:
Android displays a separate OK notice; Linux omits it when a process check confirms no emulator is running.
This client-only release did not require new database migrations or a service restart. Previous client
files are backed up in `/home/salamando/rommancer-backups/accept-20261015-59/`; the public APK, Linux update
manifest and all changed runtime files were verified by checksum after publication.

Open **Journeys**, choose a console and game, and set up Slot 1. Close an open emulator when the notice appears. Its current local
files become a new preserved Journey. The first enrollment is named `Main`; later consoles import into
`From <console>` so existing shared progress is never overwritten just because a console was registered.
Choose an existing Journey explicitly to continue that branch on another console.

Choose **Empty slot** to start fresh, or open the active slot and choose **Copy this slot…**. Duplication requires
a complete source checkpoint; if newer server progress is known, apply it or resolve its conflict first.
An offline copy may be older than the server. Unsynchronized progress stays durable locally until reconnect.

Linux game hooks can prepare incoming progress before launch. On Android, without a complete privileged
process snapshot, close the emulator and use **Apply pending changes**. The app never treats its own foreground activity
as evidence that a background emulator has exited. After changing Journeys, reopen the game to load the
selected progress; changing files does not hot-load an emulator's RAM.

The pygame client provides the gamepad selector. Onion is deliberately excluded until its independent
resume/game-switcher metadata has a safe adapter. The shell interface is also available:

```sh
sh rommancer-sync.sh journeys games
sh rommancer-sync.sh journeys enroll BASE64_ROM_PATH
sh rommancer-sync.sh journeys list ROM_IDENTITY
sh rommancer-sync.sh journeys switch ROM_IDENTITY JOURNEY_UUID 1
sh rommancer-sync.sh journeys new ROM_IDENTITY "Challenge" 1
sh rommancer-sync.sh journeys duplicate ROM_IDENTITY "Copy" 1
sh rommancer-sync.sh journeys sync ROM_IDENTITY 1
sh rommancer-sync.sh journeys rename ROM_IDENTITY JOURNEY_UUID "New name"
sh rommancer-sync.sh journeys keep-both ROM_IDENTITY "Recovered progress" 1
```

`1` is an explicit local assertion that the game is closed. Detected running emulators still defer switching.
Do not use that assertion to bypass an open emulator. A normal sync does not make that assertion; game hooks do.

## Storage and consistency

Local stores are namespaced by server and device token. An account change does not reuse another account's
manifests, outbox or file cache. The reserve is `min(1 GiB, max(128 MiB, 5% of volume capacity))`. Target
materialization also checks worst-case staging bytes; rollback may use the reserve to restore the old set.
The first implementation stops prefetch when space is short instead of evicting existing data. It does not
download historical revisions to consoles or delete dirty blocks to make room.

The server stores files below `saves/journeys/<user>/<digest-prefix>/<digest>`. Database revisions reference
complete verified manifests. A stale base produces a preserved conflicting revision, not a last-writer-wins
overwrite. Retries retain operation IDs. Selection acknowledgements are separate from content commits.
Web bulk selection creates per-device one-time commands; a newer local selection supersedes an old request.

Only adapter-owned paths are replaced. Outgoing-only auto-state and thumbnail files are removed after their
block is preserved. Neither an entire saves directory nor another game's files are replaced. Filesystem
permission loss is an error, not a file deletion. Dirty snapshots and rollback blobs are retained.

## Migration and rollout

Schema changes are additive: `37_journeys` and `38_journey_provenance`. Apply with the normal deployment's
`prisma migrate deploy` procedure after taking database/file backups. Both migrations were deployed on
Salamando on 2026-10-15. The web/API and downloadable Android 0.19.0 (57) and Linux 1.79.0 clients are live
at `https://rommancer.cidwel.com`. Database, saves and previous source backups are in
`/home/salamando/rommancer-backups/journeys-20261015-2b54f4/`. The post-deployment check confirmed the existing
89 saves and 131 save versions, an authenticated Journey listing and current migration status.

The slot UX update was deployed later on the same day as `slots-20261015-58`: Android 0.20.0 (58), Linux
1.80.0, and the API updater manifest serving `local_library.py`. No new database migration was needed.
Its pre-deployment backups are in `/home/salamando/rommancer-backups/slots-20261015-58/`. Public downloads,
the authenticated Journey endpoint and unchanged save/version counts were verified after deployment.

Enrollment is opt-in. Legacy save history does not contain a cryptographic source-ROM checkpoint binding,
so it is not silently assigned to a guessed exact ROM. Current console files are checkpointed on enrollment;
existing server save histories stay available under the legacy saves screens. `GET /api/v1/journeys/migration-report`
returns the user's legacy records and reasons they need review. No old history or conflict is deleted.

For enrolled ROMs, legacy agent plans exclude owned paths and legacy uploads/downloads are rejected. The
old server-side local/SSH save synchronizer refuses Journey-managed devices; use their updated client. The
installer, updater manifest and SSH bootstrap include `journeys.sh`. Do not downgrade an enrolled console to
a client that does not understand Journeys. Unenrolled games keep using their existing synchronization.

## Verification

The tests in `backend/test/journeys.test.ts` exercise real HTTP routes and the real shell client, including
enrollment, independent console selections, stale-generation rejection, duplicate-and-switch, synchronization
and returning to the original block. `journey-local.test.ts` exercises the filesystem transaction and rollback,
including auto-resume, slot 42 and preserving an unrelated game's save. Core CAS/identity tests cover coherent
conflicts, idempotent retries, independent duplication and user isolation.

Backend/frontend builds, i18n validation and the Android debug build are required checks. Android now has
unit tests for local search normalization and page bounds; these do not replace device lifecycle testing.
Desktop/mobile web inspection uses isolated API fixtures rather than production data.

Latest verification: 115 backend tests passed in the broad run and 4 were skipped. That run reached its
six-minute limit while importing the repository seed. The two tags tests passed separately; the large
seed-import test did not complete within a subsequent five-minute bound. No complete green full-suite result
is claimed. Backend/frontend builds, Android debug packaging, shell syntax and Python compilation passed.
The Journey web surface was checked at 1280 px and 390 px with no horizontal overflow after making the
existing navigation collapsible on narrow screens.
