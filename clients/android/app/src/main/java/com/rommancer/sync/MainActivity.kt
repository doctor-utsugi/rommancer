package com.rommancer.sync

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val Bg = Color(0xFF12141C)
private val Accent = Color(0xFF6EAAFF)
private val Dim = Color(0xFF8C91A0)

class MainActivity : ComponentActivity() {
    // Bumped on resume so the storage permission screen updates after returning from Settings
    private val resumes = mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = Bg)) {
                Surface(Modifier.fillMaxSize(), color = Bg) { App(resumes.intValue) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        resumes.intValue++
    }

    // Gamepads: A selects like the D-pad centre, B goes back
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val mapped = when (event.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A -> KeyEvent.KEYCODE_DPAD_CENTER
            KeyEvent.KEYCODE_BUTTON_B -> KeyEvent.KEYCODE_BACK
            else -> null
        }
        return if (mapped != null) super.dispatchKeyEvent(KeyEvent(event.action, mapped)) else super.dispatchKeyEvent(event)
    }
}

private sealed interface Screen {
    data object Menu : Screen
    data class Working(val title: String) : Screen
    data class Message(val text: String) : Screen
    data object Conflicts : Screen
    data class Conflict(val c: SyncEngine.Conflict) : Screen
    data object Status : Screen
}

@Composable
private fun App(resumes: Int) {
    val context = LocalContext.current
    val store = remember { Store(context) }
    var linked by remember { mutableStateOf(store.linked) }
    val canRead = remember(resumes) { Environment.isExternalStorageManager() }
    // Two columns like the handheld setup app: content on the left, the spinning save point on the right
    Row(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 12.dp)) {
        Column(Modifier.weight(0.6f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            // The installed version, small beside the name
            val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty() }
            Row(verticalAlignment = Alignment.Bottom) {
                Text("Rommancer Sync", fontSize = 26.sp, fontWeight = FontWeight.SemiBold, color = Accent)
                if (version.isNotEmpty()) Text("  v$version", fontSize = 14.sp, color = Dim, modifier = Modifier.padding(bottom = 4.dp))
            }
            when {
                !canRead -> StoragePermission()
                linked -> Linked(store) { linked = false }
                else -> Setup(store) { linked = true }
            }
        }
        Box(Modifier.weight(0.4f).fillMaxHeight(), contentAlignment = Alignment.Center) { SavePoint() }
    }
}

/** Pre-rendered rotation (tools/render_savepoint.py, 120 frames in a 12-column grid) played at 60 fps */
@Composable
private fun SavePoint() {
    val context = LocalContext.current
    val sheet: ImageBitmap = remember { BitmapFactory.decodeResource(context.resources, R.drawable.savepoint).asImageBitmap() }
    var nanos by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) withFrameNanos { nanos = it } }
    val cols = 12
    val frames = 120
    val side = sheet.width / cols
    Canvas(Modifier.fillMaxWidth(0.9f).height(260.dp)) {
        val frame = ((nanos / 16_666_667L) % frames).toInt()
        val target = minOf(size.width, size.height).toInt()
        drawImage(
            sheet,
            srcOffset = IntOffset((frame % cols) * side, (frame / cols) * side),
            srcSize = IntSize(side, side),
            dstOffset = IntOffset(((size.width - target) / 2).toInt(), ((size.height - target) / 2).toInt()),
            dstSize = IntSize(target, target),
        )
    }
}

/** A menu entry that the D-pad can reach and A/Enter can press, outlined when focused */
@Composable
private fun MenuItem(text: String, focus: FocusRequester? = null, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    TextButton(
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
        modifier = Modifier
            .fillMaxWidth()
            .then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
            .onFocusChanged { focused = it.isFocused }
            .border(2.dp, if (focused) Accent else Color.Transparent, RoundedCornerShape(10.dp)),
    ) {
        Text(text, fontSize = 19.sp, color = if (focused) Accent else Color.White, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun StoragePermission() {
    val context = LocalContext.current
    Text(stringResource(R.string.storage_title), fontSize = 20.sp)
    Text(stringResource(R.string.storage_text), color = Dim)
    Button(onClick = {
        context.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}")))
    }) { Text(stringResource(R.string.storage_grant)) }
}

@Composable
private fun Setup(store: Store, onLinked: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(store.server) }
    var signup by remember { mutableStateOf(false) }
    var user by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val msgBadServer = stringResource(R.string.bad_server)
    val msgBadLogin = stringResource(R.string.bad_login)
    val msgClosed = stringResource(R.string.signup_closed)
    val msgExists = stringResource(R.string.exists)

    OutlinedTextField(server, { server = it.trim() }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.server)) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
    OutlinedTextField(user, { user = it.trim() }, Modifier.fillMaxWidth(), singleLine = true,
        label = { Text(stringResource(if (signup) R.string.username else R.string.user)) })
    if (signup) {
        OutlinedTextField(email, { email = it.trim() }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.email)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
    }
    OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.password)) },
        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    Button(enabled = !busy && user.isNotBlank() && password.isNotBlank(), onClick = {
        busy = true
        error = null
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    store.server = server.trimEnd('/')
                    val engine = SyncEngine(context, store)
                    val api = Api(store.server)
                    api.text("/link/info")
                    val fields = engine.deviceHints() + mapOf("username" to user, "password" to password) + (if (signup) mapOf("email" to email) else emptyMap())
                    val resp = api.form(if (signup) "/link/signup" else "/link/login", fields)
                    store.link(resp.getValue("token"), resp["user"] ?: user)
                }
            }
            busy = false
            result.onSuccess {
                SyncWorker.schedule(context)
                onLinked()
            }.onFailure { e ->
                error = when ((e as? ApiException)?.status) {
                    401 -> msgBadLogin
                    403 -> if (e.message?.contains("Sign-up") == true) msgClosed else e.message
                    409 -> msgExists
                    null -> msgBadServer
                    else -> e.message
                }
            }
        }
    }) { Text(stringResource(if (signup) R.string.signup else R.string.login)) }
    TextButton(onClick = { signup = !signup }) { Text(stringResource(if (signup) R.string.have_account else R.string.no_account)) }
}

@Composable
private fun Linked(store: Store, onUnlinked: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var screen by remember { mutableStateOf<Screen>(Screen.Menu) }
    var progress by remember { mutableStateOf(SyncEngine.Progress("connecting")) }
    var conflicts by remember { mutableStateOf<List<SyncEngine.Conflict>?>(null) }
    var settingsTick by remember { mutableIntStateOf(0) }
    val firstItem = remember { FocusRequester() }
    val yes = stringResource(R.string.yes)
    val no = stringResource(R.string.no)

    // The save watcher's notification needs this permission on Android 13+; it runs either way
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        WatchService.start(context)
    }

    // The user's WiFi networks: Android asks to save them in its own dialog
    val wifiDone = stringResource(R.string.wifi_done)
    val wifiNone = stringResource(R.string.wifi_none)
    val wifiCancelled = stringResource(R.string.wifi_cancelled)
    val addWifi = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        screen = Screen.Message(if (r.resultCode == android.app.Activity.RESULT_OK) wifiDone else wifiCancelled)
    }

    // Dolphin's folder, shared once through the system picker (it opens there); a sync follows at once
    val dolphinDone = stringResource(R.string.dolphin_done)
    val dolphinWrong = stringResource(R.string.dolphin_wrong)
    val pickDolphin = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        if (uri.authority != Dolphin.AUTHORITY) {
            screen = Screen.Message(dolphinWrong)
            return@rememberLauncherForActivityResult
        }
        Dolphin(context, store).link(uri)
        settingsTick++
        screen = Screen.Working(dolphinDone)
        scope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching { "$dolphinDone\n" + SyncEngine(context, store) { progress = it }.sync() }.getOrElse { it.message ?: "error" }
            }
            screen = Screen.Message(text)
        }
    }

    // Shizuku starting, stopping or granting its permission redraws its menu entry
    DisposableEffect(Unit) {
        val granted = rikka.shizuku.Shizuku.OnRequestPermissionResultListener { _, _ -> settingsTick++ }
        val alive = rikka.shizuku.Shizuku.OnBinderReceivedListener { settingsTick++ }
        val dead = rikka.shizuku.Shizuku.OnBinderDeadListener { settingsTick++ }
        rikka.shizuku.Shizuku.addRequestPermissionResultListener(granted)
        rikka.shizuku.Shizuku.addBinderReceivedListenerSticky(alive)
        rikka.shizuku.Shizuku.addBinderDeadListener(dead)
        onDispose {
            rikka.shizuku.Shizuku.removeRequestPermissionResultListener(granted)
            rikka.shizuku.Shizuku.removeBinderReceivedListener(alive)
            rikka.shizuku.Shizuku.removeBinderDeadListener(dead)
        }
    }

    // A newer app on the server: offered at the top of the menu
    var update by remember { mutableStateOf<Updater.Available?>(null) }
    LaunchedEffect(Unit) { update = withContext(Dispatchers.IO) { Updater.check(context, store) } }

    // Conflicts are counted in the background so the menu never waits for the network
    LaunchedEffect(screen) {
        if (screen == Screen.Menu) conflicts = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).conflicts() }.getOrNull() }
    }

    fun run(title: String, work: (SyncEngine) -> String) {
        screen = Screen.Working(title)
        scope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching { work(SyncEngine(context, store) { progress = it }) }.getOrElse { it.message ?: "error" }
            }
            screen = Screen.Message(text)
        }
    }

    // B / back returns to the menu from any inner screen; a running sync is left alone
    BackHandler(enabled = screen != Screen.Menu && screen !is Screen.Working) {
        screen = if (screen is Screen.Conflict) Screen.Conflicts else Screen.Menu
    }

    when (val s = screen) {
        Screen.Menu -> {
            Text(stringResource(R.string.connected, store.server, store.user ?: "?"), color = Dim)
            settingsTick // read so the toggles redraw after a change
            val n = conflicts?.size?.toString() ?: "…"
            val titleSync = stringResource(R.string.syncing)
            val titleRoms = stringResource(R.string.sync_roms)
            val titleUpdate = stringResource(R.string.updating)
            update?.let { u ->
                MenuItem(stringResource(R.string.update_app, u.name)) { run(titleUpdate) { Updater.install(context, store); "" } }
            }
            MenuItem(stringResource(R.string.sync_now), firstItem) { run(titleSync) { it.all() } }
            MenuItem(titleRoms) { run(titleRoms) { it.roms() } }
            MenuItem(stringResource(R.string.auto_roms, if (store.autoRoms) yes else no)) { store.autoRoms = !store.autoRoms; settingsTick++ }
            MenuItem(stringResource(R.string.watch, if (store.watch) yes else no)) {
                store.watch = !store.watch
                if (store.watch) WatchService.start(context) else WatchService.stop(context)
                settingsTick++
            }
            MenuItem(stringResource(R.string.allow_pull, if (store.allowPull) yes else no)) { store.allowPull = !store.allowPull; settingsTick++ }
            if (WifiSetup.supported) {
                val titleWifi = stringResource(R.string.add_wifi)
                MenuItem(titleWifi) {
                    screen = Screen.Working(titleWifi)
                    scope.launch {
                        val nets = withContext(Dispatchers.IO) { runCatching { WifiSetup.fetch(context, store) } }
                        val intent = nets.getOrNull()?.let { WifiSetup.intent(it) }
                        when {
                            nets.isFailure -> screen = Screen.Message(nets.exceptionOrNull()?.message ?: "error")
                            intent == null -> screen = Screen.Message(wifiNone)
                            else -> addWifi.launch(intent)
                        }
                    }
                }
            }
            if (Dolphin.installed(context)) {
                val dolphinLinked = remember(settingsTick) { Dolphin(context, store).linked }
                MenuItem(stringResource(if (dolphinLinked) R.string.dolphin_linked else R.string.dolphin_grant)) { pickDolphin.launch(Dolphin.initialUri) }
            }
            val shizuku = remember(settingsTick) { Privileged.state() }
            val titleConfig = stringResource(R.string.applying_config)
            val shizukuHelp = stringResource(R.string.shizuku_help)
            MenuItem(stringResource(when (shizuku) {
                Privileged.State.READY -> R.string.shizuku_ready
                Privileged.State.NOT_ALLOWED -> R.string.shizuku_allow
                Privileged.State.NOT_RUNNING -> R.string.shizuku_off
            })) {
                when (shizuku) {
                    Privileged.State.READY -> run(titleConfig) { e -> context.getString(R.string.config_done, ConfigEngine(context, store).run()) }
                    Privileged.State.NOT_ALLOWED -> { Privileged.request(1); settingsTick++ }
                    Privileged.State.NOT_RUNNING -> screen = Screen.Message(shizukuHelp)
                }
            }
            MenuItem(stringResource(R.string.conflicts, n)) { screen = Screen.Conflicts }
            MenuItem(stringResource(R.string.status)) { screen = Screen.Status }
            MenuItem(stringResource(R.string.unlink)) {
                SyncWorker.cancel(context)
                WatchService.stop(context)
                store.unlink()
                onUnlinked()
            }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.Working -> {
            Text(s.title, fontSize = 22.sp)
            val label = when (progress.phase) {
                "roms" -> stringResource(R.string.p_roms)
                "server" -> stringResource(R.string.p_server)
                "transfer" -> stringResource(R.string.p_transfer)
                "roms-plan" -> stringResource(R.string.p_roms_plan)
                "roms-download" -> stringResource(R.string.p_roms_download)
                "pulls" -> stringResource(R.string.p_pulls)
                else -> stringResource(R.string.p_connecting)
            }
            Text(if (progress.total > 0) "$label  ${progress.done}/${progress.total}" else label, color = Dim)
            LinearProgressIndicator(progress = { progress.share }, modifier = Modifier.fillMaxWidth().height(10.dp))
            Text("${(progress.share * 100).toInt()}%" + if (progress.detail.isNotBlank()) "  ·  ${progress.detail}  ${(progress.fileShare * 100).toInt()}%" else "", color = Dim)
        }
        is Screen.Message -> {
            Text(s.text, fontSize = 20.sp)
            MenuItem(stringResource(R.string.press_back), firstItem) { screen = Screen.Menu }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
        }
        Screen.Conflicts -> {
            val list = conflicts.orEmpty()
            if (list.isEmpty()) Text(stringResource(R.string.no_conflicts), color = Dim)
            list.forEachIndexed { i, c -> MenuItem(c.game, if (i == 0) firstItem else null) { screen = Screen.Conflict(c) } }
            MenuItem(stringResource(R.string.press_back), if (list.isEmpty()) firstItem else null) { screen = Screen.Menu }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.Conflict -> {
            val c = s.c
            Text(stringResource(R.string.conflict_info, c.game, c.mine.take(16).replace('T', ' '), c.theirs.take(16).replace('T', ' '), c.device), color = Dim)
            val title = stringResource(R.string.syncing)
            MenuItem(stringResource(R.string.keep_device), firstItem) { run(title) { e -> "sync: ${e.resolve(c.id, "device")}" } }
            MenuItem(stringResource(R.string.keep_server)) { run(title) { e -> "sync: ${e.resolve(c.id, "server")}" } }
            MenuItem(stringResource(R.string.press_back)) { screen = Screen.Conflicts }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        Screen.Status -> {
            val log = store.log
            if (log.isEmpty()) Text(stringResource(R.string.no_log), color = Dim)
            log.takeLast(10).forEach { Text(it, color = Dim, fontSize = 14.sp) }
            Spacer(Modifier.height(8.dp))
            MenuItem(stringResource(R.string.press_back), firstItem) { screen = Screen.Menu }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
    }
}
