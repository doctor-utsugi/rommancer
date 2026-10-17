package com.rommancer.sync

import android.content.Context
import java.io.File
import java.util.Locale

/**
 * ES-DE collections: the games whose save is synced, and the roms Rommancer copied in the last two weeks. Only
 * Rommancer's own files in ES-DE/collections are written, and only when their content changes; ES-DE shows them
 * once they are ticked in its collection settings and reads them when it starts.
 * Also the names of the lists' games ES-DE knows nothing about (see [names]).
 */
object EsDe {
    private const val DAYS = 14L

    private fun record(context: Context) = File(context.filesDir, "received-roms")

    /** Notes a rom Rommancer copied, for the "new" collection */
    fun received(context: Context, dest: File) {
        runCatching { record(context).appendText("${System.currentTimeMillis() / 1000}\t${dest.path}\n") }
    }

    /** True when the collection of a list changed, came or went */
    fun write(context: Context, api: Api, root: File): Boolean {
        val dir = File(root, "ES-DE/collections")
        if (!dir.isDirectory) return false
        val savesName = "Rommancer - With saves"
        val newName = "Rommancer - New"
        val romsDir = api.text("/agent/roots").lines().firstOrNull { it.startsWith("roms\t") }?.substringAfter('\t')
        val lines = api.text("/agent/collections").lines()
        val saves = lines.filter { it.startsWith("saves\t") }.map { it.substringAfter('\t') }.distinct().sorted()
        // The lists given to this device, one collection each in the list's order
        val lists = LinkedHashMap<String, MutableList<String>>()
        for (l in lines) {
            val f = l.split('\t')
            if (f.size == 3 && f[0] == "list") lists.getOrPut("Rommancer - " + f[1].replace(Regex("""[/\\:*?"<>|]"""), " ").trim()) { mutableListOf() }.let { if (f[2] !in it) it += f[2] }
        }
        // The last two weeks' arrivals that are still there, the newest first; older lines are dropped from the record
        val since = System.currentTimeMillis() / 1000 - DAYS * 86400
        val file = record(context)
        val recorded = if (file.exists()) file.readLines().mapNotNull { l -> l.split('\t', limit = 2).takeIf { it.size == 2 }?.let { (it[0].toLongOrNull() ?: 0L) to it[1] } } else emptyList()
        val recent = recorded.filter { it.first >= since }
        if (recent.size != recorded.size) file.writeText(recent.joinToString("") { "${it.first}\t${it.second}\n" })
        val fresh = recent.sortedByDescending { it.first }.map { it.second }.distinct().filter { File(it).isFile }
        put(File(dir, "custom-$savesName.cfg"), saves.map { esPath(it, romsDir) })
        put(File(dir, "custom-$newName.cfg"), fresh.map { esPath(it, romsDir) })
        // Only the lists' collections are worth telling about (the other two change with every game played or copied)
        var changed = false
        for ((name, paths) in lists) changed = put(File(dir, "custom-$name.cfg"), paths.map { esPath(it, romsDir) }) || changed
        // Collections of lists no longer given to this device
        val kept = setOf(savesName, newName) + lists.keys
        dir.listFiles()?.filter { it.name.startsWith("custom-Rommancer - ") && it.name.endsWith(".cfg") && it.name.removePrefix("custom-").removeSuffix(".cfg") !in kept }?.forEach { it.delete(); changed = true }
        return changed
    }

    /** ES-DE keeps the games of its collections relative to its ROM folder */
    private fun esPath(path: String, romsDir: String?) =
        if (romsDir != null && path.startsWith("$romsDir/")) "%ROMPATH%/" + path.removePrefix("$romsDir/") else path

    /** True when FILE was written */
    private fun put(file: File, lines: List<String>): Boolean {
        val text = lines.joinToString("") { "$it\n" }
        if (file.exists() && file.readText() == text) return false
        file.writeText(text)
        return true
    }

    /** A game of the lists as the server names it: "meta<TAB>dest<TAB>name<TAB>sortname<TAB>description" */
    data class Meta(val dest: String, val name: String, val sortName: String, val desc: String)

    fun parseMeta(lines: List<String>) = lines.mapNotNull { l -> l.split('\t').takeIf { it.size >= 5 && it[0] == "meta" }?.let { Meta(it[1], it[2], it[3], it[4]) } }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    private fun unesc(s: String) = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")

    /** GAMELIST plus an entry for each of WANTED ("./x.sfc") it lacks; null when nothing is missing. Existing entries stay */
    fun addEntries(gamelist: String?, wanted: List<Pair<String, Meta>>): Pair<String, Int>? {
        val text = gamelist?.takeIf { it.isNotBlank() } ?: "<?xml version=\"1.0\"?>\n<gameList>\n</gameList>\n"
        val end = text.lastIndexOf("</gameList>").takeIf { it >= 0 } ?: return null
        val have = Regex("<path>([^<]*)</path>").findAll(text).map { unesc(it.groupValues[1].trim()) }.toHashSet()
        val add = StringBuilder()
        var n = 0
        for ((path, m) in wanted) {
            if (!have.add(path)) continue
            add.append("\t<game>\n\t\t<path>${esc(path)}</path>\n\t\t<name>${esc(m.name)}</name>\n")
            if (m.sortName.isNotEmpty()) add.append("\t\t<sortname>${esc(m.sortName)}</sortname>\n")
            if (m.desc.isNotEmpty()) add.append("\t\t<desc>${esc(m.desc)}</desc>\n")
            add.append("\t</game>\n")
            n++
        }
        return if (n == 0) null else text.substring(0, end) + add + text.substring(end) to n
    }

    /** Gives the lists' games ES-DE has no entry for the server's name, so they are not listed by file name; returns how many */
    fun names(root: File, romsDir: String?, metas: List<Meta>): Int {
        val dir = File(root, "ES-DE")
        if (romsDir == null || !File(dir, "settings").isDirectory) return 0
        val custom = HashMap<String, String>()
        File(dir, "custom_systems/es_systems.xml").takeIf { it.canRead() }?.readText()?.let { text ->
            for (m in Regex("<system>(.*?)</system>", RegexOption.DOT_MATCHES_ALL).findAll(text)) {
                val name = Regex("<name>([^<]*)</name>").find(m.groupValues[1])?.groupValues?.get(1)?.trim() ?: continue
                val folder = Regex("<path>%ROMPATH%/([^<]*)</path>").find(m.groupValues[1])?.groupValues?.get(1)?.trim()?.trimEnd('/') ?: continue
                custom.putIfAbsent(folder, name)
            }
        }
        val bySystem = metas.filter { it.dest.startsWith("$romsDir/") && File(it.dest).isFile }.mapNotNull { m ->
            val rel = m.dest.removePrefix("$romsDir/")
            rel.substringBefore('/', "").takeIf { it.isNotEmpty() }?.let { folder -> Triple(folder, "./" + rel.substringAfter('/'), m) }
        }.groupBy { it.first }
        var added = 0
        for ((folder, items) in bySystem) {
            val file = File(dir, "gamelists/${custom[folder] ?: folder}/gamelist.xml")
            val (text, n) = addEntries(file.takeIf { it.isFile }?.readText(), items.map { it.second to it.third }) ?: continue
            file.parentFile?.mkdirs()
            file.writeText(text)
            added += n
        }
        return added
    }
}
