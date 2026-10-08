package com.rommancer.sync

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/** The app updates itself from the server it is linked to: the server says its version and serves the APK. */
object Updater {
    data class Available(val code: Long, val name: String)

    private fun installed(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        return if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }

    fun check(context: Context, store: Store): Available? = runCatching {
        val v = Api.pairs(Api(store.server).text("/link/android/version"))
        val code = v["code"]?.toLongOrNull() ?: return null
        if (code > installed(context)) Available(code, v["name"] ?: code.toString()) else null
    }.getOrNull()

    /** Downloads the APK and opens the system installer (Android always asks the user to confirm) */
    fun install(context: Context, store: Store) {
        val file = File(context.cacheDir, "updates/rommancer-sync.apk")
        Api(store.server).download("/link/android/rommancer-sync.apk", emptyMap(), file)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION),
        )
    }
}
