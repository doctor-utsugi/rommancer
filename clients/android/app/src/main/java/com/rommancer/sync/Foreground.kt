package com.rommancer.sync

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Process

/**
 * Whether a game may be running: an app other than the launcher, the frontend or this one is in front. An emulator
 * keeps its save in memory and writes it back over one that arrived meanwhile, so saves wait for it to close. Told by
 * usage access when the user allowed it, Shizuku otherwise; unknown (never holds anything) without either.
 */
object Foreground {
    enum class JourneyState { RUNNING, STOPPED, UNKNOWN }

    fun journeyState(context: Context): JourneyState {
        if (emulator(context)?.contains(JOURNEY_EMULATOR) == true) return JourneyState.RUNNING
        if (!Privileged.ready || !Privileged.quiet) return JourneyState.UNKNOWN
        val names = Privileged.processNames() ?: return JourneyState.UNKNOWN
        return if (names.any { it.contains(JOURNEY_EMULATOR, ignoreCase = true) }) JourneyState.RUNNING else JourneyState.STOPPED
    }
    /**
     * The emulator still running, asked when the user is about to change slots: one root call is fine then (the
     * periodic checks above stay quiet). STOPPED only when a full process list shows none
     */
    fun runningEmulator(context: Context): Pair<JourneyState, String?> {
        // Journeys only hold RetroArch's files so far: another emulator open (Dolphin, PPSSPP...) cannot write over them
        emulator(context)?.takeIf { JOURNEY_EMULATOR in it.lowercase() }?.let { return JourneyState.RUNNING to it }
        if (!Privileged.ready) return JourneyState.UNKNOWN to null
        val names = Privileged.processNames() ?: return JourneyState.UNKNOWN to null
        val running = names.firstOrNull { name -> name.contains(JOURNEY_EMULATOR, ignoreCase = true) }
        return if (running != null) JourneyState.RUNNING to running.substringBefore(':') else JourneyState.STOPPED to null
    }

    fun allowed(context: Context): Boolean = runCatching {
        val ops = context.getSystemService(AppOpsManager::class.java)
        @Suppress("DEPRECATION")
        val mode = if (android.os.Build.VERSION.SDK_INT >= 29) ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        else ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        mode == AppOpsManager.MODE_ALLOWED
    }.getOrDefault(false)

    /** The package in front; null when it cannot be told. QUIET: not through su (its manager says so on screen) */
    fun current(context: Context, quiet: Boolean = false): String? {
        if (allowed(context)) {
            val usm = context.getSystemService(UsageStatsManager::class.java)
            val now = System.currentTimeMillis()
            val events = usm.queryEvents(now - 6 * 3600_000L, now)
            val e = UsageEvents.Event()
            var top: String? = null
            while (events.hasNextEvent()) {
                events.getNextEvent(e)
                if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) top = e.packageName
            }
            return top
        }
        return if (Privileged.ready && (!quiet || Privileged.quiet)) Privileged.foreground() else null
    }

    fun playing(context: Context): Boolean {
        val top = current(context) ?: return false
        return top !in frontends(context)
    }

    /** The emulator in front, when the app in front is one (the game notes are not for browsers or settings) */
    fun emulator(context: Context): String? = current(context, quiet = true)?.takeIf { pkg -> EMULATORS.any { it in pkg.lowercase() } }

    private fun frontends(context: Context): Set<String> {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val launchers = context.packageManager.queryIntentActivities(home, 0).map { it.activityInfo.packageName }
        return (launchers + context.packageName + FRONTENDS).toSet()
    }

    private const val JOURNEY_EMULATOR = "retroarch"

    // Words in emulators' package names
    private val EMULATORS = listOf(
        "retroarch", "ppsspp", "duckstation", "aethersx2", "nethersx2", "armsx2", "dolphin", "azahar", "citra", "lime3ds",
        "melonds", "drastic", "flycast", "redream", "mupen64", "lemuroid", "yabasanshiro", "vita3k", "yuzu", "eden_emulator",
        "scummvm", "explusalpha", "mame", "epsxe", "fpse", "pizzaboy", "myboy", "mgba", "johnemulators", "sudachi", "citron",
    )

    // Frontends and system screens a game is never played in
    private val FRONTENDS = listOf("org.es_de.frontend", "com.android.systemui", "com.android.settings", "com.android.packageinstaller", "com.google.android.packageinstaller")
}
