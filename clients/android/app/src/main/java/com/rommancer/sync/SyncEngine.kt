package com.rommancer.sync

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File
import java.security.MessageDigest

/** Same protocol as clients/linux/rommancer-sync.sh: list roms and saves, let the server decide, move files. */
class SyncEngine(private val context: Context, private val store: Store, private val onProgress: (Progress) -> Unit = {}) {

    /**
     * Phase, count and the current file's share and size, for the progress screen; STEP of STEPS and STAGE (saves,
     * config, prune, roms, pulls) when it is part of a full sync
     */
    data class Progress(
        val phase: String, val done: Int = 0, val total: Int = 0, val detail: String = "", val fileShare: Float = 0f,
        val fileBytes: Long = 0L, val step: Int = 0, val steps: Int = 0, val stage: String = "",
    ) {
        val share: Float get() = if (total == 0) 0f else ((if (phase == "roms-download" || phase == "pulls") done - 1 + fileShare else done.toFloat()) / total).coerceIn(0f, 1f)
    }

    /**
     * A save in conflict here: MINE / THEIRS as people read them in the server's time zone ZONE, DEVICE where the
     * server's was made, SINCE when both last had the same save (empty: unknown), NEWER "device" or "server"
     */
    data class Conflict(val id: Int, val game: String, val kind: String, val mine: String, val theirs: String, val device: String, val zone: String, val since: String, val newer: String)

    /** A list this device may have; OWNER is empty for the user's own */
    data class DeviceList(val id: Int, val on: Boolean, val items: Int, val name: String, val owner: String)

    /** The lists offered (the device's first) and whether roms in no list are deleted */
    data class Lists(val prune: Boolean, val lists: List<DeviceList>)

    /** What having only some lists would delete here: FILES deleted, UPLOAD sent to the server first, BYTES of both */
    data class ListsDrop(val files: Int, val upload: Int, val bytes: Long)

    private val root: File = Environment.getExternalStorageDirectory()
    private val dolphin = Dolphin(context, store)
    private val psp = PspSaves(root)
    private val cacheFile = File(context.filesDir, "hashes.tsv")
    private val cache = HashMap<String, Triple<Long, Long, String>>()

    /** The step of a full sync under way, stamped on every progress report */
    private var stage: Progress? = null

    private fun report(p: Progress) = onProgress(stage?.let { p.copy(step = it.step, steps = it.steps, stage = it.stage) } ?: p)

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

    /**
     * Where this device keeps its roms: the folder ES-DE was told to use, else a ROMs folder at the top of internal
     * storage or of an SD card (the one with most system folders); null when there is none
     */
    fun romsFolder(): File? {
        val esde = File(root, "ES-DE/settings/es_settings.xml").takeIf { it.canRead() }?.readText()
        Regex("<string name=\"ROMDirectory\" value=\"([^\"]+)\"").find(esde.orEmpty())?.groupValues?.get(1)
            ?.let(::File)?.takeIf { it.isAbsolute && it.isDirectory }?.let { return it }
        val volumes = listOf(root) + context.getExternalFilesDirs(null).filterNotNull().map { File(it.path.substringBefore("/Android/")) }
        return volumes.distinct().flatMap { v -> listOf("ROMs", "Roms", "roms").map { File(v, it) } }
            .filter { it.isDirectory }
            .maxByOrNull { dir -> dir.listFiles()?.count { it.isDirectory && !it.name.startsWith(".") } ?: 0 }
    }

    /**
     * What the app sees when it looks for roms, sent to the server so the web app can tell why a device lists none:
     * file access, storage volumes and their top folders, ES-DE's setting, and what the roms folder holds
     */
    private fun romsReport(romsDir: File?, romFiles: List<File>, version: String?): String {
        val out = StringBuilder()
        fun line(s: String) = out.append(s).append('\n')
        line("app $version, Android ${Build.VERSION.RELEASE}, ${Build.MANUFACTURER} ${Build.MODEL}")
        line("all files access: ${Environment.isExternalStorageManager()}")
        val esde = File(root, "ES-DE/settings/es_settings.xml")
        line("es-de settings: ${esde.path} exists=${esde.exists()} readable=${esde.canRead()}")
        Regex("<string name=\"ROMDirectory\" value=\"([^\"]*)\"").find(runCatching { esde.readText() }.getOrDefault(""))?.let { line("es-de ROMDirectory: ${it.groupValues[1]}") }
        val volumes = listOf(root) + context.getExternalFilesDirs(null).filterNotNull().map { File(it.path.substringBefore("/Android/")) }
        for (v in volumes.distinct()) {
            val top = v.listFiles()?.filter { it.isDirectory }?.map { it.name }?.sorted()
            line("volume ${v.path}: ${top?.size ?: "unreadable"} folders${top?.let { ": " + it.take(60).joinToString(", ") }.orEmpty()}")
        }
        line("roms folder found here: ${romsFolder()?.path}")
        line("roms folder used: ${romsDir?.path} exists=${romsDir?.isDirectory}")
        romsDir?.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }?.sortedBy { it.name }?.take(80)?.forEach { sys ->
            val kids = sys.listFiles().orEmpty()
            val exts = kids.filter { it.isFile }.map { it.extension.lowercase() }.groupingBy { it }.eachCount()
            line("  ${sys.name}: ${kids.count { it.isFile }} files ${exts.entries.take(6).joinToString(" ") { "${it.key}=${it.value}" }}, ${kids.count { it.isDirectory }} folders")
        }
        line("roms listed: ${romFiles.size}")
        return out.toString()
    }

    private fun savesNextToRoms(): Boolean {
        val roms = (romsFolder() ?: File(root, "ROMs")).listFiles() ?: return false
        return roms.any { system -> system.listFiles()?.any { it.isDirectory && it.list()?.any { n -> n.endsWith(".srm") || n.contains(".state") } == true } == true }
    }

    // The screen, the background worker and the save watcher may all ask at once: one pass at a time
    fun sync(): Summary = synchronized(LOCK) { syncOnce() }

    private fun syncOnce(): Summary {
        val server = store.server
        val api = Api(server, store.token ?: error("Not linked"))
        report(Progress("connecting"))
        loadCache()
        // The server keeps where the roms are, as found here, and which version of the app this is
        val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
        val found = listOfNotNull(romsFolder()?.let { "X-Device-Roms-B64" to Api.b64(it.path) }, version?.let { "X-Client-Version" to it }).toMap()
        val roots = api.text("/agent/roots", headers = found).lines().mapNotNull { l -> l.split('\t', limit = 2).takeIf { it.size == 2 } }
        val romsDir = roots.firstOrNull { it[0] == "roms" }?.get(1)?.let(::File)
        val saveDirs = roots.filter { it[0] == "saves" }.map { File(it[1]) }
        val exts = roots.firstOrNull { it[0] == "exts" }?.get(1)?.split(' ')?.filter { it.isNotBlank() }.orEmpty()

        val request = StringBuilder()
        val romHashes = HashMap<String, String>()
        val romFiles = romsDir?.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }
            ?.flatMap { system -> system.listFiles()?.filter { it.isFile && !it.name.startsWith(".") && isRom(it.name, exts) }.orEmpty() }.orEmpty()
        runCatching { api.text("/agent/log", "POST", romsReport(romsDir, romFiles, version).toByteArray(), listOfNotNull(version?.let { "X-Client-Version" to it }).toMap()) }
        romFiles.forEachIndexed { index, rom ->
            if (index % 10 == 0) report(Progress("roms", index, romFiles.size))
            run {
                val hashes = if (rom.length() <= HASH_MAX) listOfNotNull(sha1(rom, 0), headerSize(rom).takeIf { it > 0 }?.let { sha1(rom, it) }) else emptyList()
                romHashes[rom.path] = hashes.joinToString(",")
                // rom, path, sha1, headerless sha1, size
                request.append("rom\t").append(rom.path).append('\t').append(hashes.getOrElse(0) { "" }).append('\t').append(hashes.getOrElse(1) { "" }).append('\t').append(rom.length()).append('\n')
            }
        }
        val listed = HashSet<String>()
        saveDirs.forEach { dir ->
            // PSP save folders go whole, below
            dir.walkTopDown().filter { it.isFile && !it.name.startsWith(".") && isSave(it.name, exts) && !it.path.contains("/PSP/SAVEDATA/", ignoreCase = true) }.forEach { save ->
                // file, path, sha1, mtime (the server tells which emulator folder is in use by the newest one)
                if (listed.add(save.path)) request.append("file\t").append(save.path).append('\t').append(sha1(save, 0)).append('\t').append(save.lastModified() / 1000).append('\n')
            }
        }
        // Roms kept in a folder of their own under their system (ROMs/snes/CURADA/game.smc): sent as "srom" when a save
        // of the same name is here, so those saves sync; the server leaves them out of the inventory (and any deletion)
        val saveNames = listed.mapTo(HashSet()) { File(it).name.replace(Regex("\\.state\\d*(\\.auto)?$", RegexOption.IGNORE_CASE), "").let { n -> if (n == File(it).name) n.substringBeforeLast('.') else n } }
        romsDir?.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") }?.forEach { system ->
            system.walkTopDown().maxDepth(3).onEnter { !it.name.startsWith(".") }
                .filter { it.isFile && it.parentFile != system && isRom(it.name, exts) && it.name.substringBeforeLast('.') in saveNames }
                .forEach { request.append("srom\t").append(it.path).append('\n') }
        }
        // Dolphin's GameCube saves: one .gci per save, in its own folder (shared with us) or an old shared-storage
        // one. Only to servers that know them (they list .gci among the save extensions)
        if (".gci" in exts) {
            runCatching { dolphin.saves() }.getOrDefault(emptyList()).forEach { save ->
                runCatching { sha1Of(save) }.onSuccess { request.append("file\t").append(save.path).append('\t').append(it).append('\n') }
            }
            Dolphin.legacySaves(root).forEach { save ->
                if (listed.add(save.path)) request.append("file\t").append(save.path).append('\t').append(sha1(save, 0)).append('\n')
            }
        }
        // PSP saves: one line per save folder ("<path>/"), and the SAVEDATA folders even when empty
        for (stick in runCatching { psp.sticks(saveDirs) }.getOrDefault(emptyList())) {
            request.append("dir\t").append(stick).append('\n')
            for (folder in psp.folders(stick)) runCatching { folderHash(folder) }.getOrNull()?.let { request.append("file\t").append(folder).append("/\t").append(it).append('\n') }
        }
        // AetherSX2's and NetherSX2's PS2 cards, in their own folder: through Shizuku
        if (Privileged.ready) for (dir in PS2_CARDS) {
            for ((path, size, time) in Privileged.stats(File(root, dir).path).filter { it.first.lowercase().endsWith(".ps2") }) {
                if (!listed.add(path)) continue
                val hash = cache[path]?.takeIf { it.first == size && it.second == time }?.third
                    ?: Privileged.read(path)?.let { sha1Of(it) }?.also { cache[path] = Triple(size, time, it) } ?: continue
                request.append("file\t").append(path).append('\t').append(hash).append('\n')
            }
        }
        saveCache()

        report(Progress("server"))
        // Free and total bytes of the shared storage: the server copies list roms only while a reserve is kept
        val space = runCatching { android.os.StatFs((romsDir ?: root).path).let { "${it.availableBytes} ${it.totalBytes}" } }.getOrDefault("")
        val pruneSent = store.pruneSet
        val plan = api.text(
            "/agent/sync", "POST", request.toString().toByteArray(),
            mapOf(
                "X-Allow-Pull" to if (store.allowPull) "1" else "0", "X-Space" to space, "X-Wifi-Bands" to WifiSetup.bands(context), "X-Probe" to "1",
                "X-Prune" to if (store.pruneRoms) "1" else "0", "X-Prune-Set" to if (pruneSent) "1" else "0",
            ),
        )
        if (pruneSent) store.pruneSet = false
        pruneAnswer(plan.lines().firstOrNull { it.startsWith("prune\t") })
        val sum = Summary()
        // Games whose save or state arrived, for the notification
        val received = linkedSetOf<String>()
        plan.lines().firstOrNull { it.startsWith("backups\t") }?.substringAfter('\t')?.trim()?.toIntOrNull()?.let { store.backupsKeep = it }
        val steps = plan.lines().filter { it.isNotBlank() && !it.startsWith("probe\t") && !it.startsWith("backups\t") && !it.startsWith("prune\t") }
        val probes = plan.lines().filter { it.startsWith("probe\t") }.map { it.split('\t') }.filter { it.size >= 3 }
        // A game running keeps its save in memory and would write it back over one arriving now: those wait
        val playing = Foreground.playing(context)
        HELD = false
        for ((n, line) in steps.withIndex()) {
            report(Progress("transfer", n + 1, steps.size))
            val f = line.split('\t')
            if (playing && f[0] in HOLD) {
                HELD = true
                store.addLog("after the game: ${f.getOrElse(1) { "" }.substringAfterLast('/')}")
                continue
            }
            try {
                when (f[0]) {
                    "put" -> {
                        val headers = mapOf(
                            "X-Rom-B64" to Api.b64(f[2]), "X-Path-B64" to Api.b64(f[1]),
                            "X-Rom-Sha1" to (romHashes[f[2]] ?: ""), "X-Save-Exact" to (f.getOrNull(3) ?: "0"),
                        )
                        val reply = api.text("/agent/upload", "POST", readSave(f[1]), headers)
                        if (Summary.isState(f[1])) sum.statesUp++ else sum.savesUp++
                        for (r in reply.lines().map { it.split('\t') }) when {
                            // A new savestate: the server asks for its screenshot
                            r.size >= 3 && r[0] == "tput" -> runCatching { thumbPut(api, r[1], r[2]) }
                            // A memory card file it read now holds newer saves of other devices
                            r.size >= 3 && r[0] == "cget" -> if (runCatching { cardGet(api, r[1], r[2], r.getOrElse(3) { "-" }) }.getOrDefault(false)) {
                                sum.savesDown++
                                received += File(r[1]).nameWithoutExtension
                            }
                        }
                    }
                    "get" -> {
                        api.download("/agent/file?v=${f[2]}", mapOf("X-Rom-B64" to Api.b64(f[3]), "X-Path-B64" to Api.b64(f[1])), File(f[1])) { tmp ->
                            val old = File(f[1])
                            if (old.isFile && !old.readBytes().contentEquals(tmp.readBytes())) backup(old.name, old.readBytes())
                        }
                        if (Summary.isState(f[1])) sum.statesDown++ else sum.savesDown++
                        received += File(f[3]).nameWithoutExtension
                    }
                    // Savestate screenshots: ours when the server lacks it, the server's beside a state it sent
                    "tput" -> thumbPut(api, f[1], f[2])
                    "tget" -> api.download("/agent/thumb?v=${f[2]}", emptyMap(), File(f[1]))
                    // A newer save is arriving: the game's resume state (its old memory, its old save inside) goes
                    // with the copies, so the next start opens the game with the save that arrived
                    "aside" -> File(f[1]).takeIf { it.isFile }?.let { state ->
                        backup(state.name, state.readBytes())
                        state.delete()
                        store.addLog("resume state put aside: ${state.name}")
                    }
                    "cget" -> if (cardGet(api, f[1], f[2], f.getOrElse(3) { "-" })) {
                        sum.savesDown++
                        received += File(f[1]).nameWithoutExtension
                    }
                }
            } catch (e: Exception) {
                sum.error("${f[0]} ${f.getOrElse(1) { "" }.substringAfterLast('/')}", e)
            }
        }
        // Roms no hash or name identified: the server reads their product code from the blocks it asks for
        for ((n, f) in probes.withIndex()) {
            report(Progress("identify", n + 1, probes.size))
            runCatching { probe(api, File(f[1]), f[2]) }
        }
        Notices.received(context, received.toList())
        runCatching { EsDe.write(context, api, root) }
        store.lastSyncAt = System.currentTimeMillis()
        store.addLog("sync: ${sum.savesUp + sum.statesUp} up, ${sum.savesDown + sum.statesDown} down, ${sum.errors} errors")
        return sum.also { keep(it) }
    }

    /** The summary of the last pass, for the Status screen */
    private fun keep(sum: Summary) {
        store.lastSummary = sum.encode()
        store.lastSummaryAt = System.currentTimeMillis()
    }

    /** One header probe: the 4 KiB blocks the server names ("start:count,..."), sent until it has what it needs */
    private fun probe(api: Api, file: File, first: String) {
        if (!file.isFile) return
        var ask = first
        java.io.RandomAccessFile(file, "r").use { raf ->
            var rounds = 0
            while (ask.isNotEmpty() && rounds++ < 12) {
                val body = java.io.ByteArrayOutputStream()
                for (r in ask.split(',')) {
                    val (start, count) = r.split(':').map { it.toLong() }
                    val len = (minOf(raf.length(), (start + count) * 4096) - start * 4096).coerceAtLeast(0).toInt()
                    val buf = ByteArray(len)
                    raf.seek(start * 4096)
                    raf.readFully(buf)
                    body.write(buf)
                }
                val reply = api.text("/agent/probe", "POST", body.toByteArray(), mapOf("X-Path-B64" to Api.b64(file.path), "X-Size" to raf.length().toString(), "X-Ranges" to ask))
                ask = reply.lines().firstOrNull { it.startsWith("need\t") }?.substringAfter('\t')?.trim() ?: ""
            }
        }
    }

    /**
     * What a sync is about to overwrite, kept first in Rommancer/backups on the shared storage (never beside the
     * saves, where an emulator could load it): the last copies the server's setting says, at most 256 MB of them
     */
    private fun backup(name: String, data: ByteArray) {
        val dir = File(root, "Rommancer/backups").apply { mkdirs() }
        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT).format(java.util.Date())
        File(dir, "$stamp-$name").writeBytes(data)
        var used = 0L
        dir.listFiles()?.sortedByDescending { it.lastModified() }?.forEachIndexed { i, f ->
            used += f.length()
            if (i >= store.backupsKeep || used > 256L * 1024 * 1024) f.delete()
        }
    }

    private fun readSave(path: String): ByteArray = when {
        Dolphin.isVirtual(path) -> dolphin.read(path)
        path.endsWith("/") -> psp.pack(path)
        path.contains("/Android/data/") -> Privileged.read(path) ?: throw java.io.FileNotFoundException(path)
        else -> File(path).readBytes()
    }

    /** A PSP save folder's manifest hash, kept while its files' sizes and times do not change; null when it is empty */
    private fun folderHash(folder: String): String? {
        val entries = psp.entries(folder)
        val sig = psp.signature(entries) ?: return null
        val key = "${folder.trimEnd('/')}/"
        cache[key]?.let { (size, time, hash) -> if (size == sig.first && time == sig.second) return hash }
        return psp.hash(entries)?.also { cache[key] = Triple(sig.first, sig.second, it) }
    }

    /**
     * Whether a whole memory card may be written: only when Shizuku can tell that no emulator that may hold it is
     * running (the app owning its folder in Android/data, RetroArch for the shared storage)
     */
    private fun cardFree(path: String): Boolean {
        if (!Privileged.ready) return false
        val owner = Regex("/Android/data/([^/]+)/").find(path)?.groupValues?.get(1)
        return (listOfNotNull(owner) + RETROARCH).none { Privileged.running(it) }
    }

    /** A PSP save folder the server sent, written only if the folder is still the one it read (EXPECT) */
    private fun folderGet(api: Api, path: String, expect: String, rom: String): Boolean {
        val data = api.bytes("/agent/card?expect=$expect", mapOf("X-Path-B64" to Api.b64(path), "X-Rom-B64" to Api.b64(rom)))
        if (data == null || data.isEmpty()) return false
        cache.remove(path)
        val now = folderHash(path) ?: "-"
        if (now != expect) return false
        if (now != "-") runCatching { backup(File(path.trimEnd('/')).name + ".tar", psp.pack(path)) }
        psp.write(path, data)
        cache.remove(path)
        runCatching { api.text("/agent/card/ack?sha=${folderHash(path)}", "POST", ByteArray(0), mapOf("X-Path-B64" to Api.b64(path))) }
        return true
    }

    /**
     * A memory card file with the server's newer saves ("cget"), written only if it is still the one the server
     * read (EXPECT, "-" for none). Dolphin's .gci files (one save each: Dolphin only writes back the saves a game
     * changed) and PSP save folders always; whole cards (PS1, PS2, Dolphin's .raw images) only when no emulator that
     * may hold one is running (cardFree).
     */
    private fun cardGet(api: Api, path: String, expect: String, rom: String): Boolean {
        if (path.endsWith("/")) return folderGet(api, path, expect, rom)
        if (!path.lowercase().endsWith(".gci") && !cardFree(path)) return false
        val data = api.bytes("/agent/card?expect=$expect", mapOf("X-Path-B64" to Api.b64(path), "X-Rom-B64" to Api.b64(rom)))
        if (data == null || data.isEmpty()) return false
        val now = try {
            sha1Of(readSave(path))
        } catch (_: java.io.FileNotFoundException) {
            "-"
        }
        if (now != expect) return false
        if (now != "-") runCatching { backup(path.substringAfterLast('/'), readSave(path)) }
        if (Dolphin.isVirtual(path)) dolphin.write(path, data)
        else if (path.contains("/Android/data/")) { if (!Privileged.write(path, data)) return false }
        else {
            val file = File(path)
            file.parentFile?.mkdirs()
            val tmp = File("$path.rommancer-tmp")
            tmp.writeBytes(data)
            if (!tmp.renameTo(file)) { tmp.copyTo(file, overwrite = true); tmp.delete() }
        }
        // Told at once: a game saved on it before the next sync is then this device's newer save
        runCatching { api.text("/agent/card/ack?sha=${sha1Of(data)}", "POST", ByteArray(0), mapOf("X-Path-B64" to Api.b64(path))) }
        return true
    }

    private fun sha1Of(data: ByteArray): String = MessageDigest.getInstance("SHA-1").digest(data).joinToString("") { "%02x".format(it) }

    /** A Dolphin save's hash, from the cache while its size and time are unchanged */
    private fun sha1Of(save: Dolphin.Save): String {
        cache[save.path]?.let { (size, mtime, hash) -> if (size == save.size && mtime == save.modified) return hash }
        return sha1Of(dolphin.read(save.path)).also { cache[save.path] = Triple(save.size, save.modified, it) }
    }

    private fun thumbPut(api: Api, path: String, version: String) {
        val file = File(path)
        if (file.isFile && file.length() <= THUMB_MAX) api.text("/agent/thumb?v=$version", "POST", file.readBytes())
    }

    // ---------- roms that are in none of this device's lists ----------

    /** The web app changed the setting ("prune<TAB>value<TAB>files<TAB>bytes"): off applies at once, on waits for the user */
    private fun pruneAnswer(line: String?) {
        val f = line?.split('\t') ?: run { store.pruneAsk = null; return }
        if (f.getOrNull(1) == "1") store.pruneAsk = "${f.getOrElse(2) { "0" }}\t${f.getOrElse(3) { "0" }}"
        else { store.pruneAsk = null; store.pruneRoms = false; store.pruneHold = null; store.pruneSet = true }
    }

    /** A change made here, or the answer to one made in the web app; the server hears it at once */
    fun pruneSet(on: Boolean): Summary {
        store.pruneRoms = on
        store.pruneSet = true
        store.pruneAsk = null
        store.pruneIntro = true
        if (!on) store.pruneHold = null
        return sync()
    }

    /**
     * Deletes the roms the server names as in no list (only with the setting on, only inside the roms folder). A
     * deletion of more than half of the roms waits in pruneHold for the user (pruneConfirm).
     */
    fun prune(): Summary = synchronized(LOCK) {
        val sum = Summary()
        if (!store.pruneRoms || store.pruneAsk != null) return sum
        report(Progress("prune"))
        val api = Api(store.server, store.token ?: error("Not linked"))
        val roms = api.text("/agent/roots").lines().mapNotNull { l -> l.split('\t', limit = 2).takeIf { it.size == 2 && it[0] == "roms" } }.firstOrNull()?.get(1)?.trimEnd('/') ?: return sum
        val plan = api.text("/agent/prune").lines().map { it.split('\t') }
        plan.firstOrNull { it[0] == "hold" && it.size >= 3 }?.let { h ->
            store.pruneHold = "${h[1]}\t${h[2]}"
            store.addLog("prune: ${h[1]} roms waiting for confirmation")
            return sum
        }
        store.pruneHold = null
        val gone = mutableListOf<String>()
        for (f in plan) {
            if (f[0] != "del" || f.size < 2 || !f[1].startsWith("$roms/") || f[1].removePrefix("$roms/").count { it == '/' } < 1) continue
            val file = File(f[1])
            if (file.isFile && file.delete()) gone += file.path
        }
        if (gone.isEmpty()) return sum
        store.pruned = store.pruned + gone
        store.addLog("prune: ${gone.size} roms in no list deleted")
        sum.gamesDeleted = gone.size
        return sum
    }

    /** The user confirmed a held deletion */
    fun pruneConfirm(): Summary {
        val hold = store.pruneHold ?: return Summary()
        Api(store.server, store.token ?: error("Not linked")).text("/agent/prune/confirm", "POST", ByteArray(0), mapOf("X-Count" to hold.substringBefore('\t')))
        store.pruneHold = null
        return prune()
    }

    /** Saves and states of the deleted roms: removed once a sync went through without errors (they are on the server) */
    fun pruneClean(): Summary {
        val gone = store.pruned
        if (gone.isEmpty()) return Summary()
        val sum = sync()
        if (sum.errors > 0) return sum
        val api = Api(store.server, store.token ?: error("Not linked"))
        val files = api.text("/agent/prune/saves", "POST", gone.joinToString("\n").toByteArray()).lines().mapNotNull { l -> l.split('\t').takeIf { it.size >= 2 && it[0] == "file" }?.get(1) }
        val n = files.count { File(it).let { f -> f.isFile && f.delete() } }
        store.pruned = emptyList()
        store.addLog("prune: $n save files of deleted roms removed")
        sum.savesCleaned = n
        return sum.also { keep(it) }
    }

    /** Roms of the lists assigned to this device that are not here yet; never deletes anything */
    fun roms(): Summary {
        STOP_ROMS.set(false)
        return synchronized(LOCK) { romsOnce() }.also { keep(it) }
    }

    private fun romsOnce(): Summary = try { romsPass() } finally { LIVE = null }

    // Every screen sees a rom download, whoever started it (the background worker or the save watcher)
    private fun romsProgress(p: Progress) {
        LIVE = p
        report(p)
    }

    private fun romsPass(): Summary {
        val sum = Summary()
        val api = Api(store.server, store.token ?: error("Not linked"))
        romsProgress(Progress("roms-plan"))
        val plan = api.text("/agent/roms").lines().mapNotNull { l -> l.split('\t').takeIf { it.size >= 4 && it[0] == "rom" } }
        var got = 0
        var have = 0
        var failed = 0
        for ((i, f) in plan.withIndex()) {
            if (STOP_ROMS.get()) {
                store.addLog("roms: stopped, $got downloaded")
                return sum.apply { gamesDown = got; stopped = true }
            }
            val dest = File(f[1])
            val size = f[2].toLongOrNull() ?: 0L
            if (dest.exists() && (size == 0L || dest.length() == size)) { have++; continue }
            if (size > 0 && (dest.parentFile ?: root).let { generateSequence(it) { p -> p.parentFile }.first { p -> p.exists() } }.usableSpace < size + 50L * 1024 * 1024) {
                failed++
                store.addLog("roms: not enough space for ${dest.name}")
                sum.noSpace = dest.nameWithoutExtension
                break
            }
            val part = File(dest.path + ".part")
            val watcher = Thread {
                while (!Thread.currentThread().isInterrupted) {
                    romsProgress(Progress("roms-download", i + 1, plan.size, dest.name, if (size > 0) part.length().toFloat() / size else 0f, size))
                    try { Thread.sleep(500) } catch (_: InterruptedException) { break }
                }
            }.apply { start() }
            try {
                api.download("/agent/rom?f=${f[3]}", emptyMap(), part, cancelled = { STOP_ROMS.get() })
                if (size > 0 && part.length() != size) error("size mismatch")
                part.renameTo(dest)
                got++
                EsDe.received(context, dest)
            } catch (e: Exception) {
                part.delete()
                failed++
                // A stop cuts the transfer: that is no error
                if (!STOP_ROMS.get()) sum.error("download ${dest.name}", e)
            } finally {
                watcher.interrupt()
            }
        }
        if (got > 0) runCatching { EsDe.write(context, api, root) }
        store.addLog("roms: $got downloaded, $have already here, $failed failed")
        if (STOP_ROMS.get()) sum.stopped = true
        return sum.apply { gamesDown = got }
    }

    /** Sends the roms the server asked for, one at a time; only when the user allows it */
    fun pulls(): Summary {
        if (!store.allowPull) return Summary()
        // One copy at a time; a transfer cut halfway stays open on the server and is sent again next time
        if (!PULLING.compareAndSet(false, true)) return Summary()
        try { return pullsOnce() } finally { PULLING.set(false); PULL_LIVE = null }
    }

    private fun pullsOnce(): Summary {
        val sum = Summary()
        val api = Api(store.server, store.token ?: error("Not linked"))
        val wanted = api.text("/agent/pulls").lines().mapNotNull { l -> l.split('\t').takeIf { it.size >= 3 && it[0] == "pull" } }
        var sent = 0
        for ((i, p) in wanted.withIndex()) {
            val file = File(p[2])
            val step = Progress("pulls", i + 1, wanted.size, file.name, fileBytes = file.length())
            PULL_LIVE = step
            report(step)
            // Gone from the device: the server closes the request instead of asking again
            if (!file.exists()) { runCatching { api.text("/agent/pull/${p[1]}", "POST", ByteArray(0), mapOf("X-Missing" to "1")) }; continue }
            val size = file.length().coerceAtLeast(1)
            runCatching {
                api.uploadFile("/agent/pull/${p[1]}", file) { n -> PULL_LIVE = step.copy(fileShare = n.toFloat() / size) }
            }.onSuccess { sent++ }.onFailure { sum.error("send ${file.name}", it) }
        }
        if (wanted.isNotEmpty()) store.addLog("sent to server: $sent of ${wanted.size}")
        return sum.apply { gamesSent = sent }
    }

    /** What the web app asked for since the last time: "sync" and/or "pull" */
    fun poll(): Set<String> = pollOrNull() ?: emptySet()

    /** The same, null when the server could not be reached */
    fun pollOrNull(): Set<String>? = runCatching { Api(store.server, store.token ?: return emptySet()).text("/agent/poll").lines().filter { it.isNotBlank() }.toSet() }.getOrNull()

    fun conflicts(): List<Conflict> = Api(store.server, store.token ?: error("Not linked")).text("/agent/conflicts").lines()
        .mapNotNull { l -> l.split('\t').takeIf { it.size >= 7 && it[0] == "conflict" }?.let { conflictOf(it) } }

    /** Older servers send only the ISO dates: shown as they come, the newer told by them */
    private fun conflictOf(f: List<String>): Conflict {
        val g = { i: Int -> f.getOrNull(i)?.takeIf { it != "-" }.orEmpty() }
        val newer = g(12).ifEmpty { if (f[4] >= f[5]) "device" else "server" }
        return Conflict(f[1].toInt(), f[2], f[3], g(8).ifEmpty { f[4].take(16).replace('T', ' ') }, g(9).ifEmpty { f[5].take(16).replace('T', ' ') }, f[6], g(10), g(11), newer)
    }

    fun lists(): Lists {
        val rows = Api(store.server, store.token ?: error("Not linked")).text("/agent/lists").lines().map { it.split('\t') }
        return Lists(
            prune = rows.any { it.size >= 2 && it[0] == "prune" && it[1] == "1" },
            lists = rows.filter { it.size >= 5 && it[0] == "list" }.map { DeviceList(it[1].toInt(), it[2] == "1", it[3].toIntOrNull() ?: 0, it[4], it.getOrElse(5) { "" }) },
        )
    }

    fun listsPreview(ids: List<Int>): ListsDrop {
        val rows = Api(store.server, store.token ?: error("Not linked")).text("/agent/lists/preview", "POST", ids.joinToString("\n").toByteArray(), mapOf("Content-Type" to "text/plain"))
            .lines().map { it.split('\t') }.filter { it.size >= 3 }.associate { it[0] to (it[1].toIntOrNull() to it[2].toLongOrNull()) }
        val del = rows["delete"]; val up = rows["upload"]
        return ListsDrop(del?.first ?: 0, up?.first ?: 0, (del?.second ?: 0L) + (up?.second ?: 0L))
    }

    /** Gives the device exactly these lists */
    fun listsSet(ids: List<Int>) {
        Api(store.server, store.token ?: error("Not linked")).text("/agent/lists", "POST", ids.joinToString("\n").toByteArray(), mapOf("Content-Type" to "text/plain"))
        store.addLog("lists: ${ids.size} on this device")
    }

    fun resolve(id: Int, keep: String): Summary {
        Api(store.server, store.token ?: error("Not linked")).form("/agent/conflicts/$id", mapOf("keep" to keep))
        store.addLog("conflict $id: kept $keep")
        return sync().also { s -> s.conflicts = runCatching { conflicts().size }.getOrDefault(0); keep(s) }
    }

    /**
     * "Sync now", in numbered steps: saves, emulator settings, roms in no list (when that is on), the lists' roms
     * (ROMS: only when asked for on screen; background passes never download roms), then the roms the server asked
     * for (last, so the ones a deletion has to send first go in the same pass)
     */
    fun all(roms: Boolean = false): Summary {
        val pullsLikely = store.allowPull && (store.pruneRoms || runCatching {
            Api(store.server, store.token ?: error("Not linked")).text("/agent/pulls").lines().any { it.startsWith("pull\t") }
        }.getOrDefault(false))
        val stages = listOfNotNull("saves", "config", "prune".takeIf { store.pruneRoms }, "roms".takeIf { roms }, "pulls".takeIf { pullsLikely })
        fun enter(name: String) {
            stage = Progress(name, step = stages.indexOf(name) + 1, steps = stages.size, stage = name)
            report(Progress("connecting"))
        }
        val sum = Summary()
        try {
            enter("saves")
            sum += sync()
            enter("config")
            report(Progress("config"))
            runCatching { ConfigEngine(context, store).run() }.onFailure { sum.error("settings", it) }
            if ("prune" in stages) {
                enter("prune")
                runCatching { prune() }.onSuccess { sum += it }.onFailure { sum.error("delete games in no list", it) }
            }
            if (roms) {
                enter("roms")
                sum += roms()
            }
            if (store.allowPull) {
                if ("pulls" in stages) enter("pulls") else stage = null
                runCatching { pulls() }.onSuccess { sum += it }.onFailure { sum.error("send games", it) }
            }
        } finally {
            stage = null
        }
        sum.conflicts = runCatching { conflicts().size }.getOrDefault(0)
        return sum.also { keep(it) }
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
        const val THUMB_MAX = 4L * 1024 * 1024
        private val LOCK = Any()
        private val PULLING = java.util.concurrent.atomic.AtomicBoolean(false)
        private val STOP_ROMS = java.util.concurrent.atomic.AtomicBoolean(false)

        private val HOLD = setOf("get", "aside", "cget")

        /** The memory cards of AetherSX2 (NetherSX2 is the same app) and ARMSX2 */
        private val PS2_CARDS = listOf("Android/data/xyz.aethersx2.android/files/memcards", "Android/data/com.armsx2/files/memcards")

        private val RETROARCH = listOf("com.retroarch", "com.retroarch.aarch64", "com.retroarch.ra32")

        /** The last pass left saves to fetch until the game in front closes */
        @Volatile var HELD = false
            private set

        /** The rom download under way, whoever started it; null when there is none */
        @Volatile var LIVE: Progress? = null
            private set

        /** The copy the server asked for, whoever started it; null when there is none */
        @Volatile var PULL_LIVE: Progress? = null
            private set

        /** Stops the rom download under way (the transfer is cut); background passes skip roms until asked on screen */
        fun stopRoms(store: Store) {
            store.romsStopped = true
            STOP_ROMS.set(true)
        }
        private val NOT_ROMS = listOf(".png", ".jpg", ".jpeg", ".mp4", ".xml", ".txt", ".json", ".cfg", ".db", ".ini", ".pdf", ".srm", ".sav", ".mcd", ".mcr", ".dsv", ".cht", ".log", ".sh", ".lpl")
    }
}
