package com.rommancer.sync

import android.content.Context

/** Server, device token and sync history kept in the app's private preferences. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("rommancer", Context.MODE_PRIVATE)

    var server: String
        get() = prefs.getString("server", "https://") ?: "https://"
        set(v) = prefs.edit().putString("server", v).apply()

    val token: String? get() = prefs.getString("token", null)
    val user: String? get() = prefs.getString("user", null)
    val linked: Boolean get() = !token.isNullOrBlank()

    /** Copies of overwritten saves to keep, as the server says */
    var backupsKeep: Int
        get() = prefs.getInt("backupsKeep", 20)
        set(v) = prefs.edit().putInt("backupsKeep", v).apply()

    /** When the last sync went through (ms), for the header */
    var lastSyncAt: Long
        get() = prefs.getLong("lastSyncAt", 0L)
        set(v) = prefs.edit().putLong("lastSyncAt", v).apply()

    /** The last pass's summary (Summary.encode) and when it ended (ms), for the Status screen */
    var lastSummary: String
        get() = prefs.getString("lastSummary", "") ?: ""
        set(v) = prefs.edit().putString("lastSummary", v).apply()
    var lastSummaryAt: Long
        get() = prefs.getLong("lastSummaryAt", 0L)
        set(v) = prefs.edit().putLong("lastSummaryAt", v).apply()

    /** A rom download was stopped on screen: background passes leave the roms alone until one is asked for there */
    var romsStopped: Boolean
        get() = prefs.getBoolean("romsStopped", false)
        set(v) = prefs.edit().putBoolean("romsStopped", v).apply()

    /** Let the server fetch roms it lacks from this device */
    var allowPull: Boolean
        get() = prefs.getBoolean("allowPull", true)
        set(v) = prefs.edit().putBoolean("allowPull", v).apply()

    /**
     * Delete roms that are in none of this device's lists. The device owns the setting: PRUNE_SET until the server
     * hears a change (or an answer to one made in the web app); PRUNE_ASK ("files<TAB>bytes") while such a change
     * waits for the user; PRUNE_HOLD ("files<TAB>roms") while a deletion of more than half of the roms waits;
     * PRUNE_INTRO once the choice was offered; PRUNED: the roms deleted, for the clean-up of their saves.
     */
    var pruneRoms: Boolean
        get() = prefs.getBoolean("pruneRoms", false)
        set(v) = prefs.edit().putBoolean("pruneRoms", v).apply()
    var pruneSet: Boolean
        get() = prefs.getBoolean("pruneSet", false)
        set(v) = prefs.edit().putBoolean("pruneSet", v).apply()
    var pruneAsk: String?
        get() = prefs.getString("pruneAsk", null)
        set(v) = prefs.edit().putString("pruneAsk", v).apply()
    var pruneHold: String?
        get() = prefs.getString("pruneHold", null)
        set(v) = prefs.edit().putString("pruneHold", v).apply()
    var pruneIntro: Boolean
        get() = prefs.getBoolean("pruneIntro", false)
        set(v) = prefs.edit().putBoolean("pruneIntro", v).apply()
    var pruned: List<String>
        get() = (prefs.getString("pruned", "") ?: "").lines().filter { it.isNotBlank() }
        set(v) = prefs.edit().putString("pruned", v.joinToString("\n")).apply()

    /** Upload saves as soon as a game writes them (a background service with a notification) */
    var watch: Boolean
        get() = prefs.getBoolean("watch", true)
        set(v) = prefs.edit().putBoolean("watch", v).apply()

    /** A note over the game as it starts: whether it plays the server's latest save */
    var gameNote: Boolean
        get() = prefs.getBoolean("gameNote", true)
        set(v) = prefs.edit().putBoolean("gameNote", v).apply()

    /** A note over the game each time a save made in it reaches the server */
    var gameUpNote: Boolean
        get() = prefs.getBoolean("gameUpNote", false)
        set(v) = prefs.edit().putBoolean("gameUpNote", v).apply()

    /** Dolphin's user folder, shared through the system folder picker (a document tree URI) */
    var dolphinTree: String?
        get() = prefs.getString("dolphinTree", null)
        set(v) = prefs.edit().putString("dolphinTree", v).apply()

    /** Last events, newest last, for the Status screen */
    val log: List<String> get() = (prefs.getString("log", "") ?: "").lines().filter { it.isNotBlank() }

    fun addLog(line: String) {
        val stamp = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.ROOT).format(java.util.Date())
        prefs.edit().putString("log", (log + "$stamp $line").takeLast(20).joinToString("\n")).apply()
    }

    fun link(token: String, user: String) = prefs.edit().putString("token", token).putString("user", user).apply()

    // Another account's lists are not this one's: the deletion of roms in no list starts off and is offered again
    fun unlink() = prefs.edit().remove("token").remove("user").remove("lastResult").remove("lastSummary").remove("lastSummaryAt")
        .remove("pruneRoms").remove("pruneSet").remove("pruneAsk").remove("pruneHold").remove("pruneIntro").remove("pruned").apply()
}
