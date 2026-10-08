package com.rommancer.sync

import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import java.util.Base64

/** The user's networks handed to Android (11+): it asks in its own dialog and keeps them as saved networks. */
object WifiSetup {
    data class Net(val ssid: String, val password: String, val band: String, val hidden: Boolean)

    val supported get() = Build.VERSION.SDK_INT >= 30

    /** "dual" when the WiFi chip also works on 5 GHz, "2.4" otherwise; told to the server on every sync */
    fun bands(context: Context): String {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return ""
        return if (wifi.is5GHzBandSupported) "dual" else "2.4"
    }

    /** The networks this device can see: 5 GHz-only ones are left out on a 2.4 GHz chip */
    fun fetch(context: Context, store: Store): List<Net> {
        val api = Api(store.server, store.token ?: error("Not linked"))
        val dec = { s: String -> String(Base64.getDecoder().decode(s)) }
        val dual = bands(context) == "dual"
        return api.text("/agent/config/wifi").lines().mapNotNull { line ->
            val f = line.split('\t')
            if (f.size < 5 || f[0] != "wifi") null else Net(dec(f[1]), dec(f[2]), f[3], f[4] == "1")
        }.filter { dual || it.band != "5" }
    }

    fun intent(nets: List<Net>): Intent? {
        if (!supported || nets.isEmpty()) return null
        val list = ArrayList(nets.take(5).map { n ->
            WifiNetworkSuggestion.Builder().setSsid(n.ssid).apply {
                if (n.password.isNotEmpty()) setWpa2Passphrase(n.password)
                if (n.hidden) setIsHiddenSsid(true)
            }.build()
        })
        return Intent(Settings.ACTION_WIFI_ADD_NETWORKS).putExtras(Bundle().apply { putParcelableArrayList(Settings.EXTRA_WIFI_NETWORK_LIST, list) })
    }
}
