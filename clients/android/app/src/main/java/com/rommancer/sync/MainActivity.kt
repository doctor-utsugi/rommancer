package com.rommancer.sync

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.widget.FrameLayout
import android.os.Environment
import android.provider.Settings
import android.text.format.DateUtils
import android.view.KeyEvent
import android.view.WindowManager
import android.app.Activity
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.runtime.SideEffect
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
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
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
internal val Accent = Color(0xFF6EAAFF)
internal val Dim = Color(0xFF8C91A0)

class MainActivity : ComponentActivity() {
    // Bumped on resume so the storage permission screen updates after returning from Settings
    private val resumes = mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val compose = ComposeView(this).apply {
            setContent {
                MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = Bg)) {
                    Surface(Modifier.fillMaxSize(), color = Bg) { App(resumes.intValue) }
                }
            }
        }
        // A gamepad keyboard (the Thor's RuneBoard) can go on taking the pad's keys once hidden: unless a field is
        // being typed in, they skip the keyboard and come straight to the app
        setContentView(object : FrameLayout(this) {
            override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean =
                if (!typing && (KeyEvent.isGamepadButton(event.keyCode) || event.keyCode in DPAD)) this@MainActivity.dispatchKeyEvent(event)
                else super.dispatchKeyEventPreIme(event)
        }.apply { addView(compose) })
    }

    override fun onResume() {
        super.onResume()
        resumes.intValue++
    }

    // Gamepads: A selects like the D-pad centre, B goes back; the browse screens take X, Y, START, L1 and R1
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode in PAD) {
            if (event.action == KeyEvent.ACTION_DOWN && pad?.invoke(event.keyCode) == true) return true
            val direction = when (event.keyCode) { KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_PAGE_UP -> -1; KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_DOWN -> 1; else -> 0 }
            if (direction != 0) {
                if (event.action == KeyEvent.ACTION_DOWN) MenuPaging.move(direction, window.decorView.height)
                return true
            }
        }
        val mapped = when (event.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A -> KeyEvent.KEYCODE_DPAD_CENTER
            KeyEvent.KEYCODE_BUTTON_B -> KeyEvent.KEYCODE_BACK
            else -> null
        }
        return if (mapped != null) super.dispatchKeyEvent(KeyEvent(event.action, mapped)) else super.dispatchKeyEvent(event)
    }

    companion object {
        private val PAD = setOf(
            KeyEvent.KEYCODE_BUTTON_X, KeyEvent.KEYCODE_BUTTON_Y, KeyEvent.KEYCODE_BUTTON_START, KeyEvent.KEYCODE_BUTTON_L1,
            KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN,
        )

        /** The screen that takes the PAD keys, whatever has the focus (an empty list has none); true when handled */
        var pad: ((Int) -> Boolean)? = null

        /** A text field has the focus: the keyboard gets the keys first */
        var typing = false

        private val DPAD = setOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER,
        )
    }
}

private sealed interface Screen {
    data object Journeys : Screen
    data object Menu : Screen
    data object Settings : Screen
    data class Working(val title: String) : Screen
    /** A download or a copy for the server another pass started, followed live until it ends */
    data class Watch(val title: String, val pulls: Boolean) : Screen
    data class Message(val text: String, val details: String? = null) : Screen
    /** What a sync did: TITLE is the action, the facts come from the summary */
    data class Result(val title: String, val summary: Summary) : Screen
    data object Conflicts : Screen
    data class Conflict(val c: SyncEngine.Conflict) : Screen
    data object Status : Screen
    /** The device's lists, each one added or removed with A */
    data object Lists : Screen
    /** Removing a list deletes roms here: said once, with how many, before it is done */
    data class ListDrop(val list: SyncEngine.DeviceList, val keep: List<Int>, val drop: SyncEngine.ListsDrop) : Screen
    /** Deleting roms in no list: "intro" (the choice offered once), "ask" (turned on in the web app), "hold" (a big deletion) */
    data class Prune(val kind: String) : Screen
    /** Disconnecting the device, always asked first */
    data object Unlink : Screen
    /** The server's games by system, to tick and download */
    data object Browse : Screen
    /** One system's games, or every system's (SYSTEM null) searched; SEARCH opens with the search field focused */
    data class BrowseGames(val system: SyncEngine.BrowseSystem?, val search: Boolean) : Screen
    /** The server's check of the selection before anything is added; FROM is where Back leads */
    data class BrowseReview(val from: Screen) : Screen
    /** The add was refused for want of space: nothing was added */
    data class BrowseNoSpace(val check: SyncEngine.BrowseCheck, val from: Screen) : Screen
    /** Leaving browse with games ticked */
    data object BrowseDiscard : Screen
    /** The selection saved as a new list: its name, the server's SUGGESTION already typed; REVIEW is where Back leads */
    data class BrowseListName(val suggestion: String, val review: BrowseReview) : Screen
    data class BrowseListPick(val review: BrowseReview) : Screen
    /** A selection saved as a list (TEXT says where), with the download it may still offer; PICK the selection saved */
    data class BrowseSaved(val saved: SyncEngine.BrowseSaved, val pick: SyncEngine.BrowsePick, val text: String) : Screen
}

@Composable
private fun App(resumes: Int) {
    val context = LocalContext.current
    val store = remember { Store(context) }
    var linked by remember { mutableStateOf(store.linked) }
    val canRead = remember(resumes) { Environment.isExternalStorageManager() }
    // The browse screens scroll their own lazy lists, which cannot sit inside a verticalScroll
    var ownScroll by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()
    // Two columns like the handheld setup app: content on the left, the spinning save point on the right. Narrow
    // screens (a phone upright) give all the width to the text
    // The browse screens take the whole screen: their lists need the room more than the title and the save point
    val browsing = ownScroll && linked && canRead
    BoxWithConstraints(Modifier.fillMaxSize().padding(horizontal = if (browsing) 12.dp else 20.dp, vertical = if (browsing) 8.dp else 12.dp)) {
        val sprite = when {
            browsing -> 0f
            maxWidth < 560.dp -> 0f
            maxWidth < 840.dp -> 0.3f
            else -> 0.4f
        }
        Row(Modifier.fillMaxSize()) {
            val scrolls = !browsing
            Column(Modifier.weight(1f - sprite).fillMaxHeight().then(if (scrolls) Modifier.verticalScroll(scroll) else Modifier), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty() }
                if (!browsing) Row(verticalAlignment = Alignment.Bottom) {
                    Text(stringResource(R.string.app_title), fontSize = 26.sp, fontWeight = FontWeight.SemiBold, color = Accent)
                    Text("  $version", fontSize = 14.sp, color = Dim, modifier = Modifier.padding(bottom = 4.dp))
                }
                if (!browsing && scroll.maxValue > 0) Text("L / R · Change page", fontSize = 12.sp, color = Dim)
                when {
                    !canRead -> StoragePermission()
                    linked -> Linked(store, !scrolls, { ownScroll = it }) { linked = false }
                    else -> Setup(store) { linked = true }
                }
            }
            if (sprite > 0f) Box(Modifier.weight(sprite).fillMaxHeight(), contentAlignment = Alignment.Center) { SavePoint() }
        }
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

/**
 * A menu entry that the D-pad can reach and A/Enter can press, outlined when focused; SUB says in one smaller,
 * dimmed line what it does
 */
@Composable
internal fun MenuItem(text: String, focus: FocusRequester? = null, sub: String? = null, color: Color = Color.White, alert: Boolean = false, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val requester = focus ?: remember { FocusRequester() }
    val pageRow = remember(requester) { MenuPaging.Row(requester) }
    DisposableEffect(pageRow) { MenuPaging.rows.add(pageRow); onDispose { MenuPaging.rows.remove(pageRow) } }
    TextButton(
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .then(if (alert) Modifier.background(color.copy(alpha = 0.18f), RoundedCornerShape(10.dp)) else Modifier)
            .focusRequester(requester)
            .onGloballyPositioned { pageRow.y = it.positionInRoot().y }
            .onFocusChanged { focused = it.isFocused; pageRow.focused = it.isFocused }
            .border(2.dp, if (focused) Accent else Color.Transparent, RoundedCornerShape(10.dp)),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Text(text, fontSize = 19.sp, color = if (focused) Accent else color)
            if (sub != null) Text(sub, fontSize = 14.sp, color = Dim, lineHeight = 18.sp)
        }
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

    OutlinedTextField(server, { server = it.trim() }, Modifier.fillMaxWidth().typing(), label = { Text(stringResource(R.string.server)) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
    OutlinedTextField(user, { user = it.trim() }, Modifier.fillMaxWidth().typing(), singleLine = true,
        label = { Text(stringResource(if (signup) R.string.username else R.string.user)) })
    if (signup) {
        OutlinedTextField(email, { email = it.trim() }, Modifier.fillMaxWidth().typing(), singleLine = true, label = { Text(stringResource(R.string.email)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
    }
    OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth().typing(), singleLine = true, label = { Text(stringResource(R.string.password)) },
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

internal val Warn = Color(0xFFFFB454)

/** "Synced: today, 18:52", "Synced: yesterday, 09:10", "Synced: 3 Oct, 18:52" or "Not synced yet" */
private fun syncedText(context: android.content.Context, at: Long): String {
    if (at == 0L) return context.getString(R.string.never_synced)
    val time = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(at))
    return when {
        DateUtils.isToday(at) -> context.getString(R.string.synced_today, time)
        DateUtils.isToday(at + DateUtils.DAY_IN_MILLIS) -> context.getString(R.string.synced_yesterday, time)
        else -> context.getString(R.string.synced_at, java.text.SimpleDateFormat("d MMM", java.util.Locale.ENGLISH).format(java.util.Date(at)) + ", " + time)
    }
}

/** This field takes the keys before the app does while it has the focus (see MainActivity.typing) */
internal fun Modifier.typing() = onFocusChanged { MainActivity.typing = it.isFocused }

internal fun size(context: android.content.Context, bytes: Long) = android.text.format.Formatter.formatShortFileSize(context, bytes)

/** One fact per line, as Summary.lines gives them */
@Composable
private fun SummaryLines(summary: Summary) {
    val context = LocalContext.current
    val lines = remember(summary) { summary.lines(context) }
    lines.forEach { line ->
        val warn = line.startsWith("⚠")
        Text(line, fontSize = 18.sp, color = if (warn) Warn else Color.White)
    }
}

/** Step of a full sync, what it does now with its count, the bar and the current file with its share and size */
@Composable
private fun ProgressLines(p: SyncEngine.Progress) {
    val context = LocalContext.current
    if (p.steps > 0) {
        val stage = stringResource(when (p.stage) {
            "saves" -> R.string.stage_saves
            "config" -> R.string.stage_config
            "prune" -> R.string.stage_prune
            "roms" -> R.string.stage_roms
            else -> R.string.stage_pulls
        })
        Text(stringResource(R.string.step, p.step, p.steps, stage), fontSize = 18.sp, color = Accent)
    }
    val label = stringResource(when (p.phase) {
        "roms" -> R.string.p_roms
        "server" -> R.string.p_server
        "transfer" -> R.string.p_transfer
        "identify" -> R.string.p_identify
        "config" -> R.string.p_config
        "prune" -> R.string.p_prune
        "roms-plan" -> R.string.p_roms_plan
        "roms-download" -> R.string.p_roms_download
        "pulls" -> R.string.p_pulls
        else -> R.string.p_connecting
    })
    Text(if (p.total > 0) "$label  ${p.done}/${p.total}" else label, fontSize = 17.sp)
    Row(verticalAlignment = Alignment.CenterVertically) {
        LinearProgressIndicator(progress = { p.share }, modifier = Modifier.weight(1f).height(10.dp))
        Text("  ${(p.share * 100).toInt()}%", color = Dim)
    }
    if (p.detail.isNotBlank()) {
        Text(p.detail, color = Dim, fontSize = 15.sp, maxLines = 2)
        val pct = (p.fileShare * 100).toInt()
        Text(if (p.fileBytes > 0) stringResource(R.string.file_share, pct, size(context, p.fileBytes)) else "$pct%", color = Dim, fontSize = 15.sp)
    }
}

@Composable
private fun Linked(store: Store, ownScroll: Boolean, setOwnScroll: (Boolean) -> Unit, onUnlinked: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var screen by remember { mutableStateOf<Screen>(Screen.Menu) }
    // Where Back leads from a result: the settings when the action was started there
    var back by remember { mutableStateOf<Screen>(Screen.Menu) }
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

    fun from() = if (screen == Screen.Settings) Screen.Settings else Screen.Menu

    fun run(title: String, work: (SyncEngine) -> Summary) {
        back = from()
        progress = SyncEngine.Progress("connecting")
        screen = Screen.Working(title)
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { work(SyncEngine(context, store) { progress = it }) }
            }
            // A sync the user started that ends with saves in conflict goes straight to choosing; Back means later
            val found = result.getOrNull()?.let {
                withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).conflicts() }.getOrNull() }
            }
            if (found != null) conflicts = found
            screen = result.fold(
                { found?.firstOrNull()?.takeIf { _ -> result.getOrNull()?.conflicts?.let { it > 0 } == true }?.let { c -> Screen.Conflict(c) } ?: Screen.Result(title, it) },
                { e -> Failure.describe(context, store, e).let { (why, details) -> Screen.Message(why, details) } },
            )
        }
    }

    /** Work whose outcome is a sentence, not a sync */
    fun runText(title: String, work: () -> String) {
        back = from()
        progress = SyncEngine.Progress("connecting")
        screen = Screen.Working(title)
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { work() to null }.getOrElse { e -> Failure.describe(context, store, e) }
            }
            screen = Screen.Message(result.first, result.second)
        }
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
        run(dolphinDone) { it.sync() }
    }

    // Shizuku starting, stopping or granting its permission redraws its settings entry
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

    // A newer app on the server: offered at the top of the menu; asked again every hour, as the app may stay open for days
    var update by remember { mutableStateOf<Updater.Available?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            withContext(Dispatchers.IO) { Updater.check(context, store) }?.let { update = it }
            delay(3_600_000)
        }
    }

    // Conflicts are counted in the background so the menu never waits for the network
    LaunchedEffect(screen) {
        if (screen == Screen.Menu) conflicts = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).conflicts() }.getOrNull() }
    }

    // A rom download or a copy for the server under way, whoever started it
    val live by produceState(SyncEngine.LIVE) { while (true) { value = SyncEngine.LIVE; delay(500) } }
    val pullLive by produceState(SyncEngine.PULL_LIVE) { while (true) { value = SyncEngine.PULL_LIVE; delay(500) } }

    // Opened while a download of the lists' roms goes on: its progress first, on screen until done or stopped
    val titleWatchRoms = stringResource(R.string.watch_download)
    val titleWatchPulls = stringResource(R.string.watch_pulls)
    LaunchedEffect(Unit) { if (SyncEngine.LIVE != null) screen = Screen.Watch(titleWatchRoms, pulls = false) }

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
    val titleSync = stringResource(R.string.sync_now)
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
            run(titleSync) { it.all(roms = true) }
        } else screen = Screen.Menu
    }

    // Browsing the server's games: the systems, the selection (kept while moving between the screens), the search
    // text, the server's check, and whether the account was refused (the home item then goes)
    var browseSystems by remember { mutableStateOf<List<SyncEngine.BrowseSystem>?>(null) }
    var browseFailure by remember { mutableStateOf<Pair<String, String>?>(null) }
    var browseDenied by remember { mutableStateOf(false) }
    var browsePick by remember { mutableStateOf(SyncEngine.BrowsePick()) }
    var browseText by remember { mutableStateOf("") }
    // The games already on this device stay out of the lists unless asked for
    var browseShowAll by remember { mutableStateOf(false) }
    var browseAt by remember { mutableIntStateOf(0) }
    var browseChecked by remember { mutableStateOf<SyncEngine.BrowseCheck?>(null) }
    var browseCheckFailure by remember { mutableStateOf<Pair<String, String>?>(null) }
    val titleBrowseGet = stringResource(R.string.browse_review_title)
    fun browseFailed(e: Throwable): Pair<String, String>? {
        if (e is SyncEngine.BrowseDenied) { browseDenied = true; return null }
        return Failure.describe(context, store, e)
    }
    fun openBrowse() {
        browseSystems = null
        browseFailure = null
        browseAt = 0
        screen = Screen.Browse
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseSystems() } }
            browseSystems = r.getOrNull()
            browseFailure = r.exceptionOrNull()?.let { browseFailed(it) }
        }
    }
    fun browseReview(from: Screen) {
        browseChecked = null
        browseCheckFailure = null
        // Back from the review returns to the list, without the keyboard popping up again
        val back = if (from is Screen.BrowseGames) from.copy(search = false) else from
        screen = Screen.BrowseReview(back)
        val pick = browsePick
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseCheck(pick) } }
            browseChecked = r.getOrNull()
            browseCheckFailure = r.exceptionOrNull()?.let { browseFailed(it) }
            if (browseDenied) screen = Screen.Browse
        }
    }
    // Added only when it fits; then the download and an inventory pass, on the progress screen
    fun browseGet(from: Screen) {
        back = Screen.Browse
        progress = SyncEngine.Progress("connecting")
        screen = Screen.Working(titleBrowseGet)
        val pick = browsePick
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseAdd(pick) } }
            val c = r.getOrNull()
            when {
                c == null -> {
                    val failed = browseFailed(r.exceptionOrNull()!!)
                    screen = failed?.let { (why, details) -> Screen.Message(why, details) } ?: Screen.Browse
                }
                c.nospace || c.added == null -> screen = Screen.BrowseNoSpace(c, from)
                else -> {
                    browsePick = SyncEngine.BrowsePick()
                    run(titleBrowseGet) { it.browseGet() }
                }
            }
        }
    }
    var browseLists by remember { mutableStateOf<List<SyncEngine.BrowseList>?>(null) }
    var browseListsFailure by remember { mutableStateOf<Pair<String, String>?>(null) }
    val titleBrowseSave = stringResource(R.string.browse_saving)
    fun browseListPick(review: Screen.BrowseReview) {
        browseLists = null
        browseListsFailure = null
        screen = Screen.BrowseListPick(review)
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseLists() } }
            browseLists = r.getOrNull()
            browseListsFailure = r.exceptionOrNull()?.let { browseFailed(it) }
            if (browseDenied) screen = Screen.Browse
        }
    }
    fun browseSave(from: Screen, name: String? = null, list: Int? = null, assign: Boolean = false, pick: SyncEngine.BrowsePick = browsePick) {
        progress = SyncEngine.Progress("connecting")
        screen = Screen.Working(titleBrowseSave)
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseList(pick, name, list, assign) } }
            val saved = r.getOrNull()
            back = from
            when {
                saved == null -> {
                    val failed = browseFailed(r.exceptionOrNull()!!)
                    screen = failed?.let { (why, details) -> Screen.Message(why, details) } ?: Screen.Browse
                }
                saved.refused == "nospace" -> screen = Screen.BrowseNoSpace(saved.check, if (from is Screen.BrowseReview) from.from else from)
                saved.refused != null -> screen = Screen.Message(context.getString(when (saved.refused) {
                    "nolists" -> R.string.browse_saved_nolists
                    "empty" -> R.string.browse_saved_empty
                    else -> R.string.browse_saved_nolist
                }))
                else -> {
                    browsePick = SyncEngine.BrowsePick()
                    val text = if (saved.added < saved.games) context.getString(R.string.browse_saved_new, saved.name, saved.added)
                    else context.resources.getQuantityString(R.plurals.browse_saved, saved.games, saved.name, saved.games)
                    if (saved.onDevice && saved.check.needGames > 0) run(text) { it.browseGet() }
                    else screen = Screen.BrowseSaved(saved, pick, text)
                }
            }
        }
    }
    fun leaveBrowse() {
        screen = if (browsePick.isEmpty) Screen.Menu else Screen.BrowseDiscard
    }
    val browsing = screen == Screen.Browse || screen is Screen.BrowseGames || screen is Screen.BrowseListPick || screen == Screen.Journeys
    SideEffect { if (browsing != ownScroll) setOwnScroll(browsing) }

    fun unlink() {
        SyncWorker.cancel(context)
        WatchService.stop(context)
        store.unlink()
        onUnlinked()
    }

    // B / back returns from any inner screen; a running sync is left alone. On the deletion prompts it is the safe
    // answer: leave the deletion off (intro), turn it off (ask), not now (hold), so the prompt does not come back at once
    val titlePrune = stringResource(R.string.prune_title)
    // The screen stays on while a sync shows its progress (the work itself keeps the device awake when it goes off)
    val working = screen is Screen.Working || screen is Screen.Watch
    DisposableEffect(working) {
        val window = (context as? Activity)?.window
        if (working) window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    BackHandler(enabled = screen != Screen.Menu && screen !is Screen.Working) {
        when (val s = screen) {
            Screen.Lists -> leaveLists()
            is Screen.ListDrop -> screen = Screen.Lists
            is Screen.Conflict -> screen = Screen.Conflicts
            Screen.Unlink -> screen = Screen.Settings
            Screen.Browse -> leaveBrowse()
            is Screen.BrowseGames, Screen.BrowseDiscard -> screen = Screen.Browse
            is Screen.BrowseReview -> screen = s.from
            is Screen.BrowseNoSpace -> screen = s.from
            is Screen.BrowseListName -> screen = s.review
            is Screen.BrowseListPick -> screen = s.review
            is Screen.BrowseSaved -> screen = Screen.Browse
            is Screen.Message, is Screen.Result -> screen = back
            is Screen.Prune -> when (s.kind) {
                "intro", "ask" -> run(titlePrune) { it.pruneSet(false) }
                else -> { holdLater = true; screen = Screen.Menu }
            }
            else -> screen = Screen.Menu
        }
    }

    when (val s = screen) {
        Screen.Journeys -> JourneysScreen(store) { screen = Screen.Menu }
        Screen.Menu -> {
            // The state, the most urgent first: saves in conflict, no server since when, when it last synced
            val n = conflicts?.size ?: WatchService.conflicts
            val offline by produceState(WatchService.offlineSince) { while (true) { value = WatchService.offlineSince; delay(2_000) } }
            val syncedAt by produceState(store.lastSyncAt) { while (true) { value = store.lastSyncAt; delay(2_000) } }
            when {
                n > 0 -> Text(context.resources.getQuantityString(R.plurals.sum_conflicts, n, n), fontSize = 16.sp, color = Warn)
                offline > 0 -> Text(stringResource(R.string.home_offline, java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(offline))), fontSize = 16.sp, color = Warn)
                else -> Text(syncedText(context, syncedAt), fontSize = 16.sp, color = Dim)
            }
            // Live work, only while it runs
            live?.takeIf { it.phase == "roms-download" }?.let { Text(stringResource(R.string.live_download, it.done, it.total), fontSize = 16.sp, color = Accent) }
            pullLive?.let { Text(stringResource(R.string.live_pulls, it.done, it.total), fontSize = 16.sp, color = Accent) }
            Spacer(Modifier.height(4.dp))

            val titleUpdate = stringResource(R.string.updating)
            update?.let { u ->
                MenuItem(stringResource(R.string.update_app, u.name)) { runText(titleUpdate) { Updater.install(context, store); "" } }
            }
            // Saves in conflict come first, one tap from choosing: straight to the save when there is one
            if (n > 0) MenuItem(stringResource(R.string.conflicts, n), firstItem, color = Warn, alert = true) {
                screen = conflicts?.singleOrNull()?.let { Screen.Conflict(it) } ?: Screen.Conflicts
            }
            // Asked on screen: the roms download again even after a stop
            MenuItem(titleSync, if (n > 0) null else firstItem) { run(titleSync) { it.all(roms = true) } }
            if (live != null) MenuItem(titleWatchRoms) { screen = Screen.Watch(titleWatchRoms, pulls = false) }
            if (pullLive != null) MenuItem(titleWatchPulls) { screen = Screen.Watch(titleWatchPulls, pulls = true) }
            MenuItem(stringResource(R.string.lists)) { lists = null; listsError = null; listAt = null; screen = Screen.Lists; loadLists() }
            val journeyState by produceState<String?>(null) { while (true) { value = withContext(Dispatchers.IO) { runCatching { Journeys(context, store).status() }.getOrNull() }; delay(5_000) } }
            MenuItem("Journeys", sub = journeyState ?: "Save slots for each game", alert = journeyState != null) { screen = Screen.Journeys }
            if (!browseDenied) MenuItem(stringResource(R.string.browse)) { openBrowse() }
            MenuItem(stringResource(R.string.settings)) { screen = Screen.Settings }
            MenuItem(stringResource(R.string.status)) { screen = Screen.Status }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        Screen.Settings -> {
            settingsTick // read so the toggles redraw after a change
            Text(stringResource(R.string.settings), fontSize = 22.sp)
            MenuItem(stringResource(R.string.set_watch, if (store.watch) yes else no), firstItem, sub = stringResource(R.string.set_watch_sub)) {
                store.watch = !store.watch
                if (store.watch) WatchService.start(context) else WatchService.stop(context)
                settingsTick++
            }
            MenuItem(stringResource(R.string.set_game_note, if (store.gameNote) yes else no), sub = stringResource(R.string.set_game_note_sub)) {
                store.gameNote = !store.gameNote
                settingsTick++
            }
            MenuItem(stringResource(R.string.set_game_up_note, if (store.gameUpNote) yes else no), sub = stringResource(R.string.set_game_up_note_sub)) {
                store.gameUpNote = !store.gameUpNote
                settingsTick++
            }
            MenuItem(stringResource(R.string.set_pull, if (store.allowPull) yes else no), sub = stringResource(R.string.set_pull_sub)) {
                store.allowPull = !store.allowPull
                settingsTick++
            }
            MenuItem(stringResource(R.string.set_prune, if (store.pruneRoms) yes else no), sub = stringResource(R.string.set_prune_sub)) {
                val on = !store.pruneRoms
                run(titlePrune) { it.pruneSet(on) }
            }
            val cleanable = remember(settingsTick, screen) { store.pruned.size }
            val titleClean = stringResource(R.string.set_clean, cleanable)
            MenuItem(titleClean, sub = stringResource(R.string.set_clean_sub)) { run(titleClean) { it.pruneClean() } }
            if (WifiSetup.supported) {
                val titleWifi = stringResource(R.string.set_wifi)
                MenuItem(titleWifi, sub = stringResource(R.string.set_wifi_sub)) {
                    back = Screen.Settings
                    screen = Screen.Working(titleWifi)
                    scope.launch {
                        val nets = withContext(Dispatchers.IO) { runCatching { WifiSetup.fetch(context, store) } }
                        val intent = nets.getOrNull()?.let { WifiSetup.intent(it) }
                        when {
                            nets.isFailure -> screen = Failure.describe(context, store, nets.exceptionOrNull()!!).let { (why, details) -> Screen.Message(why, details) }
                            intent == null -> screen = Screen.Message(wifiNone)
                            else -> addWifi.launch(intent)
                        }
                    }
                }
            }
            if (Dolphin.installed(context)) {
                val dolphinLinked = remember(settingsTick) { Dolphin(context, store).linked }
                MenuItem(stringResource(if (dolphinLinked) R.string.dolphin_linked else R.string.dolphin_grant), sub = stringResource(R.string.dolphin_sub)) {
                    back = Screen.Settings
                    pickDolphin.launch(Dolphin.initialUri)
                }
            }
            val usage = remember(settingsTick, screen) { Foreground.allowed(context) }
            MenuItem(stringResource(if (usage) R.string.usage_on else R.string.usage_off), sub = stringResource(R.string.usage_sub)) {
                runCatching { context.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:${context.packageName}"))) }
                    .onFailure { context.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }
                settingsTick++
            }
            val shizuku = remember(settingsTick) { Privileged.state() }
            val titleConfig = stringResource(R.string.applying_config)
            val shizukuHelp = stringResource(R.string.shizuku_help)
            MenuItem(stringResource(when (shizuku) {
                Privileged.State.READY -> R.string.shizuku_ready
                Privileged.State.NOT_ALLOWED -> R.string.shizuku_allow
                Privileged.State.NOT_RUNNING -> R.string.shizuku_off
            }), sub = stringResource(R.string.shizuku_sub)) {
                when (shizuku) {
                    Privileged.State.READY -> runText(titleConfig) { context.getString(R.string.config_done, ConfigEngine(context, store).run()) }
                    Privileged.State.NOT_ALLOWED -> { Privileged.request(1); settingsTick++ }
                    Privileged.State.NOT_RUNNING -> { back = Screen.Settings; screen = Screen.Message(shizukuHelp) }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(stringResource(R.string.account, store.user ?: "?", store.server), color = Dim, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 14.dp))
            MenuItem(stringResource(R.string.unlink)) { screen = Screen.Unlink }
            MenuItem(stringResource(R.string.press_back)) { screen = Screen.Menu }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        Screen.Unlink -> {
            Text(stringResource(R.string.unlink_confirm, store.server), fontSize = 20.sp)
            MenuItem(stringResource(R.string.cancel), firstItem) { screen = Screen.Settings }
            MenuItem(stringResource(R.string.unlink_go), color = Warn) { unlink() }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.Working -> {
            // A download or copy another pass started shows its own progress while this one waits for it
            val p = progress
            val shown = when {
                p.stage in listOf("", "roms") && (p.phase.startsWith("roms") || p.phase == "connecting") && live != null ->
                    live!!.copy(step = p.step, steps = p.steps, stage = p.stage)
                p.phase == "pulls" && pullLive != null -> pullLive!!.copy(step = p.step, steps = p.steps, stage = p.stage)
                else -> p
            }
            Text(s.title, fontSize = 22.sp)
            ProgressLines(shown)
            if (shown.phase == "roms-download" || shown.phase == "roms-plan") {
                var stopping by remember { mutableStateOf(false) }
                MenuItem(stringResource(if (stopping) R.string.stopping else R.string.roms_stop), firstItem) {
                    stopping = true
                    SyncEngine.stopRoms(store)
                }
                LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
            }
        }
        is Screen.Watch -> {
            Text(s.title, fontSize = 22.sp)
            val p = if (s.pulls) pullLive else live
            val started = remember(s) { System.currentTimeMillis() }
            if (p != null) ProgressLines(p) else Text(stringResource(R.string.p_connecting), color = Dim)
            if (!s.pulls && p != null) {
                var stopping by remember { mutableStateOf(false) }
                MenuItem(stringResource(if (stopping) R.string.stopping else R.string.roms_stop), firstItem) {
                    stopping = true
                    SyncEngine.stopRoms(store)
                }
            }
            MenuItem(stringResource(R.string.press_back), if (s.pulls) firstItem else null) { screen = Screen.Menu }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
            // Done: what the pass did, once it has written it down; the menu otherwise
            LaunchedEffect(p == null) {
                if (p != null) return@LaunchedEffect
                delay(1_500)
                screen = if (store.lastSummaryAt >= started) Screen.Result(s.title, Summary.decode(store.lastSummary)) else Screen.Menu
            }
        }
        is Screen.Result -> {
            var open by remember(s) { mutableStateOf(false) }
            Text(s.title, fontSize = 22.sp)
            SummaryLines(s.summary)
            if (open) s.summary.details.takeLast(20).forEach { Text(it, color = Dim, fontSize = 14.sp) }
            MenuItem(stringResource(R.string.press_back), firstItem) { screen = back }
            // ES-DE reads its games when it starts: with Shizuku it is restarted from here
            val restart = remember(s) {
                s.summary.gamesShow == "esde" && s.summary.gamesDown > 0 && Privileged.state() == Privileged.State.READY && Notices.installed(context, Notices.ESDE)
            }
            if (restart) MenuItem(stringResource(R.string.restart_esde)) {
                scope.launch {
                    withContext(Dispatchers.IO) { Privileged.forceStop(Notices.ESDE) }
                    context.packageManager.getLaunchIntentForPackage(Notices.ESDE)?.let { runCatching { context.startActivity(it) } }
                }
            }
            if (s.summary.errors > 0 && s.summary.details.isNotEmpty() && !open) MenuItem(stringResource(R.string.details)) { open = true }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.Message -> {
            var open by remember(s) { mutableStateOf(false) }
            Text(s.text, fontSize = 20.sp)
            // A failure offers what is behind it
            if (open && s.details != null) Text(s.details, color = Dim, fontSize = 14.sp)
            MenuItem(stringResource(R.string.press_back), firstItem) { screen = back }
            if (s.details != null && !open) MenuItem(stringResource(R.string.details)) { open = true }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
        }
        Screen.Conflicts -> {
            val list = conflicts.orEmpty()
            if (list.isEmpty()) Text(stringResource(R.string.no_conflicts), color = Dim)
            list.forEachIndexed { i, c -> MenuItem(c.game, if (i == 0) firstItem else null) { screen = Screen.Conflict(c) } }
            MenuItem(stringResource(if (list.isEmpty()) R.string.press_back else R.string.conflicts_later), if (list.isEmpty()) firstItem else null) { screen = Screen.Menu }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.Conflict -> {
            val c = s.c
            // Both saves side by side, the newer first (and selected): where and when each was made
            val here = Triple("device", stringResource(R.string.this_device), c.mine)
            val there = Triple("server", c.device, c.theirs)
            val cards = if (c.newer == "device") listOf(here, there) else listOf(there, here)
            Text(stringResource(R.string.save_conflict), color = Warn, fontSize = 13.sp, letterSpacing = 0.6.sp)
            Text(c.game, fontSize = 20.sp)
            Text(stringResource(if (c.kind == "STATE") R.string.kind_state else R.string.kind_save), color = Dim, fontSize = 14.sp)
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                cards.forEachIndexed { i, (_, who, at) ->
                    Column(
                        Modifier.weight(1f)
                            .border(2.dp, if (i == 0) Accent else Dim.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
                            .padding(12.dp),
                    ) {
                        Text(stringResource(if (i == 0) R.string.newer else R.string.older), color = if (i == 0) Accent else Dim, fontSize = 12.sp, letterSpacing = 0.6.sp)
                        Text(who, fontSize = 15.sp, maxLines = 1)
                        Text(at, fontSize = 20.sp)
                        if (c.zone.isNotEmpty()) Text(c.zone, color = Dim, fontSize = 12.sp)
                    }
                }
            }
            if (c.since.isNotEmpty()) Text(stringResource(R.string.conflict_since, c.since), color = Dim, fontSize = 14.sp)
            Text(stringResource(R.string.conflict_history), color = Dim, fontSize = 14.sp)
            cards.forEachIndexed { i, (side, who, at) ->
                // The time alone only for today: two saves days or years apart must not read alike
                val label = stringResource(R.string.keep_one, if (side == "device") stringResource(R.string.this_device_short) else who, at.removePrefix("Today "))
                MenuItem(label, if (i == 0) firstItem else null) { run(label) { e -> e.resolve(c.id, side) } }
            }
            MenuItem(stringResource(R.string.press_back)) { screen = Screen.Conflicts }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.Prune -> {
            when (s.kind) {
                "intro" -> {
                    Text(stringResource(R.string.prune_intro), fontSize = 20.sp)
                    MenuItem(stringResource(R.string.prune_no), firstItem) { run(titlePrune) { it.pruneSet(false) } }
                    MenuItem(stringResource(R.string.prune_yes)) { run(titlePrune) { it.pruneSet(true) } }
                }
                "ask" -> {
                    val (files, bytes) = (store.pruneAsk ?: "0\t0").split('\t').let { it.getOrElse(0) { "0" } to (it.getOrNull(1)?.toLongOrNull() ?: 0L) }
                    Text(stringResource(R.string.prune_ask, files, size(context, bytes)), fontSize = 20.sp)
                    MenuItem(stringResource(R.string.prune_keep), firstItem) { run(titlePrune) { it.pruneSet(true) } }
                    MenuItem(stringResource(R.string.prune_off)) { run(titlePrune) { it.pruneSet(false) } }
                }
                else -> {
                    val (files, total) = (store.pruneHold ?: "0\t0").split('\t').let { it.getOrElse(0) { "0" } to it.getOrElse(1) { "0" } }
                    Text(stringResource(R.string.prune_hold, files, total), fontSize = 20.sp)
                    MenuItem(stringResource(R.string.prune_delete), firstItem) { run(titlePrune) { it.pruneConfirm() } }
                    MenuItem(stringResource(R.string.prune_off)) { run(titlePrune) { it.pruneSet(false) } }
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
            // Downloads what the lists hold and is missing here; never deletes anything
            val titleDownload = stringResource(R.string.lists_download)
            MenuItem(titleDownload, sub = stringResource(R.string.lists_download_sub)) {
                listsChanged = false
                run(titleDownload) { it.roms() }
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
            Text(stringResource(R.string.list_drop, s.list.name, d.files + d.upload, size(context, d.bytes)), fontSize = 20.sp)
            if (d.upload > 0) Text(stringResource(R.string.list_drop_up, d.upload), color = Dim)
            MenuItem(stringResource(R.string.list_drop_go, d.files + d.upload), firstItem) { setLists(s.keep) }
            MenuItem(stringResource(R.string.cancel)) { screen = Screen.Lists }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
        }
        // Drawn once the root stopped scrolling (the frame before, it still does)
        Screen.Browse -> if (ownScroll) BrowseSystems(
            browseSystems, browseFailure, browseDenied, browsePick, browseAt, browseShowAll, { browseShowAll = !browseShowAll }, { leaveBrowse() },
            onOpen = { system, at -> browseText = ""; browseAt = at; screen = Screen.BrowseGames(system, search = false) },
            onSearch = { browseText = ""; browseAt = 0; screen = Screen.BrowseGames(null, search = true) },
            onTick = { browsePick = browsePick.toggle(it) },
            onReview = { browseReview(Screen.Browse) },
        )
        is Screen.BrowseGames -> if (ownScroll) BrowseGames(
            store, s.system, s.search, browseSystems.orEmpty(), browseText, { browseText = it }, browsePick, browseShowAll, { browseShowAll = !browseShowAll },
            { screen = Screen.Browse },
            onToggle = { browsePick = browsePick.toggle(it) },
            onReview = { browseReview(s) },
            onDenied = { browseDenied = true; screen = Screen.Browse },
        )
        is Screen.BrowseReview -> {
            Text(stringResource(R.string.browse_review_title), fontSize = 22.sp)
            val c = browseChecked
            val ok = when {
                browseCheckFailure != null -> {
                    Text(stringResource(R.string.browse_unreachable), fontSize = 18.sp, color = MaterialTheme.colorScheme.error)
                    Text(browseCheckFailure!!.first, color = Dim, fontSize = 15.sp)
                    Text(browseCheckFailure!!.second, color = Dim, fontSize = 12.sp)
                    false
                }
                c == null -> { Text(stringResource(R.string.browse_contacting), color = Dim); false }
                else -> BrowseCheckLines(c, browsePick, browseSystems.orEmpty())
            }
            Spacer(Modifier.height(4.dp))
            // Offered whether the selection fits or not
            val listName = c?.listName
            if (ok) MenuItem(stringResource(R.string.browse_download), firstItem) { browseGet(s.from) }
            if (listName != null) {
                MenuItem(stringResource(R.string.browse_save_new), if (ok) null else firstItem) { screen = Screen.BrowseListName(listName, s) }
                MenuItem(stringResource(R.string.browse_save_to)) { browseListPick(s) }
            }
            MenuItem(stringResource(R.string.cancel), if (ok || listName != null) null else firstItem) { screen = s.from }
            LaunchedEffect(ok, listName) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.BrowseNoSpace -> {
            Text(stringResource(R.string.browse_review_title), fontSize = 22.sp)
            BrowseCheckLines(s.check, browsePick, browseSystems.orEmpty())
            Spacer(Modifier.height(4.dp))
            MenuItem(stringResource(R.string.press_back), firstItem) { screen = s.from }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
        }
        is Screen.BrowseListName -> {
            Text(stringResource(R.string.browse_save_new), fontSize = 22.sp)
            ListNameField(s.suggestion) { name -> browseSave(s.review, name = name) }
            MenuItem(stringResource(R.string.cancel)) { screen = s.review }
        }
        is Screen.BrowseListPick -> if (ownScroll) BrowseListPicker(browseLists, browseListsFailure, { screen = s.review }) { l -> browseSave(s.review, list = l.id) }
        is Screen.BrowseSaved -> {
            val c = s.saved.check
            Text(s.text, fontSize = 22.sp)
            val download = c.needGames > 0
            if (download) MenuItem(
                stringResource(R.string.browse_saved_download), firstItem,
                sub = "${pluralStringResource(R.plurals.browse_games_count, c.needGames, c.needGames)} · ${size(context, c.needBytes)}",
            ) { browseSave(Screen.Browse, list = s.saved.id, assign = true, pick = s.pick) }
            MenuItem(stringResource(R.string.browse_saved_done), if (download) null else firstItem) { screen = Screen.Browse }
            LaunchedEffect(s) { runCatching { firstItem.requestFocus() } }
        }
        Screen.BrowseDiscard -> {
            val n = browsePick.count(browseSystems.orEmpty()).first
            Text(context.resources.getQuantityString(R.plurals.browse_discard, n, n), fontSize = 20.sp)
            MenuItem(stringResource(R.string.browse_discard_keep), firstItem) { screen = Screen.Browse }
            MenuItem(stringResource(R.string.browse_discard_go), color = Warn) { browsePick = SyncEngine.BrowsePick(); screen = Screen.Menu }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
        Screen.Status -> {
            val info = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull() }
            val day = java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM)
            Text(stringResource(R.string.status), fontSize = 22.sp)
            Text(stringResource(R.string.status_version, info?.versionName.orEmpty()), color = Dim, fontSize = 15.sp)
            info?.let { Text(stringResource(R.string.status_installed, day.format(java.util.Date(it.firstInstallTime))), color = Dim, fontSize = 15.sp) }
            Text(stringResource(R.string.account, store.user ?: "?", store.server), color = Dim, fontSize = 15.sp)
            Spacer(Modifier.height(4.dp))
            val at = store.lastSummaryAt
            if (at > 0) {
                Text(stringResource(R.string.status_last, java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(at))), fontSize = 17.sp)
                SummaryLines(remember { Summary.decode(store.lastSummary) })
            } else Text(stringResource(R.string.never_synced), color = Dim)
            Spacer(Modifier.height(4.dp))
            Text(stringResource(R.string.status_log), fontSize = 17.sp)
            val log = store.log
            if (log.isEmpty()) Text(stringResource(R.string.no_log), color = Dim)
            log.takeLast(10).forEach { Text(it, color = Dim, fontSize = 13.sp) }
            Spacer(Modifier.height(8.dp))
            MenuItem(stringResource(R.string.press_back), firstItem) { screen = Screen.Menu }
            LaunchedEffect(Unit) { runCatching { firstItem.requestFocus() } }
        }
    }
}
