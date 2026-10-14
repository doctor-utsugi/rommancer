package com.rommancer.sync

import java.io.File
import java.io.RandomAccessFile

/**
 * 3DS saves (Azahar, Citra and its forks): each game's save folder sits in the emulator's SD card at
 * "sdmc/Nintendo 3DS/<id0>/<id1>/title/00040000/<title id low>/data/", named after the game's title id, which the
 * server learns from the roms' headers ("tid" lines). A folder goes as one file whose path ends in "/" (its tar),
 * told apart by its manifest's hash as PSP save folders are.
 */
object CtrSaves {
    /** The title id of a .3ds or .cci rom (its NCSD header's media id) or of a .cia (its TMD's), 16 hex digits */
    fun titleId(rom: File): String? {
        val ext = rom.extension.lowercase()
        if (ext != "3ds" && ext != "cci" && ext != "cia") return null
        RandomAccessFile(rom, "r").use { f ->
            fun bytes(at: Long, n: Int): ByteArray? = if (at < 0 || at + n > f.length()) null else ByteArray(n).also { f.seek(at); f.readFully(it) }
            if (ext != "cia") {
                val h = bytes(0x100, 0x10) ?: return null
                if (String(h, 0, 4, Charsets.US_ASCII) != "NCSD") return null
                return (7 downTo 0).joinToString("") { "%02X".format(h[8 + it].toInt() and 0xff) }
            }
            // CIA: header, certificate chain, ticket and TMD, each aligned to 64 bytes; the TMD's signature size
            // depends on its type, and the title id sits 0x4C into the header after it (big-endian)
            val h = bytes(0, 0x20) ?: return null
            fun le(at: Int) = (0 until 4).fold(0L) { acc, i -> acc or ((h[at + i].toLong() and 0xff) shl (8 * i)) }
            fun align(n: Long) = (n + 63) / 64 * 64
            val tmd = align(align(align(le(0)) + le(8)) + le(12))
            val type = bytes(tmd, 4)?.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xff) } ?: return null
            val sig = when (type) { 0x10003L -> 0x23C; 0x10004L -> 0x13C; 0x10005L -> 0x7C; else -> return null }
            val id = bytes(tmd + 4 + sig + 0x4C, 8) ?: return null
            return id.joinToString("") { "%02X".format(it.toInt() and 0xff) }
        }
    }

    /** The emulators' folders of games' saves, under the storage's top folders (the emulator's user folder) */
    fun titleDirs(root: File): List<File> =
        root.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") && it.name != "Android" }.orEmpty()
            .flatMap { user -> File(user, "sdmc/Nintendo 3DS").listFiles()?.filter { it.isDirectory }.orEmpty() }
            .flatMap { id0 -> id0.listFiles()?.filter { it.isDirectory }.orEmpty() }
            .map { File(it, "title/00040000") }

    /** The save folders that hold a save (a game that never saved leaves its archive empty) */
    fun folders(titles: File): List<String> =
        titles.listFiles()?.map { File(it, "data") }
            ?.filter { data -> data.walkTopDown().any { it.isFile && it.parentFile != data } }
            ?.map { it.path }?.sorted().orEmpty()
}
