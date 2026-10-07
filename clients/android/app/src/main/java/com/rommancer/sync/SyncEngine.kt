package com.rommancer.sync

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File
import java.security.MessageDigest

/** Same protocol as clients/linux/rommancer-sync.sh: list roms and saves, let the server decide, move files. */
class SyncEngine(private val context: Context, private val store: Store) {

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

    fun sync(): Result {
        val server = store.server
        val api = Api(server, store.token ?: error("Not linked"))
        loadCache()
        val roots = api.text("/agent/roots").lines().mapNotNull { l -> l.split('\t', limit = 2).takeIf { it.size == 2 } }
        val romsDir = roots.firstOrNull { it[0] == "roms" }?.get(1)?.let(::File)
        val saveDirs = roots.filter { it[0] == "saves" }.map { File(it[1]) }
        val exts = roots.firstOrNull { it[0] == "exts" }?.get(1)?.split(' ')?.filter { it.isNotBlank() }.orEmpty()

        val request = StringBuilder()
        val romHashes = HashMap<String, String>()
        romsDir?.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }?.forEach { system ->
            system.listFiles()?.filter { it.isFile && !it.name.startsWith(".") && isRom(it.name, exts) }?.forEach { rom ->
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

        val plan = api.text("/agent/sync", "POST", request.toString().toByteArray())
        var up = 0
        var down = 0
        var errors = 0
        for (line in plan.lines()) {
            val f = line.split('\t')
            try {
                when (f[0]) {
                    "put" -> {
                        val headers = mapOf("X-Rom-B64" to Api.b64(f[2]), "X-Path-B64" to Api.b64(f[1]), "X-Rom-Sha1" to (romHashes[f[2]] ?: ""))
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
        return Result(up, down, errors).also { store.lastResult = "${java.text.DateFormat.getDateTimeInstance().format(java.util.Date())}: $it" }
    }

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
        private val NOT_ROMS = listOf(".png", ".jpg", ".jpeg", ".mp4", ".xml", ".txt", ".json", ".cfg", ".db", ".ini", ".pdf", ".srm", ".sav", ".mcd", ".mcr", ".dsv", ".cht", ".log", ".sh", ".lpl")
    }
}
