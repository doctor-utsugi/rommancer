package com.rommancer.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.FileObserver
import android.os.IBinder
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Uploads saves and savestates a few seconds after a game writes them, and asks the server every
 * 15 seconds whether the web app wants something (a sync now, roms to send), like the Linux daemon.
 */
class WatchService : Service() {
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var observers: List<FileObserver> = emptyList()
    private var exts: List<String> = emptyList()
    private var pending: ScheduledFuture<*>? = null
    private lateinit var store: Store

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = Store(this)
        startInForeground()
        worker.execute { watch() }
        worker.scheduleWithFixedDelay({ poll() }, POLL_SECONDS, POLL_SECONDS, TimeUnit.SECONDS)
        // New system folders appear when roms arrive: look for them now and then
        worker.scheduleWithFixedDelay({ watch() }, RESCAN_MINUTES, RESCAN_MINUTES, TimeUnit.MINUTES)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!store.linked || !store.watch) stopSelf()
        return START_STICKY
    }

    override fun onDestroy() {
        observers.forEach { it.stopWatching() }
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun engine() = SyncEngine(this, store)

    private fun watch() {
        val (dirs, saveExts) = runCatching { engine().watchTargets() }.getOrElse { return }
        exts = saveExts
        observers.forEach { it.stopWatching() }
        observers = dirs.map { dir -> observer(dir).also { it.startWatching() } }
    }

    @Suppress("DEPRECATION")
    private fun observer(dir: File) = object : FileObserver(dir.path, CLOSE_WRITE or MOVED_TO) {
        override fun onEvent(event: Int, path: String?) {
            if (path != null && engine().isSaveFile(path.lowercase(), exts)) later()
        }
    }

    /** Emulators write a save in several steps: wait until they have been quiet for a few seconds */
    @Synchronized
    private fun later() {
        pending?.cancel(false)
        pending = worker.schedule({ runCatching { engine().sync() } }, QUIET_SECONDS, TimeUnit.SECONDS)
    }

    private var fails = 0
    private var failFirst = 0L
    private var offlineSince = 0L
    private var conflicts = 0
    private val started = System.currentTimeMillis()

    private fun poll() {
        if (!store.linked) return stopSelf()
        val asked = engine().pollOrNull()
        if (asked == null) {
            // Offline once two polls in a row failed, dated from the first; not while the network comes up after start
            if (++fails == 1) failFirst = System.currentTimeMillis()
            if (fails >= 2 && offlineSince == 0L && System.currentTimeMillis() - started > 90_000) {
                offlineSince = failFirst
                showState()
            }
            return
        }
        fails = 0
        val n = asked.firstOrNull { it.startsWith("conflicts\t") }?.substringAfter('\t')?.toIntOrNull() ?: 0
        if (offlineSince != 0L || n != conflicts) {
            offlineSince = 0L
            conflicts = n
            showState()
        }
        if ("sync" in asked) runCatching { engine().sync(); engine().prune() }
        // Another device sent a save this one should have: saves only
        else if ("saves" in asked) runCatching { engine().sync() }
        // Long copies for the server run apart, so saves keep going up meanwhile
        if ("pull" in asked) Thread { runCatching { engine().pulls() } }.start()
    }

    /** The ongoing notification says where the sync stands: fine, offline since when, or saves in conflict */
    private fun stateNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val text = when {
            offlineSince != 0L -> getString(R.string.state_offline, java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(offlineSince)))
            conflicts > 0 -> resources.getQuantityString(R.plurals.state_conflicts, conflicts, conflicts)
            else -> getString(R.string.watch_text)
        }
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(if (offlineSince != 0L || conflicts > 0) android.R.drawable.stat_notify_error else android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.watch_title))
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun showState() {
        runCatching { getSystemService(NotificationManager::class.java).notify(ID, stateNotification()) }
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.watch_channel), NotificationManager.IMPORTANCE_MIN))
        val notification = stateNotification()
        when {
            // A long-running watcher is "special use" on Android 14+; dataSync would be stopped after 6 hours
            Build.VERSION.SDK_INT >= 34 -> startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            Build.VERSION.SDK_INT >= 29 -> startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else -> startForeground(ID, notification)
        }
    }

    companion object {
        private const val CHANNEL = "watch"
        private const val ID = 1
        private const val POLL_SECONDS = 15L
        private const val RESCAN_MINUTES = 10L
        private const val QUIET_SECONDS = 5L

        fun start(context: Context) {
            val store = Store(context)
            if (store.linked && store.watch) context.startForegroundService(Intent(context, WatchService::class.java))
        }

        fun stop(context: Context) = context.stopService(Intent(context, WatchService::class.java))
    }
}

/** Starts the save watcher when the console is switched on */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) WatchService.start(context)
    }
}
