# Lists

A list holds **roms** (and romhacks, which are files too). Adding a game or a multi-platform work from the
web app adds its best rom: owned ones first, then achievements, clean dumps and the newest revision. A game
known only through romhacks goes in as its romhack. Lists saved with games or works before are converted the
same way when the server starts (`convertLegacyItems`).

## Favourites

Each user has one list of kind `favorites`, named in their language and always first. It cannot be deleted
or renamed. It is kept in step with the star on each rom (`RomFavorite`): starring a rom adds it, adding a rom
to the list stars it, and removing it from the list unstars it. It goes to consoles like any other list, with
each device's own system and game filters.

## Sublists

A sublist holds the same games as its parent, in the version its filters ask for:

- regions (any of them; "World" always counts) and languages (at least one), with shortcuts for NTSC,
  NTSC-U, NTSC-J, PAL and Spanish;
- only with RetroAchievements, only owned, only verified (not hand uploads), and whether betas, prototypes and
  demos count;
- platforms in order, to take the same work from another system.

`POST /lists/:id/derive/preview` returns the games that have such a version and, for those that do not, all
their versions. The web app then asks, game by game: leave it out, or take another version, optionally doing
the same for the rest (leave them out, or take the version most like the one chosen, else whatever there is).

The sublist keeps its filters and these decisions (`derivedFilter`: `{ v: 2, filters, perGame, rest }`), so
"Refresh" repeats them, and sublists of a list are worked out again whenever it changes (favourites included).
