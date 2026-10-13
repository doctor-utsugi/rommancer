Video game ROM manager project.

- It has a database fed by existing ones such as No-Intro
- Besides the roms table, it needs a games table: Gran Turismo 2 the game, as a concept, is one thing, and its many roms (the PAL version, the NTSC one, the Japanese one, 1.2, etc...) are another. The roms in the roms table must be linked to those in the games table
- It must also link romhacks to games
- I must be able to tell it which paths my roms are in, and it must automatically detect which ones I have and which ones I am missing compared to the database of all games
- One of the most important features is that the program lets me build lists of games, whether of specific roms or of games in general
- The program must use rom checksums, not check by name, and help me sort into folders and rename roms properly according to standards
- The program must be multi-user. Different users can create their own lists and share them, etc
- Non-admin users can help complete the collection by uploading roms, but only if the rom matches the hash of a rom in the database or in RetroAchievements
- The program must be able to copy the roms of a list to a destination, for example an SD card for an emulation console
- An important feature is that, from a favourites list, it can create a sublist made, for example, of the Euro or USA alternatives of the roms, or the RetroAchievements-compatible ones
- The program must be able to help me scrape covers, screenshots and manuals for the roms, using external services; no need to reinvent the wheel
- Users can register their consoles or machines in the program, stating which console and firmware they have, such as AYN Thor with Android, or AYN Thor with Rockix (console and firmware tables?), and the SSH paths or SD cards where their roms / savegames / savestates go
- The program must also be a savegame and savestate manager that helps copy them between emulation consoles or computers, a kind of Steam Cloud for roms, able at the very least to keep savegames per different RetroArch emulator/core, but ideally converting them so they work in the different emulators, plus backup management so saves are not lost by accident
- I want it built with a node backend, mysql, prisma and express, and a react frontend with typescript and shadcn. Use Podman, not Docker
