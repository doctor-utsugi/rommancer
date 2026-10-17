package com.rommancer.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * A notification when saves from other consoles arrived, so the player knows before starting the game; another when
 * games or Rommancer's collections changed, which the frontend only sees once it reads its library again
 */
object Notices {
    private const val CHANNEL = "received"
    private const val ID = 2
    private const val FRONTEND_CHANNEL = "frontend"
    private const val FRONTEND_ID = 3

    const val ESDE = "org.es_de.frontend"

    fun installed(context: Context, pkg: String) = runCatching { context.packageManager.getPackageInfo(pkg, 0) }.isSuccess

    /** The frontend here that only sees new games once it reads its library again: "esde", "daijisho" or null */
    fun shownBy(context: Context, root: java.io.File): String? = when {
        java.io.File(root, "ES-DE/settings").isDirectory -> "esde"
        installed(context, "com.magneticchen.daijishou") -> "daijisho"
        else -> null
    }

    /**
     * GAMES new roms, COLLECTIONS whether Rommancer's ES-DE collections changed: told for the frontends here that
     * read them only when they start (ES-DE) or sync (Daijishō)
     */
    fun frontend(context: Context, root: java.io.File, games: Int, collections: Boolean, named: Int = 0) {
        val esde = java.io.File(root, "ES-DE/settings").isDirectory
        val text = when {
            esde && games > 0 -> context.getString(R.string.frontend_esde_games, games)
            esde && collections -> context.getString(R.string.frontend_esde_collections)
            esde && named > 0 -> context.getString(R.string.frontend_esde_names, named)
            games > 0 && installed(context, "com.magneticchen.daijishou") -> context.getString(R.string.frontend_daijisho_games, games)
            else -> return
        }
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(FRONTEND_CHANNEL, context.getString(R.string.frontend_channel), NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, FRONTEND_CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(context)
        val notification = builder
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(context.getString(R.string.app_title))
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(FRONTEND_ID, notification) }
    }

    fun received(context: Context, games: List<String>) {
        if (games.isEmpty()) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.received_channel), NotificationManager.IMPORTANCE_DEFAULT))
        val text = if (games.size == 1) context.getString(R.string.received_one, games[0]) else context.getString(R.string.received_many, games.size, games[0])
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(context)
        val notification = builder
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(context.getString(R.string.app_title))
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(ID, notification) }
    }
}
