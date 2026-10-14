package com.rommancer.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * A sync started from adb, for tests on a device: `adb shell am broadcast -a com.rommancer.sync.SYNC -n
 * com.rommancer.sync/.ShellSync`. Only the shell may send it (it holds DUMP, which apps cannot get)
 */
class ShellSync : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = SyncWorker.now(context)
}
