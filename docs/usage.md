# Using Rommancer

1. Administration > Databases: the DATs for every console are loaded from the seed. The global (weekly) sync checks libretro-database, Retool, RetroAchievements and Wikidata and only downloads what changed; it can be forced per source and per system.
2. Administration > Paths: register the rom folders and scan. The system is detected by folder or extension. Each path can be the destination for new roms (uploads, patches) of one or several systems; with no destination, the default one or `DATA_DIR/library` is used.
3. Games / Missing: see what you have and what you lack. Add games, roms or romhacks to lists.
4. Lists: share, create sublists with alternatives by region, language or RetroAchievements compatibility, download as zip or send to a device.
5. Devices: register console + firmware (templates for Knulli, Batocera, ROCKNIX, muOS, ArkOS, NextUI, Onion, Android, RetroArch) and their local or SSH path. Those that run event scripts (ES-DE on Android and Linux, Batocera, Knulli, ROCKNIX) are registered as "agent": Rommancer generates the scripts with their own token; when a game starts they download the adapted save and when it closes they upload it. If the server and the device both change, both versions are kept and a warning is shown. SD cards mounted on the server sync when they connect; the rest, by hand.
6. Uploading roms: with permission, those that match the database or RetroAchievements by hash; with another permission, unverified roms (homebrew, hacks, translations), which do not count in the percentages and become verified if a later DAT includes them.
7. Per-user permissions in Administration > Users (also in invitations). By default: view the collection, lists, saves and media of their lists with their own account.
8. Grouping review: conflicts between sources and doubtful Wikidata links.

## Data seed

The `seed/` folder holds the DATs for every supported console (No-Intro, Redump, FBNeo and libretro-database hacks), the synced RetroAchievements hashes and everything scraped (metadata and media).

- On startup the API applies the seed (Administration > Server, on by default): it imports the DATs that are missing and the RA hashes, and fills in metadata and covers for games that lack them. Anything already imported is skipped, so a normal start is quick.
- After importing DATs, syncing or scraping, the seed updates itself (Administration > Server, on by default). It can also be exported or applied by hand in Administration > Integrations.
- It holds the accumulated total: nothing obtained from external sources is deleted even if it disappears from the origin. It also includes grouping evidence (Retool, ScreenScraper), manual decisions, "not found" entries, the local Wikidata subset, patches (`seed/patches`), Retool lists and the media (`seed/media` images, `seed/media-large` manuals and videos).
- With ScreenScraper content the seed is for private use only: do not publish the repository with that data.
- In containers it is mounted at `/seed` (`compose.yaml` and Quadlet). For a new deployment, just copy the folder.

## Known limitations

- RVZ/WIA are read with a port of Dolphin's code (`backend/src/lib/rvz.ts`): the original ISO is rebuilt, including the encryption and the hashes of Wii partitions, without needing `dolphin-tool`.
- RVZ/WIA: Zstandard and uncompressed (RVZ) and PURGE (WIA) compression are supported. WIA files with bzip2/LZMA cannot be read.
- GameCube WBFS and CISO do not keep the original image: they are identified by disc id and revision and stay unverified. CSO/ZSO are verified against Redump.
- Daijishō has no documented game events: its devices sync by hand.
- Memory cards: PS1 and GameCube (Dolphin, GCI folders and `.raw` images); PS2 and PSP will come later. The Android app uploads its PS1 cards but does not write them, because it cannot know whether an emulator is open. Dolphin saves for Android (`.gci` files) do sync both ways, once you give it access to the Dolphin folder from the app menu. Desktop Dolphin's are not searched for yet.
- Savestates are not converted between emulators (they only sync between devices with the same emulator). Each one stores the version of the core that made it, and a warning is shown if another console has a different one; screenshots only come from RetroArch and NextUI.
- PS3 and Xbox 360 are out of scope.
