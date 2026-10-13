package com.rommancer.sync

import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest

/**
 * PSP saves (PPSSPP, its RetroArch core): a folder per save in a memory stick's PSP/SAVEDATA. Each goes to the server
 * as one file whose path ends in "/" (a tar of it, its files under "<folder>/") and is told apart by its manifest's
 * hash, a "<path>\t<sha1>" line per file sorted by path. PPSSPP's own folder in Android/data is reached through
 * Shizuku when it is allowed.
 */
class PspSaves(private val root: File) {

    /** A file of a save folder: its path inside the folder, size and time for the hash cache */
    data class Entry(val rel: String, val abs: String, val size: Long, val modified: Long)

    private fun guarded(path: String) = path.contains("/Android/data/")

    /** SAVEDATA folders: PPSSPP's memory sticks on shared storage and in its own folder, and any under SAVE_DIRS */
    fun sticks(saveDirs: List<File>): List<String> {
        val out = linkedSetOf<String>()
        val shared = File(root, "PSP/SAVEDATA")
        if (shared.isDirectory) out += shared.path
        if (Privileged.ready) for (pkg in PACKAGES) {
            val d = File(root, "Android/data/$pkg/files/PSP/SAVEDATA").path
            if (Privileged.isDir(d)) out += d
        }
        for (dir in saveDirs) dir.walkTopDown().maxDepth(5).onEnter { !it.name.startsWith(".") }
            .filter { it.isDirectory && it.name == "SAVEDATA" && it.parentFile?.name == "PSP" }
            .forEach { out += it.path }
        return out.toList()
    }

    /** The save folders in a SAVEDATA folder */
    fun folders(stick: String): List<String> =
        (if (guarded(stick)) Privileged.dirs(stick) else File(stick).listFiles()?.filter { it.isDirectory }?.map { it.path }.orEmpty())
            .filter { !File(it).name.startsWith(".") }.sorted()

    fun entries(dir: String): List<Entry> {
        val base = dir.trimEnd('/')
        val files = if (guarded(base)) Privileged.stats(base).map { (p, size, time) -> Entry(p.removePrefix("$base/"), p, size, time) }
        else File(base).walkTopDown().filter { it.isFile }.map { Entry(it.path.removePrefix("$base/"), it.path, it.length(), it.lastModified() / 1000) }.toList()
        return files.sortedBy { it.rel }
    }

    private fun read(path: String): ByteArray = if (guarded(path)) Privileged.read(path) ?: error("cannot read $path") else File(path).readBytes()

    /** Size and newest time of a folder's files, to keep its hash while they do not change; null for an empty folder */
    fun signature(entries: List<Entry>): Pair<Long, Long>? =
        if (entries.isEmpty()) null else (entries.sumOf { it.size } shl 8) + entries.size to entries.maxOf { it.modified }

    fun hash(entries: List<Entry>): String? {
        if (entries.isEmpty()) return null
        val lines = entries.map { "${it.rel}\t${sha1(read(it.abs))}\n" }.sortedWith { a, b -> compareBytes(a.toByteArray(), b.toByteArray()) }
        return sha1(lines.joinToString("").toByteArray())
    }

    /** The tar of a save folder ("<path>/") */
    fun pack(path: String): ByteArray {
        val dir = path.trimEnd('/')
        val name = File(dir).name
        val out = ByteArrayOutputStream()
        for (e in entries(dir).sortedWith { a, b -> compareBytes(a.rel.toByteArray(), b.rel.toByteArray()) }) {
            val data = read(e.abs)
            out.write(header("$name/${e.rel}", data.size.toLong()))
            out.write(data)
            out.write(ByteArray((BLOCK - data.size % BLOCK) % BLOCK))
        }
        out.write(ByteArray(BLOCK * 2))
        return out.toByteArray()
    }

    /** Writes the folder a tar holds as PATH ("<path>/"), replacing what was there */
    fun write(path: String, tar: ByteArray) {
        val dir = path.trimEnd('/')
        val tmp = File(File(dir).parentFile, ".rommancer-" + File(dir).name).path
        val files = unpack(tar)
        if (files.isEmpty()) error("empty save folder")
        if (guarded(dir)) {
            Privileged.removeDir(tmp)
            for ((rel, data) in files) if (!Privileged.write("$tmp/$rel", data)) error("cannot write $rel")
            if (!Privileged.replaceDir(tmp, dir)) error("cannot replace ${File(dir).name}")
        } else {
            File(tmp).deleteRecursively()
            for ((rel, data) in files) File(tmp, rel).apply { parentFile?.mkdirs() }.writeBytes(data)
            File(dir).deleteRecursively()
            if (!File(tmp).renameTo(File(dir))) error("cannot replace ${File(dir).name}")
        }
    }

    companion object {
        private const val BLOCK = 512

        /** PPSSPP and PPSSPP Gold */
        val PACKAGES = listOf("org.ppsspp.ppsspp", "org.ppsspp.ppssppgold")

        fun sha1(data: ByteArray): String = MessageDigest.getInstance("SHA-1").digest(data).joinToString("") { "%02x".format(it) }

        private fun compareBytes(a: ByteArray, b: ByteArray): Int {
            for (i in 0 until minOf(a.size, b.size)) {
                val d = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
                if (d != 0) return d
            }
            return a.size - b.size
        }

        private fun octal(n: Long, len: Int) = n.toString(8).padStart(len - 1, '0') + "\u0000"

        private fun header(name: String, size: Long): ByteArray {
            val h = ByteArray(BLOCK)
            fun put(at: Int, s: String) = s.toByteArray(Charsets.UTF_8).copyInto(h, at)
            if (name.toByteArray().size > 100) error("path too long: $name")
            put(0, name)
            put(100, octal(0x1a4, 8))
            put(108, octal(0, 8))
            put(116, octal(0, 8))
            put(124, octal(size, 12))
            put(136, octal(0, 12))
            put(148, "        ")
            put(156, "0")
            put(257, "ustar\u0000")
            put(263, "00")
            val sum = h.sumOf { it.toInt() and 0xff }.toLong()
            put(148, octal(sum, 7) + " ")
            return h
        }

        /** The files of a tar of one folder, by their path inside it (the folder's own name dropped) */
        fun unpack(tar: ByteArray): List<Pair<String, ByteArray>> {
            val out = mutableListOf<Pair<String, ByteArray>>()
            var at = 0
            while (at + BLOCK <= tar.size) {
                if ((at until at + BLOCK).all { tar[it].toInt() == 0 }) break
                fun field(o: Int, l: Int): String {
                    var end = at + o
                    while (end < at + o + l && tar[end].toInt() != 0) end++
                    return String(tar, at + o, end - at - o, Charsets.UTF_8)
                }
                val name = field(0, 100)
                val size = field(124, 12).trim().ifEmpty { "0" }.toLong(8).toInt()
                val type = tar[at + 156].toInt()
                at += BLOCK
                if (at + size > tar.size) error("truncated save folder")
                val rel = name.substringAfter('/', "")
                val safe = rel.isNotEmpty() && rel.split('/').all { it.isNotEmpty() && it != "." && it != ".." }
                if ((type == '0'.code || type == 0) && safe) out += rel to tar.copyOfRange(at, at + size)
                at += (size + BLOCK - 1) / BLOCK * BLOCK
            }
            return out
        }
    }
}
