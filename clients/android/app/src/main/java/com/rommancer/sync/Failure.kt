package com.rommancer.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.net.ssl.SSLException

/** Why something failed, in words, and the details behind it for the "details" button */
object Failure {
    fun describe(context: Context, store: Store, e: Throwable): Pair<String, String> {
        val chain = generateSequence(e) { it.cause }.toList()
        val host = runCatching { java.net.URL(store.server).host }.getOrDefault(store.server)
        val net = context.getSystemService(ConnectivityManager::class.java)
        val caps = net?.getNetworkCapabilities(net.activeNetwork)
        val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val why = when {
            !online -> context.getString(R.string.fail_offline)
            chain.any { it is UnknownHostException } -> context.getString(R.string.fail_dns, host)
            chain.any { it is SSLException || it is java.security.cert.CertificateException } -> context.getString(R.string.fail_tls)
            chain.any { it is SocketTimeoutException } -> context.getString(R.string.fail_timeout, host)
            chain.any { it is ConnectException } -> context.getString(R.string.fail_reach, host)
            // A proxy's page while the server restarts or is updated: no HTML on screen
            e is ApiException && e.status in 502..504 -> context.getString(R.string.fail_restarting, host)
            e is ApiException -> context.getString(R.string.fail_server, host, "${e.status} ${e.message?.takeUnless { it.trimStart().startsWith("<") } ?: ""}".trim())
            else -> e.message ?: e.javaClass.simpleName
        }
        val utc = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        val transport = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WiFi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
        val details = listOf(
            "Server: ${store.server}",
            "Error: " + chain.joinToString(" <- ") { "${it.javaClass.simpleName}: ${it.message?.replace(Regex("<[^>]*>"), " ")?.replace(Regex("\\s+"), " ")?.trim()?.take(200)}" },
            "Clock (UTC): $utc",
            "Network: $transport${if (online) "" else " (no internet)"}",
            "App: $version",
        ).joinToString("\n")
        return why to details
    }
}
