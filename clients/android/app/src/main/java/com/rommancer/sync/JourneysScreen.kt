package com.rommancer.sync

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val SlotGreen = Color(0xFF70E5A0)
private data class JourneyRow(val key: String, val title: String, val detail: String, val badge: String = "", val slot: Int? = null, val active: Boolean = false, val updated: String = "", val action: () -> Unit)

@Composable
internal fun JourneysScreen(store: Store, onBack: () -> Unit) {
    val context = LocalContext.current
    val engine = remember { Journeys(context, store) }
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    val searchFocus = remember { FocusRequester() }
    val submission = remember { SearchSubmission() }
    var resultsFocus by remember { mutableIntStateOf(0) }
    var games by remember { mutableStateOf<List<Journeys.Game>>(emptyList()) }
    var system by remember { mutableStateOf<String?>(null) }
    var game by remember { mutableStateOf<Journeys.Game?>(null) }
    var slots by remember { mutableStateOf<List<Journeys.Item>>(emptyList()) }
    var selected by remember { mutableStateOf<Journeys.Item?>(null) }
    var action by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var globalQuery by remember { mutableStateOf("") }
    var systemQuery by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var beforeChange by remember { mutableStateOf<(() -> Unit)?>(null) }
    val pages = remember { mutableStateMapOf<String, Int>() }
    val cursors = remember { mutableStateMapOf<String, String>() }
    fun back() {
        if (busy) return
        keyboard?.hide(); focusManager.clearFocus(); MainActivity.typing = false
        when {
            action != null -> action = null
            selected != null -> selected = null
            game != null -> { game = null; slots = emptyList() }
            system != null -> { system = null; systemQuery = "" }
            else -> onBack()
        }
        message = ""
    }
    BackHandler { back() }
    fun work(task: () -> String) {
        if (busy) return
        busy = true; failed = false; message = ""
        scope.launch {
            val current = game
            val result = withContext(Dispatchers.IO) {
                runCatching { val text = task(); text to current?.identity?.let { engine.items(it, false) } }
            }
            result.onSuccess { (text, list) ->
                message = if (text.contains("queued", ignoreCase = true)) text else ""
                if (list != null) slots = list
                selected = null; action = null
                val slotRoute = "${system ?: "consoles"}/${current?.rom}/slots/"
                list?.firstOrNull { it.current }?.let { cursors[slotRoute] = it.id }
                pages.remove(slotRoute)
            }
                .onFailure { failed = true; message = it.message ?: "Could not complete the change. Your saved copies are kept." }
            busy = false
        }
    }
    fun warnThen(task: () -> String) { if (!busy) beforeChange = { work(task) } }
    LaunchedEffect(Unit) {
        busy = true
        val result = withContext(Dispatchers.IO) { runCatching { engine.games() } }
        result.onSuccess { games = it }.onFailure { message = it.message.orEmpty(); failed = true }
        busy = false
    }
    LaunchedEffect(game?.identity) {
        val id = game?.identity ?: return@LaunchedEffect
        busy = true; slots = emptyList()
        withContext(Dispatchers.IO) { runCatching { engine.items(id, false) } }.onSuccess { slots = it }
        val result = withContext(Dispatchers.IO) { runCatching { engine.items(id) } }
        result.onSuccess { slots = it }.onFailure { message = it.message.orEmpty(); failed = true }
        busy = false
    }
    val g = game
    val target = selected
    val query = if (system == null) globalQuery else systemQuery
    val systems = remember(games, query) {
        games.groupBy { it.system }.toSortedMap(compareBy { LocalLibrary.systemName(it) })
            .filterKeys { query.isBlank() || LocalLibrary.matches(query, LocalLibrary.systemName(it), it) }
    }
    val found = remember(games, system, query) {
        if (system == null && query.isBlank()) emptyList()
        else games.filter { (system == null || it.system == system) && LocalLibrary.matches(query, it.title, LocalLibrary.systemName(it.system), it.system) }.sortedBy { it.title.lowercase() }
    }
    val route = "${system ?: "consoles"}/${g?.rom ?: query}/${target?.id ?: "slots"}/${action ?: ""}"
    val title = when { g != null -> g.title.substringBeforeLast('.', g.title); system != null -> LocalLibrary.systemName(system!!); else -> "Journeys · Choose a console" }
    val rows = mutableListOf<JourneyRow>()
    fun row(key: String, title: String, detail: String = "", run: () -> Unit) { rows += JourneyRow(key, title, detail, action = run) }
    fun open(value: Journeys.Game) { game = value; selected = null; action = null; message = "" }
    when {
        g == null -> {
            if (system == null) {
                systems.forEach { (slug, list) ->
                        row("system/$slug", LocalLibrary.systemName(slug), "${list.size} games") { system = slug; systemQuery = "" }
                }
            }
            found.forEach { value ->
                row("game/${value.rom}", value.title.substringBeforeLast('.', value.title), LocalLibrary.systemName(value.system)) { open(value) }
            }
        }
        g.identity == null -> {
            rows += JourneyRow("initial", "Set up Slot 1", "Keep all your existing saves and states", "CURRENT PROGRESS", 1) {
                if (!busy) {
                    beforeChange = {
                    busy = true
                    scope.launch {
                        val result = withContext(Dispatchers.IO) { runCatching { engine.enroll(g) } }
                        result.onSuccess { id -> game = g.copy(identity = id); message = "Current progress saved in Slot 1" }
                            .onFailure { message = it.message.orEmpty(); failed = true }
                        busy = false
                    }
                    }
                }
            }
        }
        action != null -> {
            val label = when (action) { "rename" -> "Rename slot"; "copy" -> "Copy slot"; else -> "Create slot" }
            row("confirm", label, if (action == "rename") "Only the name changes." else "Continue in the new slot. Your other slots keep their progress.") {
                val task = { when (action) {
                    "rename" -> engine.rename(g.identity, target!!.id, name)
                    "copy" -> engine.create(g.identity, name, true, true)
                    else -> engine.create(g.identity, name, false, true)
                } }
                if (action == "rename") work(task) else warnThen(task)
            }
        }
        target != null -> {
            if (!target.current) row("use", "Use Slot ${target.slot}", "Only this console changes slots.") { warnThen { engine.switch(g.identity, target.id, true) } }
            if (target.current) row("copy", "Copy this slot…", "Continue in a separate copy and keep this one safe.") { action = "copy"; name = "${target.name} copy".take(80) }
            row("rename", "Rename Slot ${target.slot}") { action = "rename"; name = target.name }
            if (target.current && target.conflict) row("conflict", "Keep both versions", "Keep server progress here and continue your local progress in a new slot.") { warnThen { engine.keepBoth(g.identity, true) } }
        }
        else -> {
            slots.forEach { item ->
                val detail = when { item.conflict -> "Two versions of this progress · Choose how to continue"; !item.cached -> "Download required"; item.files == 0 -> "No progress yet · Ready to start"; else -> "${item.files} saves and states · Available offline" }
                val updated = if (item.updatedAt > 0) "Updated: " + java.text.SimpleDateFormat("dd MMM yyyy · HH:mm", java.util.Locale.ENGLISH).format(java.util.Date(item.updatedAt)) else "Update date unavailable"
                rows += JourneyRow(item.id, item.name, detail + if (item.incompatible > 0) " · Some states use another core" else "", if (item.current) "IN USE" else if (item.conflict) "CONFLICT" else "", item.slot, item.current, updated + if (item.pendingSync) " · Pending sync" else "") { selected = item }
            }
            rows += JourneyRow("empty", "Empty slot", "Start fresh without changing your other slots", "NEW GAME", (slots.maxOfOrNull { it.slot } ?: 0) + 1) { action = "new"; name = "" }
            row("pending", "Apply pending changes", "Load any queued switch or newer progress.") { warnThen { engine.applyPending(g.identity) } }
        }
    }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(enabled = !busy, onClick = ::back) { Text("B · Back") }
            Text(if (g != null) "Save slots" else if (system != null) "Journeys · Games" else "Journeys", color = Accent)
        }
        Text(title, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
        if (target != null) Text("Slot ${target.slot} · ${target.name}" + if (target.current) " · In use on this console" else "", color = Accent)
        if (g == null) {
            key(system) {
                ConfirmedSearch(query, if (system == null) "Search consoles or all games" else "Search games on this console", searchFocus, submission) { value ->
                    if (system == null) globalQuery = value else systemQuery = value
                    keyboard?.hide(); focusManager.clearFocus(); MainActivity.typing = false; resultsFocus++
                }
            }
        } else if (action != null) {
            OutlinedTextField(name, { name = it.take(80) }, Modifier.fillMaxWidth().onFocusChanged { MainActivity.typing = it.isFocused }, singleLine = true, label = { Text(if (action == "rename") "Slot name" else "Slot name (optional)") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { keyboard?.hide(); focusManager.clearFocus(); MainActivity.typing = false; resultsFocus++ }))
        } else if (target == null) {
            slots.firstOrNull { it.current }?.let { Text("IN USE ON THIS CONSOLE · Slot ${it.slot} · ${it.name}", color = SlotGreen, fontSize = 15.sp, fontWeight = FontWeight.Bold) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (message.isNotBlank()) Text(message, color = if (failed) MaterialTheme.colorScheme.error else Accent, fontSize = 14.sp, maxLines = 3)
        if (!busy && rows.isEmpty()) Text(if (games.isEmpty()) "No supported games yet. Run Sync now to update your local inventory." else "No matches. Try another name.", color = Dim)
        JourneyPages(rows, route, pages, cursors, busy, Modifier.weight(1f), resultsFocus, { if (g == null) submission.accept?.invoke() }) { if (g == null) { searchFocus.requestFocus(); keyboard?.show() } }
    }
    if (beforeChange != null) AlertDialog(
        onDismissRequest = { beforeChange = null },
        title = { Text("Before continuing") },
        text = { Text("If the emulator is open, close it before continuing. An open emulator can write over the slot you are about to use.") },
        confirmButton = { TextButton(onClick = { val run = beforeChange; beforeChange = null; run?.invoke() }) { Text("OK") } },
        dismissButton = { TextButton(onClick = { beforeChange = null }) { Text("Cancel") } },
    )
    DisposableEffect(Unit) { onDispose { MainActivity.typing = false } }
}

@Composable
private fun JourneyPages(rows: List<JourneyRow>, route: String, pages: MutableMap<String, Int>, cursors: MutableMap<String, String>, busy: Boolean, modifier: Modifier, resultsFocus: Int, accept: () -> Unit, search: () -> Unit) {
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = remember { FocusRequester() }
    BoxWithConstraints(modifier) {
        val size = (maxHeight.value.minus(46) / if (rows.any { it.slot != null }) 114 else 68).toInt().coerceAtLeast(1)
        val total = ((rows.size - 1).coerceAtLeast(0) / size) + 1
        val preferred = rows.indexOfFirst { it.key == cursors[route] }.takeIf { it >= 0 } ?: rows.indexOfFirst { it.active }.coerceAtLeast(0)
        val page = (pages[route] ?: (preferred / size)).coerceIn(0, total - 1)
        val visible = rows.drop(page * size).take(size)
        val cursor = cursors[route]?.takeIf { key -> visible.any { it.key == key } } ?: visible.firstOrNull { it.active }?.key ?: visible.firstOrNull()?.key
        var focusPage by remember { mutableIntStateOf(0) }
        fun move(direction: Int) { if (!busy) {
            val next = LocalLibrary.page(page, direction, rows.size, size)
            pages[route] = next
            rows.getOrNull(next * size)?.let { cursors[route] = it.key }
            MainActivity.typing = false; keyboard?.hide(); focusPage++
        } }
        PadKeys { key -> when (key) {
            KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_PAGE_UP -> { move(-1); true }
            KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_DOWN -> { move(1); true }
            KeyEvent.KEYCODE_BUTTON_Y -> { search(); true }
            KeyEvent.KEYCODE_BUTTON_START -> { if (!busy) accept(); true }
            else -> false
        } }
        LaunchedEffect(route, page, focusPage, busy, resultsFocus) { if (!busy && rows.isNotEmpty() && !MainActivity.typing) { withFrameNanos { }; runCatching { focus.requestFocus() } } }
        Column(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                items(visible, key = { it.key }) { row ->
                    var focused by remember { mutableStateOf(false) }
                    Row(Modifier.fillMaxWidth().then(if (row.key == cursor) Modifier.focusRequester(focus) else Modifier)
                        .onFocusChanged { focused = it.isFocused; if (it.isFocused) cursors[route] = row.key }.background(if (row.active) Color(0xFF123C29) else Color(0xFF1B202C), RoundedCornerShape(10.dp))
                        .border(if (focused) 3.dp else if (row.active) 2.dp else 1.dp, if (row.active) SlotGreen else if (focused) Accent else Color(0xFF454D5E), RoundedCornerShape(10.dp))
                        .clickable(enabled = !busy, onClick = row.action).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        row.slot?.let { Text(it.toString().padStart(2, '0'), fontSize = 28.sp, fontWeight = FontWeight.Bold, color = if (row.active) SlotGreen else Accent) }
                        Column(Modifier.weight(1f)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(row.title, modifier = Modifier.weight(1f), fontSize = 18.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                                if (row.badge.isNotBlank()) Text(row.badge, color = if (row.active) Color(0xFF082315) else Accent, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                                    modifier = if (row.active) Modifier.background(SlotGreen, RoundedCornerShape(4.dp)).padding(horizontal = 7.dp, vertical = 3.dp) else Modifier)
                            }
                            if (row.detail.isNotBlank()) Text(row.detail, color = Color(0xFFB7BECD), fontSize = 13.sp, maxLines = 2)
                            if (row.updated.isNotBlank()) Text(row.updated, color = if (row.active) Color(0xFFB7F5CF) else Color(0xFFB7BECD), fontSize = 12.sp, maxLines = 2)
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(enabled = !busy && page > 0, onClick = { move(-1) }) { Text("L · Previous") }
                Text("${page + 1} / $total", modifier = Modifier.padding(top = 12.dp), color = Dim)
                TextButton(enabled = !busy && page + 1 < total, onClick = { move(1) }) { Text("R · Next") }
            }
        }
    }
}
