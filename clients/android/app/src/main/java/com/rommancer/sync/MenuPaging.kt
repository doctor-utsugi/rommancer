package com.rommancer.sync

import androidx.compose.ui.focus.FocusRequester
import kotlin.math.abs

internal object MenuPaging {
    data class Row(val focus: FocusRequester, var y: Float = 0f, var focused: Boolean = false)
    val rows = linkedSetOf<Row>()
    fun move(direction: Int, viewport: Int): Boolean {
        val ordered = rows.sortedBy { it.y }
        if (ordered.isEmpty()) return false
        val current = ordered.firstOrNull { it.focused } ?: ordered.firstOrNull { it.y >= 0 } ?: ordered.first()
        val targetY = current.y + direction * viewport.coerceAtLeast(1) * .8f
        val candidates = ordered.filter { if (direction > 0) it.y > current.y else it.y < current.y }
        val target = candidates.minByOrNull { abs(it.y - targetY) } ?: current
        return runCatching { target.focus.requestFocus(); true }.getOrDefault(false)
    }
}
