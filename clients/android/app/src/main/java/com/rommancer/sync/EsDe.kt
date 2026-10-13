package com.rommancer.sync

import android.content.Context
import java.io.File
import java.util.Locale

/**
 * ES-DE collections: the games whose save is synced, and the roms Rommancer copied in the last two weeks. Only
 * Rommancer's own files in ES-DE/collections are written, and only when their content changes; ES-DE shows them
 * once they are ticked in its collection settings and reads them when it starts.
 */
object EsDe {
    private const val DAYS = 14L

    private fun record(context: Context) = File(context.filesDir, "received-roms")

    /** Notes a rom Rommancer copied, for the "new" collection */
    fun received(context: Context, dest: File) {
        runCatching { record(context).appendText("${System.currentTimeMillis() / 1000}\t${dest.path}\n") }
    }

    fun write(context: Context, api: Api, root: File) {
        val dir = File(root, "ES-DE/collections")
        if (!dir.isDirectory) return
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
        for ((name, paths) in lists) put(File(dir, "custom-$name.cfg"), paths.map { esPath(it, romsDir) })
        // Collections of lists no longer given to this device
        val kept = setOf(savesName, newName) + lists.keys
        dir.listFiles()?.filter { it.name.startsWith("custom-Rommancer - ") && it.name.endsWith(".cfg") && it.name.removePrefix("custom-").removeSuffix(".cfg") !in kept }?.forEach { it.delete() }
    }

    /** ES-DE keeps the games of its collections relative to its ROM folder */
    private fun esPath(path: String, romsDir: String?) =
        if (romsDir != null && path.startsWith("$romsDir/")) "%ROMPATH%/" + path.removePrefix("$romsDir/") else path

    private fun put(file: File, lines: List<String>) {
        val text = lines.joinToString("") { "$it\n" }
        if (!file.exists() || file.readText() != text) file.writeText(text)
    }
}
