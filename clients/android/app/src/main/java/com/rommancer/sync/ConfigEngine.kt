package com.rommancer.sync

import android.content.Context
import android.os.Environment
import java.io.File
import java.util.Base64

/** Configuration work from the server, same steps as the console clients; Android/data only through Shizuku. */
class ConfigEngine(private val context: Context, private val store: Store) {
    private val root: File = Environment.getExternalStorageDirectory()
    private val api get() = Api(store.server, store.token ?: error("Not linked"))
    private val emulators = listOf("com.retroarch.aarch64", "com.retroarch", "com.retroarch.ra32", "org.ppsspp.ppsspp", "org.ppsspp.ppssppgold")

    private fun abs(p: String) = if (p.startsWith("/")) p else "${root.path}/$p"
    private fun guarded(p: String) = "/Android/data/" in abs(p)
    /** The app a path under Android/data belongs to, to stop it before writing */
    private fun owner(p: String) = Regex("/Android/data/([^/]+)/").find(abs(p))?.groupValues?.get(1)
    private fun b64(s: String) = Base64.getEncoder().encodeToString(s.toByteArray())

    private fun read(p: String): ByteArray? = if (guarded(p)) Privileged.read(abs(p)) else File(abs(p)).takeIf { it.isFile }?.readBytes()

    private fun write(p: String, data: ByteArray): Boolean {
        if (guarded(p)) return Privileged.write(abs(p), data)
        val f = File(abs(p))
        f.parentFile?.mkdirs()
        val tmp = File(f.path + ".rommancer-tmp")
        tmp.writeBytes(data)
        return tmp.renameTo(f)
    }

    /** Returns how many operations were done; nothing while an emulator is open (stopping it would lose the game) */
    fun run(): Int {
        val privileged = Privileged.ready
        if (privileged && emulators.any { Privileged.running(it) }) return 0
        var done = 0
        repeat(5) {
            val plan = api.text("/agent/config/plan").lines().map { it.split('\t') }.filter { it.size >= 2 }
            val op = plan.firstOrNull { it[0] == "op" }?.get(1) ?: return done
            val files = mutableListOf<String>()
            for (l in plan) {
                val p = l[1]
                if (p.contains("..") || (guarded(p) && !privileged)) continue
                when (l[0]) {
                    "get" -> files += p
                    "dir" -> {
                        val found = if (guarded(p)) Privileged.list(abs(p)) else File(abs(p)).walkTopDown().filter { it.isFile }.take(200).map { it.path }.toList()
                        files += found.map { f -> p + f.removePrefix(abs(p)) }
                    }
                }
            }
            for (p in files) {
                val data = read(p)
                val headers = mutableMapOf("X-Path-B64" to b64(p), "Content-Type" to "application/octet-stream")
                if (data == null) headers["X-Missing"] = "1"
                api.text("/agent/config/file/$op", "POST", data ?: ByteArray(0), headers)
            }
            val puts = api.text("/agent/config/ready/$op", "POST", ByteArray(0), mapOf("Content-Type" to "text/plain")).lines().map { it.split('\t') }.filter { it.size >= 3 && (it[0] == "put" || it[0] == "del") }
            var failed: String? = null
            if (privileged) puts.mapNotNull { owner(it[2]) }.distinct().forEach { Privileged.forceStop(it) }
            for (l in puts) {
                val p = l[2]
                if (guarded(p) && !privileged) { failed = p; continue }
                val ok = if (l[0] == "del") (if (guarded(p)) Privileged.delete(abs(p)) else File(abs(p)).delete() || !File(abs(p)).exists())
                else {
                    val tmp = File(context.cacheDir, "config-out")
                    runCatching { api.download("/agent/config/out/$op/${l[1]}", emptyMap(), tmp); write(p, tmp.readBytes()) }.getOrDefault(false).also { tmp.delete() }
                }
                if (!ok) failed = p
            }
            if (puts.isNotEmpty()) api.text("/agent/config/done/$op", "POST", (if (failed == null) "ok" else "error\twriteFailed:$failed").toByteArray(), mapOf("Content-Type" to "text/plain"))
            done++
        }
        return done
    }
}
