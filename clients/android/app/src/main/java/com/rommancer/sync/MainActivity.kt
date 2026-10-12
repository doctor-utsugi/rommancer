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
import androidx.compose.runtime.produceState
import kotlinx.coroutines.delay
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
    data class Message(val text: String, val details: String? = null) : Screen
    data object Conflicts : Screen
    data class Conflict(val c: SyncEngine.Conflict) : Screen
    data object Status : Screen
    /** The device's lists, each one added or removed with A */
    data object Lists : Screen
    /** Removing a list deletes roms here: said once, with how many, before it is done */
    data class ListDrop(val list: SyncEngine.DeviceList, val keep: List<Int>, val drop: SyncEngine.ListsDrop) : Screen
    /** Deleting roms in no list: "intro" (the choice offered once), "ask" (turned on in the web app), "hold" (a big deletion) */
    data class Prune(val kind: String) : Screen
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
            // When the app was last updated, always in sight under the name
            val updated = remember {
                runCatching {
                    val t = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
                    java.text.SimpleDateFormat("d MMM yyyy, HH:mm", java.util.Locale.getDefault()).format(java.util.Date(t))
                }.getOrNull().orEmpty()
            }
            Text("Rommancer Sync", fontSize = 26.sp, fontWeight = FontWeight.SemiBold, color = Accent)
            if (updated.isNotEmpty()) Text(stringResource(R.string.updated_at, updated), fontSize = 14.sp, color = Dim)
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
            val result = withContext(Dispatchers.IO) {
                runCatching { work(SyncEngine(context, store) { progress = it }) to null }
                    .getOrElse { e -> Failure.describe(context, store, e) }
            }
            screen = Screen.Message(result.first, result.second)
        }
    }

    // Opened while the background downloads the lists' roms: their progress first, on screen until done or stopped
    val titleRomsOpen = stringResource(R.string.sync_roms)
    LaunchedEffect(Unit) { if (SyncEngine.LIVE != null) run(titleRomsOpen) { it.roms() } }

    // What the deletion of roms in no list needs from the user, checked whenever the menu shows
    var holdLater by remember { mutableStateOf(false) }
    LaunchedEffect(screen, settingsTick) {
        if (screen != Screen.Menu) return@LaunchedEffect
        when {
            !store.pruneIntro -> screen = Screen.Prune("intro")
            store.pruneAsk != null -> screen = Screen.Prune("ask")
            store.pruneHold != null && store.pruneRoms && !holdLater -> screen = Screen.Prune("hold")
        }
    }

    // The lists screen: what the server offers, whether a change was made (leaving then syncs at once) and the list
    // the cursor stays on (the device's own lists come first, so a changed one moves)
    var lists by remember { mutableStateOf<SyncEngine.Lists?>(null) }
    var listsError by remember { mutableStateOf<String?>(null) }
    var listsBusy by remember { mutableStateOf(false) }
    var listsChanged by remember { mutableStateOf(false) }
    var listAt by remember { mutableStateOf<Int?>(null) }
    val titleSyncLists = stringResource(R.string.syncing)
    fun loadLists() {
        listsBusy = true
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).lists() } }
            lists = r.getOrNull()
            listsError = r.exceptionOrNull()?.let { Failure.describe(context, store, it).first }
            listsBusy = false
        }
    }
    fun setLists(ids: List<Int>) {
        listsBusy = true
        screen = Screen.Lists
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).listsSet(ids) } }
            if (r.isSuccess) listsChanged = true else listsError = r.exceptionOrNull()?.let { Failure.describe(context, store, it).first }
            loadLists()
        }
    }
    fun toggleList(l: SyncEngine.DeviceList) {
        val current = lists ?: return
        listAt = l.id
        val keep = current.lists.filter { it.on && it.id != l.id }.map { it.id } + (if (l.on) emptyList() else listOf(l.id))
        if (!l.on || !current.prune) return setLists(keep)
        listsBusy = true
        scope.launch {
            val drop = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).listsPreview(keep) } }
            listsBusy = false
            val d = drop.getOrNull()
            when {
                d == null -> listsError = drop.exceptionOrNull()?.let { Failure.describe(context, store, it).first }
                d.files + d.upload > 0 -> screen = Screen.ListDrop(l, keep, d)
                else -> setLists(keep)
            }
        }
    }
    // Leaving the lists after a change brings the device in line with them at once, on screen
    fun leaveLists() {
        if (listsChanged) {
            listsChanged = false
            run(titleSyncLists) { it.all(roms = true) }
        } else screen = Screen.Menu
    }

    // B / back returns to the menu from any inner screen; a running sync is left alone
    BackHandler(enabled = screen != Screen.Menu && screen !is Screen.Working) {
        if (screen == Screen.Prune("hold")) holdLater = true
        when (screen) {
            Screen.Lists -> leaveLists()
            is Screen.ListDrop -> screen = Screen.Lists
            is Screen.Conflict -> screen = Screen.Conflicts
            else -> screen = Screen.Menu
        }
    }

    when (val s = screen) {
        Screen.Menu -> {
            Text(stringResource(R.string.connected, store.server, store.user ?: "?"), color = Dim)
            // The server is fetching roms from this device: shown with its progress while it lasts
            val pull by produceState(SyncEngine.PULL_LIVE) { while (true) { value = SyncEngine.PULL_LIVE; delay(500) } }
            pull?.let { p ->
                Text("${stringResource(R.string.p_pulls)}  ${p.done}/${p.total}", fontSize = 18.sp)
                LinearProgressIndicator(progress = { p.share }, modifier = Modifier.fillMaxWidth().height(10.dp))
                Text("${(p.share * 100).toInt()}%  ·  ${p.detail}  ${(p.fileShare * 100).toInt()}%", color = Dim)
            }
            settingsTick // read so the toggles redraw after a change
            val n = conflicts?.size?.toString() ?: "…"
            val titleSync = stringResource(R.string.syncing)
            val titleRoms = stringResource(R.string.sync_roms)
            val titleUpdate = stringResource(R.string.updating)
            update?.let { u ->
                MenuItem(stringResource(R.string.update_app, u.name)) { run(titleUpdate) { Updater.install(context, store); "" } }
            }
            // Asked on screen: the roms download again even after a stop
            MenuItem(stringResource(R.string.sync_now), firstItem) { run(titleSync) { it.all(roms = true) } }
            MenuItem(titleRoms) { run(titleRoms) { it.roms() } }
            MenuItem(stringResource(R.string.lists)) { lists = null; listsError = null; listAt = null; screen = Screen.Lists; loadLists() }
            MenuItem(stringResource(R.string.watch, if (store.watch) yes else no)) {
                store.watch = !store.watch
                if (store.watch) WatchService.start(context) else WatchService.stop(context)
                settingsTick++
            }
            MenuItem(stringResource(R.string.allow_pull, if (store.allowPull) yes else no)) { store.allowPull = !store.allowPull; settingsTick++ }
            MenuItem(stringResource(R.string.prune, if (store.pruneRoms) yes else no)) { val on = !store.pruneRoms; run(titleSync) { it.pruneSet(on) } }
            val cleanable = remember(settingsTick, screen) { store.pruned.size }
            val titleClean = stringResource(R.string.prune_clean, cleanable)
            MenuItem(titleClean) { run(titleClean) { it.pruneClean() } }
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
            // A download the background started shows its own progress (this pass waits for it)
            val live by produceState(SyncEngine.LIVE) { while (true) { value = SyncEngine.LIVE; delay(500) } }
            val pullLive by produceState(SyncEngine.PULL_LIVE) { while (true) { value = SyncEngine.PULL_LIVE; delay(500) } }
            val progress = if (progress.phase.startsWith("roms") || progress.phase == "connecting") live ?: progress else if (progress.phase == "pulls") pullLive ?: progress else progress
            Text(s.title, fontSize = 22.sp)
            val label = when (progress.phase) {
                "roms" -> stringResource(R.string.p_roms)
                "server" -> stringResource(R.string.p_server)
                "transfer" -> stringResource(R.string.p_transfer)
                "identify" -> stringResource(R.string.p_identify)
                "roms-plan" -> stringResource(R.string.p_roms_plan)
                "roms-download" -> stringResource(R.string.p_roms_download)
                "pulls" -> stringResource(R.string.p_pulls)
                else -> stringResource(R.string.p_connecting)
            }
            Text(if (progress.total > 0) "$label  ${progress.done}/${progress.total}" else label, color = Dim)
            LinearProgressIndicator(progress = { progress.share }, modifier = Modifier.fillMaxWidth().height(10.dp))
            Text("${(progress.share * 100).toInt()}%" + if (progress.detail.isNotBlank()) "  ·  ${progress.detail}  ${(progress.fileShare * 100).toInt()}%" else "", color = Dim)
            if (progress.phase == "roms-download" || progress.phase == "roms-plan") {
                var stopping by remember { mutableStateOf(false) }
                MenuItem(stringResource(if (stopping) R.string.stopping else R.string.roms_stop), firstItem) {
                    stopping = true
                    SyncEngine.stopRoms(store)
                }
                LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
            }
        }
        is Screen.Message -> {
            var open by remember(s) { mutableStateOf(false) }
            Text(s.text, fontSize = 20.sp)
            // A failure offers what is behind it
            if (open && s.details != null) Text(s.details, color = Dim, fontSize = 14.sp)
            MenuItem(stringResource(R.string.press_back), firstItem) { screen = Screen.Menu }
            if (s.details != null && !open) MenuItem(stringResource(R.string.details)) { open = true }
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
        is Screen.Prune -> {
            val title = stringResource(R.string.syncing)
            when (s.kind) {
                "intro" -> {
                    Text(stringResource(R.string.prune_intro), fontSize = 20.sp)
                    MenuItem(stringResource(R.string.prune_no), firstItem) { run(title) { it.pruneSet(false) } }
                    MenuItem(stringResource(R.string.prune_yes)) { run(title) { it.pruneSet(true) } }
                }
                "ask" -> {
                    val (files, bytes) = (store.pruneAsk ?: "0\t0").split('\t').let { it.getOrElse(0) { "0" } to (it.getOrNull(1)?.toLongOrNull() ?: 0L) }
                    Text(stringResource(R.string.prune_ask, files, android.text.format.Formatter.formatShortFileSize(context, bytes)), fontSize = 20.sp)
                    MenuItem(stringResource(R.string.prune_keep), firstItem) { run(title) { it.pruneSet(true) } }
                    MenuItem(stringResource(R.string.prune_off)) { run(title) { it.pruneSet(false) } }
                }
                else -> {
                    val (files, total) = (store.pruneHold ?: "0\t0").split('\t').let { it.getOrElse(0) { "0" } to it.getOrElse(1) { "0" } }
                    Text(stringResource(R.string.prune_hold, files, total), fontSize = 20.sp)
                    val titlePrune = stringResource(R.string.p_prune)
                    MenuItem(stringResource(R.string.prune_delete), firstItem) { run(titlePrune) { it.pruneConfirm() } }
                    MenuItem(stringResource(R.string.prune_off)) { run(title) { it.pruneSet(false) } }
                    MenuItem(stringResource(R.string.prune_later)) { holdLater = true; screen = Screen.Menu }
                }
            }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
        }
        Screen.Lists -> {
            Text(stringResource(R.string.lists), fontSize = 22.sp)
            val current = lists
            val focus = remember { mutableMapOf<Int, FocusRequester>() }
            when {
                listsError != null -> Text(listsError!!, color = MaterialTheme.colorScheme.error)
                current == null -> Text(stringResource(R.string.p_connecting), color = Dim)
                current.lists.isEmpty() -> Text(stringResource(R.string.no_lists), color = Dim)
                else -> Text(stringResource(R.string.lists_info, current.lists.count { it.on }), color = Dim)
            }
            current?.lists?.forEach { l ->
                val label = (if (l.on) "☑ " else "☐ ") + l.name + (if (l.owner.isNotEmpty()) " @${l.owner}" else "") + " (${l.items})"
                MenuItem(label, focus.getOrPut(l.id) { FocusRequester() }) { if (!listsBusy) toggleList(l) }
            }
            MenuItem(stringResource(R.string.press_back), firstItem) { leaveLists() }
            // The cursor goes back to the list just changed, or to the first one
            LaunchedEffect(current) {
                val target = listAt?.let { focus[it] } ?: current?.lists?.firstOrNull()?.let { focus[it.id] } ?: firstItem
                runCatching { target.requestFocus() }
            }
        }
        is Screen.ListDrop -> {
            val d = s.drop
            val size = android.text.format.Formatter.formatShortFileSize(context, d.bytes)
            Text(stringResource(R.string.list_drop, s.list.name, d.files + d.upload, size), fontSize = 20.sp)
            if (d.upload > 0) Text(stringResource(R.string.list_drop_up, d.upload), color = Dim)
            MenuItem(stringResource(R.string.list_drop_go, d.files + d.upload), firstItem) { setLists(s.keep) }
            MenuItem(stringResource(R.string.cancel)) { screen = Screen.Lists }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
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
