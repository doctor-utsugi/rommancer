package com.rommancer.sync

import android.content.pm.PackageManager
import rikka.shizuku.Shizuku
import java.io.File

/**
 * Shell-level access through Shizuku, or root on a rooted device without it: the emulators' folders under
 * Android/data, and stopping an emulator.
 */
object Privileged {
    enum class State { NOT_RUNNING, NOT_ALLOWED, READY }

    fun state(): State = runCatching {
        when {
            !Shizuku.pingBinder() || Shizuku.isPreV11() -> if (root) State.READY else State.NOT_RUNNING
            Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED -> if (root) State.READY else State.NOT_ALLOWED
            else -> State.READY
        }
    }.getOrDefault(if (root) State.READY else State.NOT_RUNNING)

    val ready get() = state() == State.READY

    private fun shizuku() = runCatching { Shizuku.pingBinder() && !Shizuku.isPreV11() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED }.getOrDefault(false)

    @Volatile private var rootKnown: Boolean? = null
    @Volatile private var rootAskedAt = 0L

    /**
     * Whether su runs commands as root here, asked off the main thread (Magisk shows its prompt the first time); a
     * refusal is asked again after a few minutes, as the user may grant it later. The screen sees it once a sync asked
     */
    private val root: Boolean
        get() {
            rootKnown?.let { if (it || System.currentTimeMillis() - rootAskedAt < 5 * 60_000L) return it }
            if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return false
            // Wherever the root manager put it (/product/bin, /debug_ramdisk...): asked by name, none without it
            val ok = runCatching { ProcessBuilder("su", "-c", "id -u").start().let { p -> p.inputStream.bufferedReader().readText().trim() == "0" && p.waitFor() == 0 } }.getOrDefault(false)
            rootAskedAt = System.currentTimeMillis()
            return ok.also { rootKnown = it }
        }

    fun request(code: Int) = runCatching { Shizuku.requestPermission(code) }

    private fun q(s: String) = "'" + s.replace("'", "'\\''") + "'"

    /** newProcess is not public in Shizuku's API 13; it is still there and is what file access needs */
    private fun exec(command: String, input: ByteArray? = null): Pair<Int, ByteArray> {
        val p = if (shizuku()) {
            val m = Shizuku::class.java.getDeclaredMethod("newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java)
            m.isAccessible = true
            m.invoke(null, arrayOf("sh", "-c", command), null, null) as Process
        } else ProcessBuilder("su", "-c", command).start()
        p.outputStream.use { out -> input?.let { out.write(it) } }
        val bytes = p.inputStream.use { it.readBytes() }
        return p.waitFor() to bytes
    }

    /** A file of another app's private data, which only root reads; none without root */
    fun rootRead(path: String): ByteArray? {
        if (!root) return null
        return runCatching {
            val p = ProcessBuilder("su", "-c", "cat ${q(path)}").start()
            p.outputStream.close()
            val bytes = p.inputStream.use { it.readBytes() }
            if (p.waitFor() == 0) bytes else null
        }.getOrNull()
    }

    fun read(path: String): ByteArray? = exec("[ -f ${q(path)} ] && cat ${q(path)}").let { (code, out) -> if (code == 0) out else null }

    fun list(dir: String): List<String> = exec("find ${q(dir)} -type f 2>/dev/null | head -n 200").second.toString(Charsets.UTF_8).lines().filter { it.isNotBlank() }

    fun write(path: String, data: ByteArray): Boolean {
        val dir = File(path).parent ?: return false
        val tmp = "$path.rommancer-tmp"
        return exec("mkdir -p ${q(dir)} && cat > ${q(tmp)} && mv ${q(tmp)} ${q(path)}", data).first == 0
    }

    fun delete(path: String) = exec("rm -f ${q(path)}").first == 0

    fun isDir(path: String) = exec("[ -d ${q(path)} ]").first == 0

    /** The folders right inside DIR */
    fun dirs(dir: String): List<String> = exec("find ${q(dir)} -mindepth 1 -maxdepth 1 -type d 2>/dev/null").second.toString(Charsets.UTF_8).lines().filter { it.isNotBlank() }

    /** Every file under DIR with its size and time in seconds */
    fun stats(dir: String): List<Triple<String, Long, Long>> =
        exec("find ${q(dir)} -type f -exec stat -c '%s %Y %n' {} + 2>/dev/null").second.toString(Charsets.UTF_8).lines().mapNotNull { l ->
            val f = l.split(' ', limit = 3)
            if (f.size == 3) Triple(f[2], f[0].toLongOrNull() ?: return@mapNotNull null, f[1].toLongOrNull() ?: 0L) else null
        }

    /** Puts folder FROM in the place of folder TO, whatever TO held */
    fun replaceDir(from: String, to: String) = exec("rm -rf ${q(to)} && mv ${q(from)} ${q(to)}").first == 0

    fun removeDir(path: String) = exec("rm -rf ${q(path)}").first == 0

    fun running(pkg: String) = exec("pidof ${q(pkg)}").first == 0

    /** The package of the activity in front ("topResumedActivity=ActivityRecord{... u0 pkg/.Activity ...}") */
    fun foreground(): String? = runCatching {
        val out = exec("dumpsys activity activities | grep -m 1 -E 'topResumedActivity|mResumedActivity'").second.toString(Charsets.UTF_8)
        Regex(""" u\d+ ([\w.]+)/""").find(out)?.groupValues?.get(1)
    }.getOrNull()

    fun forceStop(pkg: String) = exec("am force-stop ${q(pkg)}").first == 0
}
