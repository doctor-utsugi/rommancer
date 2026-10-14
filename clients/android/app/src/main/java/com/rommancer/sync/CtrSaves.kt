package com.rommancer.sync

import java.io.File
import java.io.RandomAccessFile

/**
 * 3DS saves (Azahar, Citra and its forks): each game's save folder sits in the emulator's SD card at
 * "sdmc/Nintendo 3DS/<id0>/<id1>/title/00040000/<title id low>/data/", named after the game's title id, which the
 * server learns from the roms' headers ("tid" lines). A folder goes as one file whose path ends in "/" (its tar).
 */
object CtrSaves {
    /** The title id of a .3ds or .cci rom (its NCSD header's media id), 16 hex digits; null for any other file */
    fun titleId(rom: File): String? {
        if (rom.extension.lowercase() !in setOf("3ds", "cci")) return null
        RandomAccessFile(rom, "r").use { f ->
            if (f.length() < 0x110) return null
            val h = ByteArray(0x10)
            f.seek(0x100)
            f.readFully(h)
            if (String(h, 0, 4, Charsets.US_ASCII) != "NCSD") return null
            return (7 downTo 0).joinToString("") { "%02X".format(h[8 + it].toInt() and 0xff) }
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
