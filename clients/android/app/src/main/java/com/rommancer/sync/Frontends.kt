package com.rommancer.sync

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import org.json.JSONArray
import java.io.File

/**
 * The RetroArch cores and standalone emulators the frontends on this device run each system and game with: Daijishō's
 * players (its database, which only root reads), ES-DE's emulators (its bundled systems, custom systems and gamelists)
 * and Pegasus's launch commands. Sent with each sync as "fsys<TAB>folder<TAB>core<TAB>platform" and "fgame<TAB>rom<TAB>
 * core" lines, a standalone emulator as "emu:<emulator>"; the server takes them for the games whose saves it never saw
 * here, so a save arriving goes to the right core's folder.
 */
class Frontends(private val context: Context, private val root: File) {
    /** What each frontend gave, for the device's log */
    val notes = mutableListOf<String>()

    fun lines(romsDir: File?): String {
        val out = StringBuilder()
        runCatching { daijisho(out) }.onFailure { notes += "daijisho: ${it.message}" }
        runCatching { esde(out, romsDir) }.onFailure { notes += "es-de: ${it.message}" }
        runCatching { pegasus(out) }.onFailure { notes += "pegasus: ${it.message}" }
        return out.toString()
    }

    private fun clean(s: String) = s.replace('\t', ' ').replace('\n', ' ')

    private fun system(out: StringBuilder, folder: String, core: String, platform: String) {
        out.append("fsys\t").append(clean(folder)).append('\t').append(clean(core)).append('\t').append(clean(platform)).append('\n')
    }

    private fun game(out: StringBuilder, rom: String, core: String) {
        out.append("fgame\t").append(clean(rom)).append('\t').append(clean(core)).append('\n')
    }

    private fun installed(pkg: String) = runCatching { context.packageManager.getPackageInfo(pkg, 0) }.isSuccess

    // --- Daijishō ---

    /** A storage document as a path: "primary:ROMs/gba" is internal storage's, "1234-ABCD:..." an SD card's */
    private fun documentPath(docId: String): String? {
        val (volume, rel) = docId.split(':', limit = 2).takeIf { it.size == 2 } ?: return null
        val base = if (volume == "primary") root.path else "/storage/$volume"
        return if (rel.isEmpty()) base else "$base/$rel"
    }

    /** The folder of a tree uri (content://.../tree/primary%3AROMs%2Fgba) or the file of a document uri in it */
    private fun safPath(uri: String): String? {
        val segs = runCatching { Uri.parse(uri).pathSegments }.getOrNull() ?: return null
        val doc = segs.indexOf("document").takeIf { it >= 0 }?.let { segs.getOrNull(it + 1) }
        val tree = segs.indexOf("tree").takeIf { it >= 0 }?.let { segs.getOrNull(it + 1) }
        return documentPath(doc ?: tree ?: return null)
    }

    /**
     * The core of a launch command (Daijishō's and Pegasus's "-e LIBRETRO <core>", ES-DE's "%EXTRA_LIBRETRO%=<core>"),
     * else the standalone emulator it starts, as "emu:<emulator>"
     */
    private fun emulatorOf(command: String): String? = coreOf(command) ?: standaloneOf(command)

    /** A standalone emulator Rommancer reads, by its name in a label, an app id or an ES-DE emulator variable */
    private fun standaloneOf(text: String): String? {
        val t = text.lowercase()
        return STANDALONE.firstOrNull { (key) -> key in t }?.let { "emu:${it.second}" }
    }

    private fun coreOf(command: String): String? {
        Regex("""%EXTRA_LIBRETRO%=(\S+)""").find(command)?.let { return it.groupValues[1] }
        val args = Regex(""""[^"]*"|\S+""").findAll(command).map { it.value.trim('"') }.toList()
        val i = args.indexOfFirst { it == "LIBRETRO" }
        return if (i > 0 && args[i - 1] in setOf("-e", "--es")) args.getOrNull(i + 1) else null
    }

    private fun daijisho(out: StringBuilder) {
        val pkg = "com.magneticchen.daijishou"
        if (!installed(pkg)) return
        val dir = File(context.cacheDir, "daijishou").apply { mkdirs() }
        val name = "Daijishou.db"
        val db = Privileged.rootRead("/data/data/$pkg/databases/$name")
        if (db == null) {
            notes += "daijisho: installed, its library needs root"
            return
        }
        File(dir, name).writeBytes(db)
        // Changes not yet in the database file are in its write-ahead log, read with it
        val wal = Privileged.rootRead("/data/data/$pkg/databases/$name-wal")
        File(dir, "$name-wal").let { if (wal != null) it.writeBytes(wal) else it.delete() }
        File(dir, "$name-shm").delete()
        val sql = SQLiteDatabase.openDatabase(File(dir, name).path, null, SQLiteDatabase.OPEN_READWRITE)
        try {
            val players = HashMap<Long, String>()
            sql.rawQuery("SELECT * FROM PlayerEntity", null).use { c ->
                val id = c.getColumnIndex("id")
                val args = c.getColumnIndex("am_start_arguments")
                while (c.moveToNext()) if (id >= 0 && args >= 0) players[c.getLong(id)] = c.getString(args) ?: ""
            }
            var systems = 0
            var games = 0
            sql.rawQuery("SELECT * FROM PlatformEntity", null).use { c ->
                val nameCol = c.getColumnIndex("name")
                val player = c.getColumnIndex("default_player_id")
                val trees = c.getColumnIndex("items_sync_tree_uri_list")
                while (c.moveToNext()) {
                    val core = players[if (player >= 0 && !c.isNull(player)) c.getLong(player) else -1L]?.let(::emulatorOf) ?: continue
                    val platform = if (nameCol >= 0) c.getString(nameCol) ?: "" else ""
                    val list = if (trees >= 0) c.getString(trees) else null
                    val folders = runCatching { JSONArray(list ?: "[]").let { a -> (0 until a.length()).map { a.getString(it) } } }.getOrDefault(emptyList()).mapNotNull(::safPath)
                    for (f in folders.ifEmpty { listOf("") }) {
                        system(out, f, core, platform)
                        systems++
                    }
                }
            }
            sql.rawQuery("SELECT * FROM PlayableItemEntity", null).use { c ->
                val uri = c.getColumnIndex("uri")
                val custom = c.getColumnIndex("use_custom_player")
                val player = c.getColumnIndex("custom_player_id")
                while (c.moveToNext()) {
                    if (uri < 0 || custom < 0 || player < 0 || c.getInt(custom) == 0 || c.isNull(player)) continue
                    val core = players[c.getLong(player)]?.let(::emulatorOf) ?: continue
                    val rom = safPath(c.getString(uri) ?: continue) ?: continue
                    game(out, rom, core)
                    games++
                }
            }
            notes += "daijisho: ${players.size} players, $systems platform folders with a core or standalone emulator, $games games with their own"
        } finally {
            sql.close()
            dir.deleteRecursively()
        }
    }

    // --- ES-DE ---

    private class EsSystem(val name: String, val folder: String, val commands: List<Pair<String, String?>>)

    /** ES-DE's bundled systems (assets/esde_android.tsv), each with its emulators' labels and cores */
    private fun bundled(): MutableMap<String, EsSystem> {
        val rows = context.assets.open("esde_android.tsv").bufferedReader().readLines().filter { it.isNotBlank() && !it.startsWith("#") }.map { it.split('\t') }.filter { it.size == 4 }
        val out = LinkedHashMap<String, EsSystem>()
        for ((name, group) in rows.groupBy { it[0] }) out[name] = EsSystem(name, group[0][1], group.map { it[2] to (it[3].takeIf { c -> c != "-" } ?: standaloneOf(it[2])) })
        return out
    }

    private fun tag(block: String, name: String) = Regex("<$name>([^<]*)</$name>").find(block)?.groupValues?.get(1)?.trim()

    private fun unescape(s: String) = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")

    private fun esde(out: StringBuilder, romsDir: File?) {
        val dir = File(root, "ES-DE")
        val roms = romsDir ?: return
        if (!dir.isDirectory) return
        val systems = bundled()
        // The user's own systems replace the bundled ones of the same name (all of them with loadExclusive)
        File(dir, "custom_systems/es_systems.xml").takeIf { it.canRead() }?.readText()?.let { text ->
            if (text.contains("<loadExclusive")) systems.clear()
            for (m in Regex("<system>(.*?)</system>", RegexOption.DOT_MATCHES_ALL).findAll(text)) {
                val block = m.groupValues[1]
                val name = tag(block, "name") ?: continue
                val commands = Regex("""<command(?:\s+label="([^"]*)")?\s*>([^<]*)</command>""").findAll(block).map { unescape(it.groupValues[1]) to unescape(it.groupValues[2]).let { c -> if ("%EMULATOR_RETROARCH%" in c) coreOf(c) else standaloneOf(c) } }.toList()
                if (commands.isNotEmpty()) systems[name] = EsSystem(name, (tag(block, "path") ?: "").substringAfter("%ROMPATH%/"), commands)
            }
        }
        var count = 0
        for (s in systems.values) {
            val folder = File(roms, s.folder)
            if (!folder.isDirectory) continue
            val gamelist = File(dir, "gamelists/${s.name}/gamelist.xml").takeIf { it.canRead() }?.readText() ?: ""
            val pick = Regex("<alternativeEmulator>.*?<label>([^<]*)</label>", RegexOption.DOT_MATCHES_ALL).find(gamelist)?.groupValues?.get(1)?.let(::unescape)
            val core = { label: String? -> (s.commands.firstOrNull { it.first == label } ?: s.commands.first()).second }
            core(pick)?.let { system(out, folder.path, it, s.name); count++ }
            for (g in Regex("<game>(.*?)</game>", RegexOption.DOT_MATCHES_ALL).findAll(gamelist)) {
                val alt = tag(g.groupValues[1], "altemulator")?.let(::unescape)?.takeIf { it.isNotEmpty() } ?: continue
                val path = tag(g.groupValues[1], "path")?.let(::unescape) ?: continue
                val c = core(alt) ?: continue
                game(out, File(folder, path.removePrefix("./")).path, c)
            }
        }
        notes += "es-de: $count systems with a core or standalone emulator"
    }

    // --- Pegasus ---

    private fun pegasus(out: StringBuilder) {
        val homes = listOf(File(root, "pegasus-frontend"), File(root, "Android/data/org.pegasus_frontend.android/files/pegasus-frontend")).filter { it.isDirectory }
        if (homes.isEmpty()) return
        val metas = homes.flatMap { home ->
            val dirs = File(home, "game_dirs.txt").takeIf { it.canRead() }?.readLines()?.map { it.trim() }?.filter { it.isNotEmpty() && !it.startsWith("#") }.orEmpty()
            dirs.mapNotNull { d -> listOf("metadata.pegasus.txt", "metadata.txt").map { File(File(d).let { f -> if (f.isAbsolute) f else File(home, d) }, it) }.firstOrNull { it.canRead() } } +
                (File(home, "metafiles").listFiles()?.filter { it.name.endsWith(".txt") }?.sorted().orEmpty())
        }
        var count = 0
        for (meta in metas) {
            var collection: Triple<String, String, String>? = null // name, shortname, launch
            var inGame = false
            var gameFiles = mutableListOf<String>()
            var gameLaunch = ""
            fun endCollection() {
                val (name, short, launch) = collection ?: return
                emulatorOf(launch)?.let { system(out, meta.parent ?: "", it, short.ifEmpty { name }); count++ }
            }
            fun endGame() {
                if (inGame) emulatorOf(gameLaunch)?.let { c -> gameFiles.forEach { f -> game(out, File(meta.parentFile, f).path, c) } }
                inGame = false
                gameFiles = mutableListOf()
                gameLaunch = ""
            }
            val entries = mutableListOf<Pair<String, String>>()
            for (line in meta.readLines()) {
                if (line.isBlank() || line.trimStart().startsWith("#")) continue
                if (line.first().isWhitespace()) {
                    if (entries.isNotEmpty() && line.trim() != ".") entries[entries.size - 1] = entries.last().let { it.first to it.second + "\n" + line.trim() }
                } else line.split(':', limit = 2).takeIf { it.size == 2 }?.let { entries += it[0].trim().lowercase() to it[1].trim() }
            }
            for ((k, v) in entries) when (k) {
                "collection" -> { endGame(); endCollection(); collection = Triple(v, "", "") }
                "game" -> { endGame(); inGame = true }
                "shortname" -> if (!inGame) collection = collection?.copy(second = v)
                "launch", "command" -> if (inGame) gameLaunch = v.replace('\n', ' ') else collection = collection?.copy(third = v.replace('\n', ' '))
                "file", "files" -> if (inGame) gameFiles += v.split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }
            }
            endGame()
            endCollection()
        }
        notes += "pegasus: ${metas.size} metadata files, $count collections with a core or standalone emulator"
    }

    private companion object {
        /** Standalone emulators by a word of their names and app ids, and the emulator the server knows them as */
        val STANDALONE = listOf(
            "duckstation" to "duckstation",
            "aethersx2" to "pcsx2", "nethersx2" to "pcsx2", "armsx2" to "pcsx2",
            "ppsspp" to "ppsspp",
            "dolphin" to "dolphin-gci",
            "melonds" to "melonds", "melondualds" to "melonds",
            "azahar" to "azahar", "citra" to "azahar", "lime3ds" to "azahar",
        )
    }
}
