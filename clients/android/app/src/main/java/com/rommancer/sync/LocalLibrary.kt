package com.rommancer.sync

import java.text.Normalizer

internal object LocalLibrary {
    private val names = mapOf("gba" to "Game Boy Advance", "gb" to "Game Boy", "gbc" to "Game Boy Color", "nes" to "NES / Famicom", "snes" to "Super Nintendo", "md" to "Mega Drive / Genesis", "sms" to "Master System", "gg" to "Game Gear", "n64" to "Nintendo 64", "nds" to "Nintendo DS", "psx" to "PlayStation", "psp" to "PlayStation Portable", "pce" to "PC Engine", "a2600" to "Atari 2600", "a7800" to "Atari 7800", "lynx" to "Atari Lynx", "ngp" to "Neo Geo Pocket", "ngpc" to "Neo Geo Pocket Color", "ws" to "WonderSwan", "wsc" to "WonderSwan Color", "unknown" to "Other consoles")
    fun systemName(slug: String) = names[slug] ?: slug.uppercase()
    fun normalize(value: String) = Normalizer.normalize(value.lowercase(), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()
    fun matches(query: String, vararg values: String): Boolean {
        val text = normalize(values.joinToString(" "))
        return normalize(query).split(' ').filter { it.isNotEmpty() }.all { it in text }
    }
    fun page(index: Int, direction: Int, count: Int, size: Int) = (index + direction).coerceIn(0, ((count - 1).coerceAtLeast(0) / size.coerceAtLeast(1)))
}
