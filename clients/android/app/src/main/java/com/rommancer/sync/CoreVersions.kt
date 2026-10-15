package com.rommancer.sync

import android.os.Environment
import java.io.File

internal object CoreVersions {
    fun read(): Map<String, String> {
        val root = Environment.getExternalStorageDirectory()
        val directories = listOf("RetroArch/info", "RetroArch/cores", "RetroArch/.retroarch/info", "RetroArch/.retroarch/cores")
        val result = linkedMapOf<String, String>()
        val name = Regex("(?m)^\\s*corename\\s*=\\s*\"([^\"]+)\"")
        val version = Regex("(?m)^\\s*display_version\\s*=\\s*\"([^\"]+)\"")
        directories.flatMap { File(root, it).listFiles().orEmpty().toList() }.filter { it.isFile && it.extension == "info" && it.length() <= 65536 }.forEach { file ->
            runCatching { file.readText() }.getOrNull()?.let { text ->
                val n = name.find(text)?.groupValues?.get(1)
                val v = version.find(text)?.groupValues?.get(1)
                if (n != null && v != null) result.putIfAbsent(n, v)
            }
        }
        return result
    }
}
