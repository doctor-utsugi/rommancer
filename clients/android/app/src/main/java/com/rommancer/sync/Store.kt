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

    fun link(token: String, user: String) = prefs.edit().putString("token", token).putString("user", user).apply()

    fun unlink() = prefs.edit().remove("token").remove("user").remove("lastResult").apply()
}
