package com.rommancer.sync

import android.content.Context
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

class Journeys(private val context: Context, private val store: Store) {
    data class Game(val rom: String, val title: String, val identity: String? = null, val system: String = "unknown")
    data class Item(val id: String, val name: String, val revision: Int, val cached: Boolean, val current: Boolean, val conflict: Boolean, val incompatible: Int, val slot: Int = 0, val files: Int = 0, val updatedAt: Long = 0, val pendingSync: Boolean = false)
    private val api = Api(store.server, store.token ?: error("Not linked"))
    private val root = File(context.filesDir, "journeys/" + digest((store.server + "\n" + store.token).toByteArray())).apply { mkdirs() }
    private val blobs = File(root, "blobs").apply { mkdirs() }
    private var summary = Summary()
    private fun uuid() = UUID.randomUUID().toString()
    private fun call(route: String, body: String? = null, headers: Map<String, String> = emptyMap()) =
        api.text("/agent/journeys/$route", if (body == null) "GET" else "POST", body?.toByteArray(), headers + ("Content-Type" to "text/plain"))
    private fun state(dir: File) = JSONObject(File(dir, "state").readText())
    private fun save(dir: File, state: JSONObject) = atomic(File(dir, "state"), state.toString())
    private fun dir(identity: String): File {
        require(identity.matches(Regex("[a-f0-9]{40}")))
        return File(root, identity)
    }

    fun games(): List<Game> = SyncEngine.journeyLocked {
        val file = File(root, "games")
        runCatching { atomic(file, call("games")) }
        val known = file.takeIf { it.exists() }?.readLines().orEmpty().mapNotNull { line ->
            val f = line.split('\t')
            if (f.size >= 4 && f[0] == "game") Game(decode(f[1]), decode(f[2]), system = f[3]) else null
        }
        val enrolled = roots().map { val s = state(it); Game(s.getString("rom"), File(s.getString("rom")).name, it.name, s.getJSONObject("layout").optString("platform", "unknown")) }
        enrolled + known.filter { g -> enrolled.none { it.rom == g.rom } }
    }

    fun enroll(game: Game): String = SyncEngine.journeyLocked {
        val rom = File(game.rom)
        check(rom.isFile && rom.canRead()) { "ROM is unavailable" }
        val pending = File(root, "enrollment-${digest(game.rom.toByteArray())}")
        val operation = if (pending.exists()) pending.readText() else uuid().also { atomic(pending, it) }
        val response = call("register", "${Api.b64(game.rom)}\t${digest(rom)}\t$operation\n", mapOf("X-Core-Versions-B64" to Api.b64(JSONObject(CoreVersions.read()).toString())))
        val rows = response.lines().map { it.split('\t') }
        val binding = rows.first { it[0] == "binding" }
        val d = dir(binding[2]).apply { mkdirs() }
        if (!File(d, "state").exists()) {
            val layout = JSONObject()
            rows.filter { it.size == 3 && it[0] == "layout" }.forEach { layout.put(it[1], decode(it[2])) }
            save(d, JSONObject().put("binding", binding[1]).put("identity", binding[2]).put("active", binding[3])
                .put("generation", binding[4].toInt()).put("rom", game.rom).put("layout", layout).put("items", JSONObject()))
        }
        val s = state(d)
        val j = item(s, s.getString("active"))
        if (!j.has("manifest")) j.put("manifest", "").put("name", "Main").put("base", 0).put("slot", 1)
        capture(d, s)
        save(d, s)
        pending.delete()
        runCatching { synchronize(d, s) }.onFailure { store.addLog("Journeys: ${it.message}") }
        binding[2]
    }

    fun items(identity: String, refresh: Boolean = true): List<Item> = SyncEngine.journeyLocked {
        val d = dir(identity); recover(d)
        val s = state(d)
        if (refresh) runCatching { refresh(d, s, false) }.onFailure { store.addLog("Journeys offline: ${it.message}") }
        val items = s.getJSONObject("items")
        val ordered = items.keys().asSequence().toList()
        var nextSlot = ordered.maxOfOrNull { items.getJSONObject(it).optInt("slot") } ?: 0
        if (nextSlot == 0 && items.has(s.getString("active"))) items.getJSONObject(s.getString("active")).put("slot", ++nextSlot)
        ordered.filter { !items.getJSONObject(it).has("slot") }.sorted().forEach { items.getJSONObject(it).put("slot", ++nextSlot) }
        save(d, s)
        ordered.map { id ->
            val j = items.getJSONObject(id)
            val remoteTime = runCatching { java.time.Instant.parse(j.optString("syncedAt")).toEpochMilli() }.getOrDefault(0L)
            val updated = if (j.optBoolean("dirty")) j.optLong("localUpdatedAt", remoteTime) else remoteTime
            Item(id, j.optString("name", "Journey"), j.optInt("head"), complete(j), id == s.getString("active"), j.has("conflict"), entries(j.optString("manifest")).count { path(s.getJSONObject("layout"), it.first) == null }, j.getInt("slot"), entries(j.optString("manifest")).count { !it.first.contains("/thumb/") }, updated, j.optBoolean("dirty") || j.optBoolean("create") || (id == s.getString("active") && s.has("selection")))
        }.sortedBy { it.slot }
    }

    fun switch(identity: String, target: String, closed: Boolean): String = SyncEngine.journeyLocked {
        val d = dir(identity); recover(d)
        val s = state(d)
        try { refresh(d, s, false) }
        catch (e: ApiException) { if (e.status in 400..499) throw e }
        catch (_: java.io.IOException) { }
        val j = item(s, target)
        if (s.getString("active") == target) return@journeyLocked "Current slot: ${j.optString("name", "Saved game")}"
        check(complete(j)) { "Download required. Connect before using this slot." }
        if (!closed || Foreground.journeyState(context) == Foreground.JourneyState.RUNNING) {
            s.put("pending", target); save(d, s)
            return@journeyLocked "Slot change queued. Close the emulator, then select Apply pending changes."
        }
        capture(d, s)
        val command = if (s.optString("pending") == target) s.optString("command") else ""
        materialize(d, s, target, j.getString("manifest"), true, command = command)
        atomic(File(root, "notice"), "${File(s.getString("rom")).name}: current journey is ${j.optString("name", "Journey")}. If the emulator was already open, close and reopen it. New saves affect this journey.")
        s.remove("pending"); s.remove("command"); save(d, s)
        runCatching {
            synchronize(d, s)
            if (command.isNotBlank()) call("commands/$command", "applied\n")
        }.onFailure { store.addLog("Journey saved locally: ${it.message}") }
        "Current slot: ${j.optString("name", "Saved game")} · Progress kept on this console"
    }

    fun rename(identity: String, id: String, name: String): String = SyncEngine.journeyLocked {
        check(name.trim().isNotEmpty() && name.length <= 80) { "Enter a journey name" }
        val d = dir(identity); val s = state(d)
        item(s, id).put("name", name.trim()).put("rename", true); save(d, s)
        runCatching { synchronize(d, s) }.onFailure { store.addLog("Journey name saved locally: ${it.message}") }
        "Slot renamed: ${name.trim()}"
    }

    fun create(identity: String, name: String, duplicate: Boolean, closed: Boolean): String = SyncEngine.journeyLocked {
        check(closed) { "Close the game before creating and switching journeys" }
        val d = dir(identity); recover(d); val s = state(d)
        capture(d, s)
        val source = item(s, s.getString("active"))
        check(!source.has("conflict")) { "Resolve the current journey conflict first" }
        if (duplicate) check(complete(source) && !source.has("incoming") && source.optInt("head", source.optInt("base")) <= source.optInt("base")) {
            "The complete source checkpoint is not ready. Close the game and apply the latest progress, or resolve its conflict before duplicating."
        }
        val id = uuid()
        item(s, id).put("name", name.trim().ifEmpty { if (duplicate) "${source.optString("name", "Saved game")} copy".take(80) else "New game" })
            .put("manifest", if (duplicate) source.getString("manifest") else "").put("base", 0).put("dirty", true).put("create", true).put("localUpdatedAt", System.currentTimeMillis())
        save(d, s)
        switch(identity, id, closed)
    }

    fun sync(): Summary = SyncEngine.journeyLocked {
        summary = Summary()
        roots().forEach { d ->
            try {
                recover(d); val s = state(d); capture(d, s); save(d, s); synchronize(d, s)
                if (Foreground.journeyState(context) == Foreground.JourneyState.STOPPED) {
                    if (s.has("pending")) switch(d.name, s.getString("pending"), true) else refresh(d, s, true)
                }
            }
            catch (e: Exception) { summary.error("Journeys", e); store.addLog("Journey needs attention: ${e.message}") }
        }
        summary
    }

    fun status(): String? = SyncEngine.journeyLocked {
        for (d in roots()) {
            val s = state(d)
            if (File(d, "journal").exists()) return@journeyLocked "Needs attention · Journey recovery pending"
            if (s.has("pending")) return@journeyLocked "Journey change pending · Close the game and confirm"
            val items = s.getJSONObject("items")
            if (items.keys().asSequence().any { items.getJSONObject(it).has("conflict") }) return@journeyLocked "Needs attention · Conflicting journey progress"
        }
        null
    }

    fun takeNotice(): String? = SyncEngine.journeyLocked {
        val file = File(root, "notice")
        if (!file.exists()) null else file.readText().also { file.delete() }
    }

    fun applyPending(identity: String): String = SyncEngine.journeyLocked {
        val d = dir(identity); val s = state(d)
        val pending = s.optString("pending")
        if (pending.isNotBlank()) switch(identity, pending, true)
        else { capture(d, s); synchronize(d, s); refresh(d, s, true); "Journey is ready to play" }
    }

    fun keepBoth(identity: String, closed: Boolean): String = SyncEngine.journeyLocked {
        check(closed && Foreground.journeyState(context) != Foreground.JourneyState.RUNNING) { "Close the emulator first" }
        val d = dir(identity); recover(d); val s = state(d)
        val source = item(s, s.getString("active"))
        check(source.has("conflict")) { "This journey has no local conflict" }
        source.remove("conflict")
        capture(d, s)
        val id = uuid()
        item(s, id).put("name", (source.optString("name", "Journey") + " — This console").take(80))
            .put("manifest", source.getString("manifest")).put("base", 0).put("dirty", true).put("create", true).put("localUpdatedAt", System.currentTimeMillis())
        source.put("dirty", false); source.remove("outbox"); source.remove("operation")
        save(d, s)
        switch(identity, id, closed)
    }

    private fun roots() = root.listFiles()?.filter { it.isDirectory && File(it, "state").exists() }.orEmpty()
    private fun item(s: JSONObject, id: String): JSONObject {
        require(id.matches(Regex("[a-f0-9-]{36}")))
        val items = s.getJSONObject("items")
        if (!items.has(id)) items.put(id, JSONObject())
        return items.getJSONObject(id)
    }
    private fun entries(text: String) = text.lineSequence().filter { it.isNotBlank() }.map { line ->
        val f = line.split('\t')
        check(f.size == 3 && f[0].matches(Regex("[a-z0-9-]+/(save|state|thumb)/(-1|[0-9]+)")) && f[1].matches(Regex("[a-f0-9]{40}"))) { "Invalid journey manifest" }
        Triple(f[0], f[1], f[2].toLong())
    }.toList()
    private fun complete(j: JSONObject) = j.has("manifest") && entries(j.getString("manifest")).all { File(blobs, it.second).isFile }
    private fun path(layout: JSONObject, key: String): File? {
        val f = key.split('/')
        val adapter = if (f[1] == "save") layout.optString("saveAdapter", layout.getString("emulator")) else layout.optString("stateAdapter", layout.getString("emulator"))
        if (f[0] != adapter) return null
        return when (f[1]) {
            "save" -> File(layout.getString("savePath"))
            "state", "thumb" -> File(layout.getString("statePath") + when (f[2]) { "0" -> ""; "-1" -> ".auto"; else -> f[2] } + if (f[1] == "thumb") ".png" else "")
            else -> null
        }
    }
    private fun room(destination: File, bytes: Long, recovering: Boolean = false) {
        var volume = destination
        while (!volume.isDirectory) volume = volume.parentFile ?: error("Storage unavailable")
        val reserve = if (recovering) 0 else (volume.totalSpace / 20).coerceIn(128L * 1024 * 1024, 1024L * 1024 * 1024)
        check(volume.usableSpace - reserve >= bytes) { "Not enough space for journeys; current progress is kept" }
    }
    private fun scan(s: JSONObject): String {
        val l = s.getJSONObject("layout")
        val emulator = l.getString("emulator")
        val saveAdapter = l.optString("saveAdapter", emulator)
        val stateAdapter = l.optString("stateAdapter", emulator)
        val save = File(l.getString("savePath")); val state = File(l.getString("statePath"))
        check(save.parentFile?.canRead() == true && state.parentFile?.canRead() == true) { "Save folders are unavailable; check storage access" }
        val files = mutableListOf<Pair<String, File>>()
        if (save.isFile) files += "$saveAdapter/save/0" to save
        state.parentFile!!.listFiles()!!.filter { it.isFile && it.name.startsWith(state.name) }.forEach { f ->
            var suffix = f.name.removePrefix(state.name)
            val kind = if (suffix.endsWith(".png")) { suffix = suffix.removeSuffix(".png"); "thumb" } else "state"
            val slot = when { suffix == "" -> "0"; suffix == ".auto" -> "-1"; suffix.matches(Regex("[0-9]+")) -> suffix.toInt().toString(); else -> null }
            if (slot != null) files += "$stateAdapter/$kind/$slot" to f
        }
        check(files.map { it.first }.distinct().size == files.size) { "Ambiguous duplicate state slots" }
        return files.map { (key, file) ->
            check(file.canonicalPath == file.absolutePath) { "Symlink save paths need a dedicated adapter" }
            val h = digest(file); val dest = File(blobs, h)
            if (!dest.exists()) {
                room(blobs, file.length()); val tmp = File(blobs, "$h.tmp")
                file.copyTo(tmp, true)
                check(digest(tmp) == h && digest(file) == h) { "Game is still writing" }
                FileOutputStream(tmp, true).use { it.fd.sync() }
                check(tmp.renameTo(dest)) { "Could not preserve save" }
                syncDirectory(blobs)
            }
            "$key\t$h\t${file.length()}\n"
        }.sorted().joinToString("")
    }
    private fun capture(d: File, s: JSONObject) {
        val j = item(s, s.getString("active"))
        check(!j.has("conflict")) { "Conflicting progress is preserved; resolve it before switching" }
        val first = scan(s); Thread.sleep(1000); val second = scan(s)
        check(first == second) { "Game is still writing; close it before switching" }
        val layout = s.getJSONObject("layout")
        val prefix = layout.optString("stateAdapter", layout.getString("emulator")) + "/"
        val savePrefix = layout.optString("saveAdapter", layout.getString("emulator")) + "/save/"
        val kept = j.optString("manifest").lineSequence().filter { it.isNotBlank() && !it.startsWith(prefix) && !it.startsWith(savePrefix) }.map { "$it\n" }.toList()
        val manifest = (kept + second.lineSequence().filter { it.isNotBlank() }.map { "$it\n" }).sorted().joinToString("")
        if (manifest != j.optString("manifest")) { j.put("manifest", manifest).put("dirty", true).put("localUpdatedAt", System.currentTimeMillis()); save(d, s) }
    }
    private fun synchronize(d: File, s: JSONObject) {
        val items = s.getJSONObject("items")
        items.keys().forEach { id ->
            val j = items.getJSONObject(id)
            if (j.optBoolean("create")) {
                call("create", "$id\t${s.getString("identity")}\t${Api.b64(j.getString("name"))}\n")
                j.remove("create"); save(d, s)
            }
            if (j.optBoolean("rename")) { call("rename/$id", Api.b64(j.getString("name"))); j.remove("rename"); save(d, s) }
            if (j.optBoolean("dirty") && !j.has("conflict")) {
                if (!j.has("outbox")) { j.put("outbox", j.getString("manifest")).put("operation", uuid()).put("outboxBase", j.optInt("base")); save(d, s) }
                entries(j.getString("outbox")).forEach { (_, h, _) -> api.uploadFile("/agent/journeys/blob/$h", File(blobs, h)) }
                val result = call("commit/$id", j.getString("outbox"), mapOf("X-Journey-Base" to j.getInt("outboxBase").toString(), "X-Journey-Operation" to j.getString("operation"))).trim().split('\t')
                if (result[0] == "conflict") { j.put("conflict", result[2]); save(d, s); error("Journey conflict: both checkpoints kept") }
                check(result[0] == "committed")
                entries(j.getString("outbox")).forEach { (key, _, _) -> if (key.contains("/save/")) summary.savesUp++ else if (key.contains("/state/")) summary.statesUp++ }
                j.put("base", result[1].toInt()).put("baseline", j.getString("outbox"))
                j.put("dirty", j.getString("outbox") != j.getString("manifest")); j.remove("outbox"); j.remove("operation"); save(d, s)
            }
        }
        if (s.has("selection")) { call("select/${s.getString("binding")}", s.getString("selection")); s.remove("selection"); save(d, s) }
        refresh(d, s, false)
        call("commands").lines().forEach { line ->
            val f = line.split('\t')
            if (f.size < 5 || f[0] != "command" || f[2] != s.getString("binding")) return@forEach
            val status = if (f[4].toInt() != s.getInt("generation")) "superseded" else {
                s.put("pending", f[3]).put("command", f[1]); save(d, s); "waiting"
            }
            call("commands/${f[1]}", "$status\n")
        }
    }
    private fun refresh(d: File, s: JSONObject, closed: Boolean) {
        val list = call("list/${s.getString("identity")}")
        for (line in list.lines()) {
            val f = line.split('\t'); if (f.size < 5 || f[0] != "journey") continue
            val j = item(s, f[1]); if (!j.optBoolean("rename")) j.put("name", decode(f[3]))
            j.put("head", f[2].toInt()).put("syncedAt", f[4])
            if (j.optBoolean("dirty") || j.has("conflict")) continue
            val manifest = call("manifest/${f[1]}/${f[2]}")
            try {
                entries(manifest).forEach { (key, h, size) ->
                    val file = File(blobs, h)
                    if (!file.exists()) {
                        room(blobs, size); api.download("/agent/journeys/blob/$h", emptyMap(), file, before = { check(digest(it) == h) { "Journey checksum mismatch" } })
                        if (key.contains("/save/")) summary.savesDown++ else if (key.contains("/state/")) summary.statesDown++
                    }
                }
                if (f[1] == s.getString("active") && manifest != j.optString("manifest")) {
                    j.put("incoming", manifest)
                    if (!closed) continue
                    check(Foreground.journeyState(context) != Foreground.JourneyState.RUNNING) { "Close the emulator first" }
                    materialize(d, s, f[1], manifest, false, f[2].toInt())
                }
                j.put("manifest", manifest).put("baseline", manifest).put("base", f[2].toInt()); j.remove("incoming")
            } finally { save(d, s) }
        }
        save(d, s)
    }
    private fun materialize(d: File, s: JSONObject, target: String, manifest: String, selection: Boolean, revision: Int? = null, command: String = "") {
        val journal = File(d, "journal")
        val before = s.toString()
        val old = item(s, s.getString("active")).optString("manifest")
        atomic(journal, JSONObject().put("state", before).put("old", old).put("target", manifest).toString())
        try {
            apply(s.getJSONObject("layout"), manifest, old)
            if (selection) {
                val generation = s.getInt("generation") + 1
                s.put("active", target).put("generation", generation).put("selection", "$target\t$generation\t${uuid()}\t${command.ifBlank { "-" }}\n")
            }
            if (revision != null) item(s, target).put("manifest", manifest).put("baseline", manifest).put("base", revision)
            save(d, s)
            atomic(File(d, "journal-done"), "done")
            check(journal.delete()); syncDirectory(d)
            File(d, "journal-done").delete(); syncDirectory(d)
            File(context.filesDir, "hashes.tsv").delete()
        } catch (e: Exception) { recover(d); throw e }
    }
    private fun apply(layout: JSONObject, manifest: String, old: String, recovering: Boolean = false) {
        val desired = entries(manifest)
        val total = desired.filter { path(layout, it.first) != null }.sumOf { it.third }
        if (!recovering) listOf(File(layout.getString("savePath")), File(layout.getString("statePath"))).forEach { room(it.parentFile!!, total) }
        entries(old).filter { oldEntry -> desired.none { it.first == oldEntry.first } }.forEach { e ->
            path(layout, e.first)?.let { check(!it.exists() || it.delete()) { "Could not remove outgoing journey file" } }
        }
        desired.forEach { (key, h, _) ->
            val dest = path(layout, key) ?: return@forEach
            room(dest.parentFile!!, File(blobs, h).length(), recovering)
            val blob = File(blobs, h); check(digest(blob) == h) { "Journey checksum mismatch" }
            check(dest.canonicalPath == dest.absolutePath) { "Unsafe save path" }
            val tmp = File(dest.path + ".journey-tmp"); blob.copyTo(tmp, true)
            FileOutputStream(tmp, true).use { it.fd.sync() }
            check(digest(tmp) == h && tmp.renameTo(dest)) { "Could not install journey file" }
            syncDirectory(dest.parentFile!!)
        }
    }
    private fun recover(d: File) {
        val journal = File(d, "journal")
        if (!journal.exists()) { File(d, "journal-done").delete(); return }
        if (!File(d, "journal-done").exists()) {
            val j = JSONObject(journal.readText()); val oldState = JSONObject(j.getString("state"))
            apply(oldState.getJSONObject("layout"), j.getString("old"), j.getString("target"), true); save(d, oldState)
        }
        check(journal.delete()) { "Journey recovery needs attention" }; syncDirectory(d)
        File(d, "journal-done").delete(); syncDirectory(d)
    }
    companion object {
        private fun decode(value: String) = String(Base64.getDecoder().decode(value))
        private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-1").digest(bytes).joinToString("") { "%02x".format(it) }
        private fun digest(file: File): String {
            val md = MessageDigest.getInstance("SHA-1")
            file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; md.update(buffer, 0, n) } }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
        private fun atomic(file: File, text: String) {
            file.parentFile!!.mkdirs(); val tmp = File(file.path + ".tmp")
            FileOutputStream(tmp).use { it.write(text.toByteArray()); it.fd.sync() }
            check(tmp.renameTo(file)) { "Could not save journey journal" }
            syncDirectory(file.parentFile!!)
        }
        private fun syncDirectory(dir: File) {
            val fd = Os.open(dir.path, OsConstants.O_RDONLY, 0)
            try { Os.fsync(fd) } finally { Os.close(fd) }
        }
    }
}
