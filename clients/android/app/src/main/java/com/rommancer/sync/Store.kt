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

    var lastResult: String
        get() = prefs.getString("lastResult", "") ?: ""
        set(v) = prefs.edit().putString("lastResult", v).apply()

    /** Download the lists' roms by itself */
    var autoRoms: Boolean
        get() = prefs.getBoolean("autoRoms", true)
        set(v) = prefs.edit().putBoolean("autoRoms", v).apply()

    /** Let the server fetch roms it lacks from this device */
    var allowPull: Boolean
        get() = prefs.getBoolean("allowPull", true)
        set(v) = prefs.edit().putBoolean("allowPull", v).apply()

    /** Upload saves as soon as a game writes them (a background service with a notification) */
    var watch: Boolean
        get() = prefs.getBoolean("watch", true)
        set(v) = prefs.edit().putBoolean("watch", v).apply()

    /** Last events, newest last, for the Status screen */
    val log: List<String> get() = (prefs.getString("log", "") ?: "").lines().filter { it.isNotBlank() }

    fun addLog(line: String) {
        val stamp = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.ROOT).format(java.util.Date())
        prefs.edit().putString("log", (log + "$stamp $line").takeLast(20).joinToString("\n")).apply()
    }

    fun link(token: String, user: String) = prefs.edit().putString("token", token).putString("user", user).apply()

    fun unlink() = prefs.edit().remove("token").remove("user").remove("lastResult").apply()
}
