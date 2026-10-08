package com.rommancer.sync

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File
import java.security.MessageDigest

/** Same protocol as clients/linux/rommancer-sync.sh: list roms and saves, let the server decide, move files. */
class SyncEngine(private val context: Context, private val store: Store, private val onProgress: (Progress) -> Unit = {}) {

    /** Phase, count and the current file's share, for the progress screen */
    data class Progress(val phase: String, val done: Int = 0, val total: Int = 0, val detail: String = "", val fileShare: Float = 0f) {
        val share: Float get() = if (total == 0) 0f else ((if (phase == "roms-download") done - 1 + fileShare else done.toFloat()) / total).coerceIn(0f, 1f)
    }

    data class Conflict(val id: Int, val game: String, val kind: String, val mine: String, val theirs: String, val device: String)

    data class Result(val up: Int, val down: Int, val errors: Int) {
        override fun toString() = "$up up, $down down, $errors errors"
    }

    private val root: File = Environment.getExternalStorageDirectory()
    private val cacheFile = File(context.filesDir, "hashes.tsv")
    private val cache = HashMap<String, Triple<Long, Long, String>>()

    /** What the server needs to register this device. */
    fun deviceHints(): Map<String, String> {
        val hints = mutableMapOf(
            "name" to Build.MODEL.replace('_', ' '),
            "firmware" to "android-esde",
            "root" to root.path,
            "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
        )
        // RetroArch on Android keeps saves next to the content, one folder per core, unless told otherwise
        if (savesNextToRoms()) hints["overrides"] = """{"savesLayout":"rom-core"}"""
        return hints
    }

    private fun savesNextToRoms(): Boolean {
        val roms = File(root, "ROMs").listFiles() ?: return false
        return roms.any { system -> system.listFiles()?.any { it.isDirectory && it.list()?.any { n -> n.endsWith(".srm") || n.contains(".state") } == true } == true }
    }

    // The screen, the background worker and the save watcher may all ask at once: one pass at a time
    fun sync(): Result = synchronized(LOCK) { syncOnce() }

    private fun syncOnce(): Result {
        val server = store.server
        val api = Api(server, store.token ?: error("Not linked"))
        onProgress(Progress("connecting"))
        loadCache()
        val roots = api.text("/agent/roots").lines().mapNotNull { l -> l.split('\t', limit = 2).takeIf { it.size == 2 } }
        val romsDir = roots.firstOrNull { it[0] == "roms" }?.get(1)?.let(::File)
        val saveDirs = roots.filter { it[0] == "saves" }.map { File(it[1]) }
        val exts = roots.firstOrNull { it[0] == "exts" }?.get(1)?.split(' ')?.filter { it.isNotBlank() }.orEmpty()

        val request = StringBuilder()
        val romHashes = HashMap<String, String>()
        val romFiles = romsDir?.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }
            ?.flatMap { system -> system.listFiles()?.filter { it.isFile && !it.name.startsWith(".") && isRom(it.name, exts) }.orEmpty() }.orEmpty()
        romFiles.forEachIndexed { index, rom ->
            if (index % 10 == 0) onProgress(Progress("roms", index, romFiles.size))
            run {
                val hashes = if (rom.length() <= HASH_MAX) listOfNotNull(sha1(rom, 0), headerSize(rom).takeIf { it > 0 }?.let { sha1(rom, it) }) else emptyList()
                romHashes[rom.path] = hashes.joinToString(",")
                request.append("rom\t").append(rom.path).append(hashes.joinToString("") { "\t$it" }).append('\n')
            }
        }
        saveDirs.forEach { dir ->
            dir.walkTopDown().filter { it.isFile && !it.name.startsWith(".") && isSave(it.name, exts) }.forEach { save ->
                request.append("file\t").append(save.path).append('\t').append(sha1(save, 0)).append('\n')
            }
        }
        saveCache()

        onProgress(Progress("server"))
        val plan = api.text("/agent/sync", "POST", request.toString().toByteArray(), mapOf("X-Allow-Pull" to if (store.allowPull) "1" else "0"))
        var up = 0
        var down = 0
        var errors = 0
        val steps = plan.lines().filter { it.isNotBlank() }
        for ((n, line) in steps.withIndex()) {
            onProgress(Progress("transfer", n + 1, steps.size))
            val f = line.split('\t')
            try {
                when (f[0]) {
                    "put" -> {
                        val headers = mapOf(
                            "X-Rom-B64" to Api.b64(f[2]), "X-Path-B64" to Api.b64(f[1]),
                            "X-Rom-Sha1" to (romHashes[f[2]] ?: ""), "X-Save-Exact" to (f.getOrNull(3) ?: "0"),
                        )
                        api.text("/agent/upload", "POST", File(f[1]).readBytes(), headers)
                        up++
                    }
                    "get" -> {
                        api.download("/agent/file?v=${f[2]}", mapOf("X-Rom-B64" to Api.b64(f[3]), "X-Path-B64" to Api.b64(f[1])), File(f[1]))
                        down++
                    }
                }
            } catch (e: Exception) {
                errors++
            }
        }
        return Result(up, down, errors).also {
            store.lastResult = "${java.text.DateFormat.getDateTimeInstance().format(java.util.Date())}: $it"
            store.addLog("sync: $it")
        }
    }

    /** Roms of the lists assigned to this device that are not here yet; never deletes anything */
    fun roms(): String = synchronized(LOCK) { romsOnce() }

    private fun romsOnce(): String {
        val api = Api(store.server, store.token ?: error("Not linked"))
        onProgress(Progress("roms-plan"))
        val plan = api.text("/agent/roms").lines().mapNotNull { l -> l.split('\t').takeIf { it.size >= 4 && it[0] == "rom" } }
        var got = 0
        var have = 0
        var failed = 0
        for ((i, f) in plan.withIndex()) {
            val dest = File(f[1])
            val size = f[2].toLongOrNull() ?: 0L
            if (dest.exists() && (size == 0L || dest.length() == size)) { have++; continue }
            if (size > 0 && (dest.parentFile ?: root).let { generateSequence(it) { p -> p.parentFile }.first { p -> p.exists() } }.usableSpace < size + 50L * 1024 * 1024) {
                failed++
                store.addLog("roms: not enough space for ${dest.name}")
                break
            }
            val part = File(dest.path + ".part")
            val watcher = Thread {
                while (!Thread.currentThread().isInterrupted) {
                    onProgress(Progress("roms-download", i + 1, plan.size, dest.name, if (size > 0) part.length().toFloat() / size else 0f))
                    try { Thread.sleep(500) } catch (_: InterruptedException) { break }
                }
            }.apply { start() }
            try {
                api.download("/agent/rom?f=${f[3]}", emptyMap(), part)
                if (size > 0 && part.length() != size) error("size mismatch")
                part.renameTo(dest)
                got++
            } catch (e: Exception) {
                part.delete()
                failed++
            } finally {
                watcher.interrupt()
            }
        }
        return "roms: $got downloaded, $have already here, $failed failed".also { store.addLog(it) }
    }

    /** Sends the roms the server asked for, one at a time; only when the user allows it */
    fun pulls(): String {
        if (!store.allowPull) return ""
        val api = Api(store.server, store.token ?: error("Not linked"))
        val wanted = api.text("/agent/pulls").lines().mapNotNull { l -> l.split('\t').takeIf { it.size >= 3 && it[0] == "pull" } }
        var sent = 0
        for ((i, p) in wanted.withIndex()) {
            onProgress(Progress("pulls", i + 1, wanted.size, File(p[2]).name))
            val file = File(p[2])
            if (!file.exists()) continue
            runCatching { api.uploadFile("/agent/pull/${p[1]}", file) }.onSuccess { sent++ }
        }
        return if (wanted.isEmpty()) "" else "sent to server: $sent of ${wanted.size}".also { store.addLog(it) }
    }

    /** What the web app asked for since the last time: "sync" and/or "pull" */
    fun poll(): Set<String> = runCatching { Api(store.server, store.token ?: return emptySet()).text("/agent/poll").lines().filter { it.isNotBlank() }.toSet() }.getOrDefault(emptySet())

    fun conflicts(): List<Conflict> = Api(store.server, store.token ?: error("Not linked")).text("/agent/conflicts").lines()
        .mapNotNull { l -> l.split('\t').takeIf { it.size >= 7 && it[0] == "conflict" }?.let { Conflict(it[1].toInt(), it[2], it[3], it[4], it[5], it[6]) } }

    fun resolve(id: Int, keep: String): Result {
        Api(store.server, store.token ?: error("Not linked")).form("/agent/conflicts/$id", mapOf("keep" to keep))
        store.addLog("conflict $id: kept $keep")
        return sync()
    }

    /** "Sync now": saves, the roms the server asked for, then the lists' roms when automatic roms is on */
    fun all(): String {
        val r = sync()
        val sent = runCatching { pulls() }.getOrDefault("")
        val roms = if (store.autoRoms) roms() else ""
        return listOf("sync: $r", sent, roms).filter { it.isNotBlank() }.joinToString(" · ")
    }

    /** Folders the save watcher observes (every subfolder of the save roots) and the save extensions */
    fun watchTargets(): Pair<List<File>, List<String>> {
        val roots = Api(store.server, store.token ?: error("Not linked")).text("/agent/roots").lines().mapNotNull { l -> l.split('\t', limit = 2).takeIf { it.size == 2 } }
        val exts = roots.firstOrNull { it[0] == "exts" }?.get(1)?.split(' ')?.filter { it.isNotBlank() }.orEmpty()
        val dirs = roots.filter { it[0] == "saves" }.map { File(it[1]) }
            .flatMap { d -> d.walkTopDown().onEnter { !it.name.startsWith(".") }.filter { it.isDirectory }.toList() }.distinct()
        return dirs to exts
    }

    fun isSaveFile(name: String, exts: List<String>): Boolean = !name.startsWith(".") && isSave(name, exts)

    private fun isSave(name: String, exts: List<String>): Boolean {
        val n = name.lowercase()
        return exts.any { e -> n.endsWith(e) || Regex(Regex.escape(e) + "(\\d|\\.auto)$").containsMatchIn(n) }
    }

    private fun isRom(name: String, exts: List<String>): Boolean {
        val n = name.lowercase()
        if (NOT_ROMS.any { n.endsWith(it) } || n.contains(".state")) return false
        return !isSave(n, exts)
    }

    private fun headerSize(f: File): Int {
        val n = f.name.lowercase()
        return when {
            n.endsWith(".nes") || n.endsWith(".fds") -> 16
            n.endsWith(".lnx") -> 64
            n.endsWith(".a78") -> 128
            listOf(".smc", ".sfc", ".swc", ".fig").any { n.endsWith(it) } && f.length() % 1024 == 512L -> 512
            else -> 0
        }
    }

    private fun sha1(f: File, skip: Int): String {
        val key = if (skip > 0) "${f.path}#$skip" else f.path
        cache[key]?.let { (size, mtime, hash) -> if (size == f.length() && mtime == f.lastModified()) return hash }
        val md = MessageDigest.getInstance("SHA-1")
        f.inputStream().buffered().use { input ->
            input.skip(skip.toLong())
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        val hash = md.digest().joinToString("") { "%02x".format(it) }
        cache[key] = Triple(f.length(), f.lastModified(), hash)
        return hash
    }

    private fun loadCache() {
        cache.clear()
        if (!cacheFile.exists()) return
        cacheFile.forEachLine { line ->
            val p = line.split('\t')
            if (p.size == 4) cache[p[0]] = Triple(p[1].toLong(), p[2].toLong(), p[3])
        }
    }

    private fun saveCache() {
        cacheFile.writeText(cache.entries.joinToString("") { (k, v) -> "$k\t${v.first}\t${v.second}\t${v.third}\n" })
    }

    companion object {
        const val HASH_MAX = 64L * 1024 * 1024
        private val LOCK = Any()
        private val NOT_ROMS = listOf(".png", ".jpg", ".jpeg", ".mp4", ".xml", ".txt", ".json", ".cfg", ".db", ".ini", ".pdf", ".srm", ".sav", ".mcd", ".mcr", ".dsv", ".cht", ".log", ".sh", ".lpl")
    }
}
