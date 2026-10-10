package com.rommancer.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

/** A notification when saves from other consoles arrived, so the player knows before starting the game */
object Notices {
    private const val CHANNEL = "received"
    private const val ID = 2

    fun received(context: Context, games: List<String>) {
        if (games.isEmpty()) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.received_channel), NotificationManager.IMPORTANCE_DEFAULT))
        val text = if (games.size == 1) context.getString(R.string.received_one, games[0]) else context.getString(R.string.received_many, games.size, games[0])
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(context)
        val notification = builder
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Rommancer")
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(ID, notification) }
    }
}
