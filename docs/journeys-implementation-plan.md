# Journeys: UX and implementation handoff

Status: implementation contract with an initial supported-adapter baseline now implemented. See
`docs/journeys.md` for the actual capability matrix, verification and remaining work.
The user originally requested a complete implementation handoff. Product decisions below are binding;
engineering defaults are recommendations, not claims about existing functionality.

## 1. Product contract

A Journey is a living, synchronized collection of all supported saves and savestates for one exact ROM,
owned by one user. It is not a historical snapshot, an emulator state slot, or a global user profile.

Confirmed requirements:

- Each console independently selects one Journey per exact ROM. Selecting one never changes another console.
- Devices using the same Journey share its progress. Devices using different Journeys do not share progress.
- Create either an empty Journey or an independent duplicate. Duplicating on a console switches to the copy.
- Changes normally happen with the game closed. A pending switch is the default when it is running, with an
  explicit override option. This interprets the user's answer “C” as the offered combination of both options.
- Detect running emulators where possible and warn about the destination of subsequent writes. Launcher
  messages, including a RetroDECK integration where supported, are acceptable; a new overlay is not required.
- Switching offline is desired, with an explicit warning. Prefer keeping all Journeys locally if storage permits.
- The web browses/manages Journeys. It has no global active Journey. It can explicitly request a switch on all
  eligible consoles; each console applies and acknowledges the request independently.
- Identity is the exact ROM, never a game grouping, title, region family, serial alone, or basename.
- The name may change. Keep the technical identifier `journey`; centralize visible vocabulary.

Recommended display name: **Journeys** for now, pending a naming decision. **Playthroughs / Partidas** is the
clearest alternative; **Adventures / Aventuras** is more playful but less universal. Do not call them profiles
or backup slots. Clients remain English-only under `docs/clients-ux.md`; the web remains EN/ES.

## 2. Recommended architecture and storage decision

Keep server-authoritative shared content, a durable local Journey store, and one materialized working set
in the paths the emulator already uses. No emulator modification or symlink support is assumed.

The server stores all Journeys and their version history. A console caches the current manifest and current
file versions of all Journeys for ROMs installed on that console, as space allows. Historical versions stay
on the server, apart from bounded local switch recovery copies and unsynchronized work.

Do not make switching server-only. Even an online-only implementation must preserve the outgoing files,
install the incoming files and recover interrupted replacements. Local caching adds offline availability;
it does not introduce the core replacement problem. Server-only switching would also fail on travel and
poor WiFi. If capacity is exhausted, degrade individual Journeys to online-only instead of removing the feature.

### Capacity policy

- Before prefetch or switching, calculate actual bytes on each affected filesystem. Android's private store
  and SAF destinations may have separate capacities; server `X-Space` alone cannot prove sufficient space.
- Example only, not a measured repository workload: 10 Journeys with 10 states of 20 MiB each require roughly
  2 GiB before saves, thumbnails, active copies and temporary recovery storage. Small SRAM files do not imply
  small Journeys. Measure manifests rather than assuming all platforms fit.
- Proposed default reserve: `min(1 GiB, max(128 MiB, 5% of volume capacity))`. Make it configurable. A transaction
  additionally reserves its measured worst-case staging and rollback bytes. The reserve is not a cache quota.
- Prefetch the active Journey first, then explicitly requested/pinned Journeys, then other Journeys by recent
  use. Cache complete manifests and file variants where possible, not partial transfers advertised as complete.
- Never automatically evict active, dirty, conflicted, pinned or recovery-referenced content. Clean unpinned
  inactive caches may be evicted least-recently-used; retain their metadata and show `Download required`.
- If reclaiming eligible caches is insufficient, stop prefetch. Keep the current Journey playable. Report
  `Not enough space to keep every journey offline` with needed/free bytes and a storage management action.
- An online switch may download only the target materialization needed by this emulator, clearly marking its
  complete-block cache separately. Never claim all variants are available offline when only some are cached.
- Background prefetch yields to outgoing save sync and manual switches. Check available space again at writes.
- Initial version uses ordinary copies and measured space. Content deduplication is an optional optimization;
  never hard-link mutable emulator files to immutable cached blobs.

### Offline guarantees

The list distinguishes `Available offline`, `Download required`, `Downloading`, `Needs attention`, and
`Not compatible here`. Show the last synchronization time; offline copies may not be the newest server version.
An empty Journey can be created offline. A cached Journey can be selected offline if its complete applicable
working set is available. A duplicate of **all** saves and states requires a complete source block locally;
otherwise offer to connect and complete it, rather than silently making an incomplete duplicate.

“All” means all known supported files, including auto-resume files, thumbnails and supported save directories.
Unknown/unreadable paths must be reported as incomplete coverage, not hidden behind a success message.
Journeys created on another device while disconnected cannot appear until metadata synchronization succeeds.

## 3. Existing implementation anchors

Inspect these again before implementation; this plan is not a substitute for reading the current code:

| Area | Existing files and implications |
|---|---|
| Data | `backend/prisma/schema.prisma`: `Save` uniqueness is currently user/emulator/kind/slot/baseName. `SaveVersion`, `SaveDeviceState`, `SaveConflict`, `MemoryCard`, `DeviceCard`, `CardEntryBase` already exist. |
| Identity | `DeviceRom` has path/hash/ROM association. `saves/core.ts::findLogicalSave` falls back to name and game; that must not cross Journey or exact-ROM boundaries. |
| Persistence | `backend/src/modules/saves/service.ts`: version keys, identification, history and files. |
| Agent API | `backend/src/modules/saves/agent.ts`: inventory, sync plans, device auth and space reports. |
| Server-side sync | `backend/src/modules/saves/sync.ts`: SSH/local/SD paths must use the same Journey rules. |
| Web API | `backend/src/modules/saves/routes.ts`: list, restore, upload, sharing/import must all be scoped. |
| Cards/folders | `cards.ts`, `cardcodec.ts`, `ps1card.ts`, `ps2card.ts`, `gccard.ts`, `pspsave.ts`: game entries and shared containers need explicit ownership. |
| Linux | `clients/linux/rommancer-sync.sh`: POSIX/BusyBox, locks, daemon, firmware hooks, sync and hash cache. `rommancer-ui.py`: gamepad UI. |
| Android | `SyncEngine.kt`, `WatchService.kt`, `SyncWorker.kt`, `ShellSync.kt`, `Api.kt`, `Store.kt`, `MainActivity.kt`, `Foreground.kt`, `Notices.kt`, `Frontends.kt`, `Dolphin.kt`, `PspSaves.kt`, `CtrSaves.kt` under `clients/android/app/src/main/java/com/rommancer/sync/`. |
| Android detection | `Foreground.kt` uses usage access or privileged foreground detection; unknown currently becomes false, and opening Sync itself changes the foreground. This is insufficient evidence that an emulator has exited. |
| Web | `frontend/src/pages/saves.tsx`, `game.tsx`, `device.tsx`; reuse their components and EN/ES translations. |
| Other clients | `clients/desktop`, `clients/playnite`, `clients/launchbox`: audit protocol participation and gate unsupported versions. Desktop is an npm workspace. |
| Tests | `backend/test/save-conflicts.test.ts`, `e2e.test.ts`, `retroarch-sorted.test.ts`, `ps1card.test.ts`, `gccard.test.ts`, `ctr.test.ts`. |

The reviewed worktree contained unrelated seed/media changes and an untracked `others/` directory. Preserve
user work. There were no project AGENTS.md or CLAUDE.md files found during the initial discovery.

## 4. UX contract

### Console navigation

Add **Journeys** to the existing home menu, near game-related actions. Open a local game list, prioritizing
recently played games; permit system filtering and search. Select a ROM, then show its Journeys. If several
ROMs have the same title, show region/revision and filename in details so the exact-ROM boundary is understandable.

Do not require choosing a Journey on every launch. Use the previous selection, defaulting to `Main` after migration.
Offer launcher shortcuts to the same selector where supported; do not make them mandatory for the feature.

```text
Pokémon Emerald · USA
Current journey: Main

✓ Main              Available offline
  Last played here · 2 hours ago

  Water challenge   Available offline
  Last updated on Retroid · yesterday

  First run         Download required · 180 MB

+ New journey
```

- Each row/card shows name, optional screenshot, local availability and latest known activity. Screenshot
  and timestamps are supporting information; never require them to distinguish Journeys.
- Use `Selected on this console` for the local marker. `Selected on Miyoo` is not evidence somebody is playing.
- Details show compatible saves/states, size, last sync and devices that last reported this selection.
- Actions: **Use on this console**, **Duplicate and switch**, **Rename**; archive is secondary.
- Focused selection is not activation. One deliberate confirm activates a ready target; no generic extra
  confirmation for an ordinary safe switch. Back before commit cancels preparation and retains the original.
- Gamepad-first, predictable focus after completion, no hover-only actions, non-color status cues and readable
  small-screen layouts. Match current frontend aesthetics rather than introducing a dashboard redesign.
- Onion can use short menus with the same semantics; pygame and Android can use richer cards/details.

### Create/duplicate

`New journey` offers `Start fresh` and `Duplicate current journey`. Name is optional with an editable generated
default. The primary buttons are **Create and switch** and **Duplicate and switch** respectively.

Duplicate explanation: `Copy every save and savestate from “Main”, then use the copy on this console.
“Main” keeps its progress.` Include unsynchronized local changes in the source checkpoint. A known conflict
must be resolved or explicitly choose the local/server source before the duplicate is created.

Progress: `Keeping Main safe` → `Preparing Water challenge` → `Switching journey` →
`Current journey: Water challenge`. Do not say `Synced` when only the local transaction succeeded.

Offline confirmation: `You are offline. Use the copy last synced yesterday? Changes will sync when connected.`
Completion: `Current journey: Water challenge · Saved on this console · Waiting to sync`.

### Running game

Represent detection as **running / stopped / unknown**, with ROM, emulator, session ID and evidence where known.
Do not infer stopped from loss of foreground, a missing permission, or a stale start/stop marker alone.

Default: `Close the game to switch from Main to Water challenge` with **Switch when closed** and **Cancel**.
Offer **Switch anyway…** as the explicit override where the adapter supports a safe capture boundary. The second
screen says: `The game is still running. Its next saves will belong to Water challenge. The running game will
not load Water challenge's existing progress. Close and reopen it to load those saves.`

This override is a **write-destination change**, not a claim to hot-load another game's RAM state:

1. Preserve both source and destination checkpoints first.
2. Do not inject the destination files under an active writer. Bind subsequent stable captures to the explicit
   new destination and retain its previous checkpoint as a recoverable version.
3. Track which files were actually written after the override. Do not mislabel unchanged source files as target
   data. At close, reconcile the manifest and materialize the target before the next launch.
4. If a complete capture cannot be safely separated from writes, or shared containers cannot be safely updated,
   explain `This emulator must be closed before switching` and keep the requested switch pending.

For ordinary unexpected late writes (no explicit override), preserve a recovery checkpoint, flag the
ambiguity and do not silently upload old-session content into the target. A hash alone cannot prove which
process wrote a file. Attribution must use session/selection context; when uncertain, require recovery review.

Launcher/in-app warning: `Journey changed while a game may still be open. New saves may affect Water challenge.
Close the game and review the saved copies.` Show an actionable persistent notice if a toast cannot be delivered.
Remote bulk requests never grant a live override. The local console owns that explicit decision.

### Web

Group by exact ROM and Journey in Saves and the game details. Inside a Journey expose saves, states, history,
compatibility and reported device selections. A web filter changes only what is viewed, never device selections.
Creating/duplicating on the web creates a Journey but cannot “switch this console”; the action is simply
**Create journey** / **Duplicate journey**. Console copy-and-switch behavior stays explicit in its own flow.

**Use on all consoles…** shows eligible devices, unsupported clients, last contact and running/unknown state.
Confirmation says it requests this exact ROM's Journey on the listed consoles. It does not install ROMs,
cross user accounts, or enroll future devices into a permanent global policy.

Per-device results: `Waiting for console`, `Waiting for game to close`, `Downloading`, `Applied`, `Not enough
space`, `Needs attention`, `Update required`, `Superseded`, `Cancelled`. Keep requested and last-confirmed selection
separate. A later local choice supersedes an unapplied request; never silently replay a stale remote selection.

### Conflicts and lifecycle

Retain existing divergence detection; add Journey/ROM/session context. At a coherent-manifest conflict show
`Main has different progress on Miyoo and Retroid`. Preserve both checkpoints. Offer **Keep this console's
progress**, **Use server progress**, or **Keep both as journeys**. The latter is an intentional duplicate, not
an automatic proliferation of numbered Journeys. Never choose by device timestamps.

For first release, archive rather than permanently delete a Journey. Block archival while known selections,
pending commands or dirty work reference it; offline writes to an archived Journey are preserved for recovery,
never discarded or silently reassigned. Server history retention and cache eviction are separate mechanisms.

## 5. Identity, manifest and data design

### Exact ROM identity

Introduce a stable content identity (`RomIdentity`) independent of mutable filenames and catalog row lifetime.
Scope it by platform and a verified payload/ordered multi-file digest. Map catalog `Rom` and device inventory
records to it only with exact evidence; preserve the identity if a catalog entry disappears.

Known exact catalog matches may share identity after validating variant/version evidence. Header removal or
container normalization must follow established verified ROM hashing semantics, not game-level heuristics.
Unknown ROMs require hashing; serial-only identification or similar names are insufficient. Unsupported
large/compressed content remains `ROM identity not verified` until hashed, rather than joining a game's saves.
Patched ROM bytes get a different identity. Multi-disc playlists need a stable ordered content-set identity
and cannot be merged merely because their discs belong to the same title. Renaming/moving does not change identity.

### Proposed entities (adapt names to project conventions)

- `Journey`: UUID generated on clients or server, owner, ROM identity, name, created/updated time, optional
  parent Journey and source checkpoint, archive status, current committed revision.
- `JourneyRevision`: immutable manifest, parent/base revision, source device/session, operation UUID, status
  (staging/committed/conflict), creation time. An empty manifest is a valid revision.
- `JourneyEntry`: manifest-relative logical key, kind, emulator/format compatibility, slot, file or directory
  member identity, size, checksum and immutable version/blob reference. Include tombstones in revision deltas.
- `DeviceJourneySelection`: unique device/ROM identity, last-confirmed Journey, monotonically increasing
  device selection generation and acknowledged operation. Local selection is authoritative for that device.
- `JourneyCommand`: operation UUID, target device/ROM/Journey, expected selection generation, lifecycle state
  and error. A bulk operation owns one command per eligible device.
- Local durable records: manifests/blobs, cached coverage, base revisions, dirty operations/outbox, game
  session, requested/applied selection, generation and switch journal. Account/server namespace is mandatory.

Reuse `SaveVersion` bytes/history where practical; add Journey ownership to logical saves and every lookup.
Replace uniqueness based on user/emulator/kind/slot/basename with a non-null logical scope that includes Journey
and artifact identity. Do not rely on nullable MySQL unique columns to isolate legacy records. Use an explicit
legacy scope during migration. Preserve existing card uniqueness until its adapter has migrated ownership.

`SaveDeviceState` bases must effectively include Journey and materialization generation. A different Journey
with identical bytes is not proof that it has the same synchronization base. Reset/rebind the local hash cache
after materialization so an unchanged size/mtime cannot reuse the outgoing Journey's hash.

### Snapshot and sync semantics

A checkpoint commits an immutable whole manifest only after all referenced blobs are verified. A directory
save is an ordered manifest of members, not a single guessed path. Capture a stable set, rescan to detect
changes, and do not advertise coherence while the adapter cannot provide it. File-by-file live uploads may
stage blobs; finalize the block at a stable boundary. Switching and duplication consume committed checkpoints.

Every upload/restore/download/ack includes Journey ID, exact ROM identity, base revision, operation ID and
selection/session generation where relevant. Validate device ownership and ROM/Journey association server-side.
Late uploads retain the Journey recorded when they were captured; never route them using the device's latest
selection. Reject stale active-directory downloads before any write. Inactive cache downloads need no switch.

Use compare-and-swap on the Journey's head revision. One concurrent writer advances it; another divergent
writer retains a conflict checkpoint. Do not auto-merge different file changes into a potentially incoherent
block in v1. A successful retry with the same operation ID must not create another Journey or revision.

An intentionally removed file is a tombstone in a captured manifest. A missing/unmounted/unreadable folder is
not a deletion. Switching to an empty manifest removes the outgoing ROM's known working files, including
auto-resume files, after preserving them; it must not trigger uploading these removals to the outgoing Journey.

## 6. Safe local switch algorithm

Serialize all local writers: daemon, watcher, hook, manual sync, remote command, SSH/SD entry point and recovery.
Use the existing process lock mechanism as a starting point; extend it to the Journey transaction. Coordinate
game launches through blocking hooks where supported. A local lock cannot lock an unrelated emulator process.

1. Resolve exact ROM and target Journey; validate adapter ownership/coverage and requested generation.
2. Detect session state. Defer if running/unknown unless explicit supported override or local closed-game
   confirmation in an integration without automatic detection. Recheck before destructive replacement.
3. Pause application of inbound files and watcher processing for the affected ROM; preserve queued events.
4. Capture the outgoing working set, including dirty local changes, into a verified durable checkpoint.
   Network acknowledgement is not required to switch offline; durable local preservation is required.
5. Resolve a pinned target revision. Fetch missing bytes if online, verify hashes, and check each volume's
   capacity including rollback/staging. If offline and required content is absent, keep the current selection.
6. Write a durable switch journal containing operation ID, old/new IDs/revisions/generations, complete owned
   path set, staging paths and rollback information. Prepare staged target files.
7. Replace only paths owned by this exact ROM and adapter. Remove outgoing-only artifacts, including stale
   auto-resume/thumbnail files. Do not clear an entire system folder or shared card.
8. Verify the working set against the materialization manifest, then durably commit the active selection and
   new generation. Do not report success after a partial copy. Resume watches with a known baseline.
9. Queue outgoing revision publication and selection acknowledgement with their original identities. Publish
   local offline Journey creation before its revision references and acknowledgements.
10. Retain rollback until verified recovery policy permits pruning; update UI and launcher notice.

Multiple directories/files cannot be atomically replaced by a single rename. Recovery must resume or roll back
from the journal after a crash at any step. SAF providers may lack atomic rename/fsync guarantees; use their
capabilities and read-back verification, and report weaker durability accurately. Refuse unsafe adapters
rather than leaving half a Journey active. Recovery runs before any sync or hooked game launch after startup.

## 7. Emulator adapters and shared containers

An adapter declares: file discovery, exact ownership, materialization mapping, read/write capabilities,
compatibility, session detection strength, live-override support and recovery strategy.

- RetroArch: SRAM, all discovered numbered states and auto-state, thumbnails and configured save/state folders.
  Do not arbitrarily cap slots to the current UI's visible range. Keep core/version compatibility metadata.
- NextUI: include minarch state and resume conventions; invalidate/restore launcher resume metadata if it can
  reopen the wrong state. Audit Onion game-switcher/resume behavior similarly.
- Directory saves (PSP/3DS and supported others): checkpoint all game-owned members as a set. Preserve permissions
  and document SAF grants; permission loss prevents switching and is not interpreted as an empty Journey.
- Per-game memory cards: whole-card replacement is acceptable only if exact ownership is proven.
- Shared cards: never move the entire card into one ROM's Journey. Preserve other games' entries byte-for-byte
  semantically using the existing codecs; snapshot the full card for rollback. Switch only identified entries.
  Some entries expose only a game serial and cannot prove exact ROM ownership: require an explicit verified
  binding or report switching unsupported. Do not guess which regional variant owns them.
- Auto-resume and savestate compatibility remain emulator-specific; a Journey does not convert incompatible
  states. Store incompatible variants but do not install them. Show why only in-game saves are usable here.
- BIOS/configuration, achievements credentials, ROMs and unrelated screenshots are not Journey content.

The implementation must publish a tested capability matrix. V1 cannot claim universal “all saves” coverage
while a card or emulator adapter silently bypasses the isolation rules.

## 8. API/protocol contract

Suggested authenticated routes, under existing `/api/v1` conventions (new routes, not existing APIs):

| Operation | Proposed contract |
|---|---|
| List | `GET /journeys?romIdentityId=...`, including revision, bytes and device selection reports. |
| Create/duplicate | `POST /journeys` with client UUID, identity, name, optional immutable source revision and idempotency key. Console switching is a subsequent local transaction. |
| Rename/archive | `PATCH /journeys/:id`, with expected metadata revision; no implicit device switch. |
| Read snapshot | `GET /journeys/:id/revisions/:revision`, authorized manifest and artifact downloads. |
| Stage/commit | Stage immutable bytes, then commit revision with expected base and operation ID. Return conflict without discarding staged progress. |
| Device sync | Extend agent capabilities and inventory to report selection/generation, sessions, cached coverage, dirty operations and commands acknowledged. |
| Bulk selection | `POST /journeys/:id/switch-requests` with explicit device IDs and per-device expected generations; create one-time commands. |
| Command results | Agent result route accepts command ID, expected generation, result and applied revision; duplicate acknowledgements are harmless. |

Keep POSIX transport practical: versioned line protocol records with safely encoded text/paths for the shell
client, JSON for richer clients if useful, both backed by one server contract. Do not make `jq`, Python or
SQLite a mandatory new dependency on BusyBox devices without updating installers and proving availability.
Use random client UUIDs through an available platform source and a tested shell fallback.

Old clients do not understand Journey isolation. Negotiate a capability/version before offering commands or
Journey-scoped writes. A legacy client may remain in the explicit legacy/default namespace for unmigrated
ROMs; once a ROM/device is Journey-enabled, refuse ambiguous old writes with `Update required`. Never map an
old upload to whichever Journey currently happens to be selected. Audit desktop/launcher integrations too.

Local selections made after a remote request supersede it using generations, including changes made offline.
On reconnect, upload selection events in local sequence and do not replay older remote intentions. Content
conflicts and selection-command conflicts are distinct. Account changes isolate stores and credentials.

## 9. Migration and rollout

1. Add schema/entities and protocol behind a capability flag. Inventory exact identity and adapter coverage.
2. Build a migration dry-run report: unambiguous saves, ambiguous identity, shared cards and unsupported clients.
3. For unambiguous user/exact-ROM groups, create `Main`, attach existing logical saves/history and create initial
   manifests. Preserve version bytes and conflict records. Make the migration resumable and idempotent.
4. Never attach basename/game-only saves to an arbitrary ROM. Keep them in a visible legacy/import-review group;
   unresolved items must not block unrelated supported ROMs. Historical cross-ROM sharing may be irreversible
   to infer: ask for attribution rather than duplicating it invisibly.
5. On first updated-client contact, preserve local files before applying server data. Register its selection
   as `Main` only after reconciling local progress. Migrate hash bases and isolate all background entry points.
6. Enable switching only on adapters proven to support the transaction, then roll out Android and Linux UIs.
7. Enable web bulk requests once per-device acknowledgements and old-client gating are verified.
8. Rollback means disable new switching/commands while continuing to preserve scoped data. Do not downgrade to
   an old writer that flattens Journeys. Take DB/file backups before migration; no destructive schema rollback.

## 10. Implementation work packages

Execute in order; each package must meet its exit condition before the next dependent package ships.

1. **Identity and adapter audit:** map current discovery paths and exact hashing, enumerate resume artifacts,
   storage providers and launcher hooks, record the capability matrix and sample manifests. Verify RetroDECK
   APIs/hooks on its actual packaging; do not assume ES-DE script installation alone covers sandboxed emulators.
   Exit: supported baseline adapters and limitations are explicit.
2. **Schema and scoped persistence:** new migration via `npm run migration:new -w backend -- journeys`; implement
   exact identity, Journeys, immutable revisions, scoped keys, staged commit and migration dry run. Exit: two
   Journeys with the same filenames remain independent and foreign-user references are rejected.
3. **Protocol and reconciliation:** capability negotiation, idempotent creation/revisions, selection generations,
   durable commands and conflict manifests. Update all service/API entry points including restore, shared-save
   import, cards and SSH/SD. Exit: no old request or stale response can route data to a different Journey.
4. **Local transaction engines:** Linux and Android stores, manifests, journal, recovery, storage policy, offline
   outbox, materialization and watcher suppression. Prefer focused helper modules over growing monolithic UIs.
   Exit: fault injection never loses the outgoing set or reports a partial target as active.
5. **Session/launcher integrations:** running/stopped/unknown detection, queued switches, supported explicit
   overrides, persistent warnings and resume handling. Exit: open-game and missed-hook scenarios pass.
6. **Console UX:** selector, create-and-switch, duplicate-and-switch, offline and capacity states, gamepad flow.
   Exit: user can change and return between two complete blocks on Android and a supported Linux handheld.
7. **Web UX and bulk orchestration:** browse by ROM/Journey, history, device state, command review/progress and
   cancellation. Exit: one offline console does not make another console falsely appear switched.
8. **Migration/release verification:** upgrade fixtures, real-device matrix, compatibility gates and updated
   `docs/sync.md`, `docs/clients-ux.md`, README limitations and installer/version manifests as appropriate.
   Exit: all mandatory acceptance scenarios pass and the release names unsupported adapters clearly.

Full desktop UI parity can follow Android/Linux, but its sync engine must be scoped or gated before server
rollout. Do not postpone isolation on an existing client that can still write into migrated records.

## 11. Mandatory acceptance tests

### Core behavior

- Same ROM: console A selects Main, B selects Challenge; independent saves and all state slots survive syncing.
- Same Journey on both: sequential play syncs; divergent offline play preserves coherent alternatives.
- Fresh Journey has no prior SRAM, numbered states, auto-resume or stale thumbnail; switching back restores all.
- Duplicate includes unsynced local work, changes selection only on that console, and never mutates the source.
- Rename/move of the exact ROM keeps identity; different region, revision, patch or same basename does not merge.
- Incompatible emulator states remain stored but are not installed; compatible saves continue to work.

### Offline/storage/transactions

- Cached switch, fresh creation and complete duplication offline; reconnect remains idempotent and scoped.
- Uncached target or incomplete full-block duplication offline leaves the active block unchanged with a reason.
- Full disk before and during copy, read-only filesystem, SD removal, revoked SAF permission and failed hashes.
- Kill/power-loss simulation after every journal step, including commit-before-ack; recovery is deterministic.
- Outgoing-only files are removed safely; watcher callbacks never upload materialization as fresh gameplay.
- Clean cache eviction cannot delete dirty/active/pinned/recovery data. Prefetch and staging honor each volume.
- App/account switch and reconnect do not expose another account's cache or replay its operations.

### Sessions/concurrency

- Known running game queues the default switch. Opening Sync does not make a background emulator “closed”.
- Unknown detection gives honest UX; no silently inferred stopped state on Android without permission.
- Explicit supported override preserves both pre-change checkpoints, warns, and assigns only actual subsequent
   captures to the confirmed destination. Unsupported adapters keep the operation pending.
- Unexpected late writes are retained for recovery, not silently attributed to the newly selected Journey.
- Daemon/manual/SSH/hook concurrency, stale downloads, delayed uploads, retry after network loss and old clients.
- New local choice supersedes pending remote command; repeated bulk requests/acks cannot undo a later choice.

### Cards, migration and UX

- Shared card switch preserves other games; unknown entry ownership blocks the switch instead of guessing.
- Directory save members and deletions commit together; missing mounts do not become tombstones.
- Ambiguous legacy identities remain reviewable, migration reruns do not duplicate history, old bases do not leak.
- Gamepad-only navigation on Android/pygame/Onion: create, duplicate, switch, cancel, offline warning and recovery.
- Web EN/ES labels, no global-active indicator, separate requested/applied states, accessible non-color status.
- RetroDECK and another supported launcher: warning is actually visible, not merely written to a log.

Suggested checks after implementation (not run for this planning-only change):

- `npm test -w backend` (requires the documented test database/services).
- `npm run build -w backend` and `npm run build -w frontend` (includes frontend i18n check).
- `sh -n clients/linux/rommancer-sync.sh`; exercise the actual script against temporary emulator layouts/API
  fixtures using BusyBox-compatible tools, not only mocked TypeScript behavior.
- `python3 -m py_compile clients/linux/rommancer-ui.py` after UI changes.
- From `clients/android`: `./gradlew :app:testDebugUnitTest :app:assembleDebug`, plus device tests for SAF,
  background emulators and process death. Build success alone cannot verify lifecycle integration.
- Run affected desktop checks if its sync or protocol integration changes; inspect its current scripts first.

## 12. Handoff boundaries

Do not implement a server-only selector that silently changes every console. Do not implement Journey as
another savestate slot or as a zip copied over an entire saves directory. Do not use timestamps as authority.
Do not claim emulators can hot-load Journeys. Do not promise all Journeys are offline until verified cached.

The implementer should start with work package 1 and the exact-identity/storage transaction spike, then use
the tests above as delivery gates. Name and storage reserve are adjustable presentation/policy decisions;
exact-ROM isolation, preservation of both blocks and independent device selection are not negotiable.
