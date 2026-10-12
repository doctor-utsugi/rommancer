package com.rommancer.sync

import android.content.pm.PackageManager
import rikka.shizuku.Shizuku
import java.io.File

/** Shell-level access through Shizuku: the emulators' folders under Android/data, and stopping an emulator. */
object Privileged {
    enum class State { NOT_RUNNING, NOT_ALLOWED, READY }

    fun state(): State = runCatching {
        when {
            !Shizuku.pingBinder() || Shizuku.isPreV11() -> State.NOT_RUNNING
            Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED -> State.NOT_ALLOWED
            else -> State.READY
        }
    }.getOrDefault(State.NOT_RUNNING)

    val ready get() = state() == State.READY

    fun request(code: Int) = runCatching { Shizuku.requestPermission(code) }

    private fun q(s: String) = "'" + s.replace("'", "'\\''") + "'"

    /** newProcess is not public in Shizuku's API 13; it is still there and is what file access needs */
    private fun exec(command: String, input: ByteArray? = null): Pair<Int, ByteArray> {
        val m = Shizuku::class.java.getDeclaredMethod("newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java)
        m.isAccessible = true
        val p = m.invoke(null, arrayOf("sh", "-c", command), null, null) as Process
        p.outputStream.use { out -> input?.let { out.write(it) } }
        val bytes = p.inputStream.use { it.readBytes() }
        return p.waitFor() to bytes
    }

    fun read(path: String): ByteArray? = exec("[ -f ${q(path)} ] && cat ${q(path)}").let { (code, out) -> if (code == 0) out else null }

    fun list(dir: String): List<String> = exec("find ${q(dir)} -type f 2>/dev/null | head -n 200").second.toString(Charsets.UTF_8).lines().filter { it.isNotBlank() }

    fun write(path: String, data: ByteArray): Boolean {
        val dir = File(path).parent ?: return false
        val tmp = "$path.rommancer-tmp"
        return exec("mkdir -p ${q(dir)} && cat > ${q(tmp)} && mv ${q(tmp)} ${q(path)}", data).first == 0
    }

    fun delete(path: String) = exec("rm -f ${q(path)}").first == 0

    fun running(pkg: String) = exec("pidof ${q(pkg)}").first == 0

    /** The package of the activity in front ("topResumedActivity=ActivityRecord{... u0 pkg/.Activity ...}") */
    fun foreground(): String? = runCatching {
        val out = exec("dumpsys activity activities | grep -m 1 -E 'topResumedActivity|mResumedActivity'").second.toString(Charsets.UTF_8)
        Regex(""" u\d+ ([\w.]+)/""").find(out)?.groupValues?.get(1)
    }.getOrNull()

    fun forceStop(pkg: String) = exec("am force-stop ${q(pkg)}").first == 0
}
