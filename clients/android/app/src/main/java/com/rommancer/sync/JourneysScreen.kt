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

private data class JourneyRow(val key: String, val title: String, val detail: String, val badge: String = "", val slot: Int? = null, val active: Boolean = false, val action: () -> Unit)

@Composable
internal fun JourneysScreen(store: Store, onBack: () -> Unit) {
    val context = LocalContext.current
    val engine = remember { Journeys(context, store) }
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    val searchFocus = remember { FocusRequester() }
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
                runCatching { val text = task(); text to current?.identity?.let { engine.items(it) } }
            }
            result.onSuccess { (text, list) -> message = text; if (list != null) slots = list; selected = null; action = null }
                .onFailure { failed = true; message = it.message ?: "Could not complete the change. Your saved copies are kept." }
            busy = false
        }
    }
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
    val route = "${system ?: "consoles"}/${g?.rom ?: query}/${target?.id ?: "slots"}/${action ?: ""}"
    val title = when { g != null -> g.title.substringBeforeLast('.', g.title); system != null -> LocalLibrary.systemName(system!!); else -> "Journeys · Choose a console" }
    val rows = mutableListOf<JourneyRow>()
    fun row(key: String, title: String, detail: String = "", run: () -> Unit) { rows += JourneyRow(key, title, detail, action = run) }
    fun open(value: Journeys.Game) { game = value; selected = null; action = null; message = "" }
    when {
        g == null -> {
            val scoped = games.filter { system == null || it.system == system }
            if (system == null) {
                games.groupBy { it.system }.toSortedMap(compareBy { LocalLibrary.systemName(it) }).forEach { (slug, list) ->
                    if (query.isBlank() || LocalLibrary.matches(query, LocalLibrary.systemName(slug), slug))
                        row("system/$slug", LocalLibrary.systemName(slug), "${list.size} games") { system = slug; systemQuery = "" }
                }
            }
            if (system != null || query.isNotBlank()) scoped.filter { LocalLibrary.matches(query, it.title, LocalLibrary.systemName(it.system), it.system) }.sortedBy { it.title.lowercase() }.forEach { value ->
                row("game/${value.rom}", value.title.substringBeforeLast('.', value.title), LocalLibrary.systemName(value.system)) { open(value) }
            }
        }
        g.identity == null -> {
            rows += JourneyRow("initial", "Set up Slot 1", "Game closed · Keep all your existing saves and states", "CURRENT PROGRESS", 1) {
                if (!busy) {
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
        action != null -> {
            val label = when (action) { "rename" -> "Rename slot"; "copy" -> "Copy to a new slot and use it"; else -> "Start in a new slot" }
            row("confirm", label, if (action == "rename") "Only the name changes." else "Game closed · The original slot keeps its progress.") {
                work { when (action) {
                    "rename" -> engine.rename(g.identity, target!!.id, name)
                    "copy" -> engine.create(g.identity, name, true, true)
                    else -> engine.create(g.identity, name, false, true)
                } }
            }
        }
        target != null -> {
            if (!target.current) row("use", "Use Slot ${target.slot}", "Close the emulator first. Only this console changes slots.") { work { engine.switch(g.identity, target.id, true) } }
            if (target.current) row("copy", "Copy this slot…", "Continue in a separate copy and keep this one safe.") { action = "copy"; name = "${target.name} copy".take(80) }
            row("rename", "Rename Slot ${target.slot}") { action = "rename"; name = target.name }
            if (target.current && target.conflict) row("conflict", "Keep both versions", "Keep server progress here and continue your local progress in a new slot.") { work { engine.keepBoth(g.identity, true) } }
            if (!target.current) row("queue", "Change after closing the game", "Queue the switch if you are still playing.") { work { engine.switch(g.identity, target.id, false) } }
        }
        else -> {
            slots.forEach { item ->
                val detail = when { item.conflict -> "Two versions of this progress · Choose how to continue"; !item.cached -> "Download required"; item.files == 0 -> "No progress yet · Ready to start"; else -> "${item.files} saves and states · Available offline" }
                rows += JourneyRow(item.id, item.name, detail + if (item.incompatible > 0) " · Some states use another core" else "", if (item.current) "IN USE" else if (item.conflict) "CONFLICT" else "", item.slot, item.current) { selected = item }
            }
            rows += JourneyRow("empty", "Empty slot", "Start fresh without changing your other slots", "NEW GAME", (slots.maxOfOrNull { it.slot } ?: 0) + 1) { action = "new"; name = "" }
            row("pending", "Apply pending changes", "Close the emulator first. Load any queued switch or newer progress.") { work { engine.applyPending(g.identity) } }
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
            OutlinedTextField(query, { value -> if (system == null) globalQuery = value else systemQuery = value },
                Modifier.fillMaxWidth().focusRequester(searchFocus).onFocusChanged { MainActivity.typing = it.isFocused }, singleLine = true,
                label = { Text(if (system == null) "Search consoles or all games" else "Search games on this console") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { keyboard?.hide(); focusManager.clearFocus(); MainActivity.typing = false; resultsFocus++ }))
        } else if (action != null) {
            OutlinedTextField(name, { name = it.take(80) }, Modifier.fillMaxWidth().onFocusChanged { MainActivity.typing = it.isFocused }, singleLine = true, label = { Text(if (action == "rename") "Slot name" else "Slot name (optional)") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { keyboard?.hide(); focusManager.clearFocus(); MainActivity.typing = false; resultsFocus++ }))
        } else if (target == null) Text("Choose a slot to continue. Each slot keeps all of this game's saves.", color = Dim, fontSize = 14.sp)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (message.isNotBlank()) Text(message, color = if (failed) MaterialTheme.colorScheme.error else Accent, fontSize = 14.sp, maxLines = 3)
        if (!busy && rows.isEmpty()) Text(if (games.isEmpty()) "No supported games yet. Run Sync now to update your local inventory." else "No matches. Try another name.", color = Dim)
        JourneyPages(rows, route, pages, cursors, busy, Modifier.weight(1f), resultsFocus) { if (g == null) { searchFocus.requestFocus(); keyboard?.show() } }
    }
    DisposableEffect(Unit) { onDispose { MainActivity.typing = false } }
}

@Composable
private fun JourneyPages(rows: List<JourneyRow>, route: String, pages: MutableMap<String, Int>, cursors: MutableMap<String, String>, busy: Boolean, modifier: Modifier, resultsFocus: Int, search: () -> Unit) {
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = remember { FocusRequester() }
    BoxWithConstraints(modifier) {
        val size = (maxHeight.value.minus(46) / if (rows.any { it.slot != null }) 92 else 68).toInt().coerceAtLeast(1)
        val total = ((rows.size - 1).coerceAtLeast(0) / size) + 1
        val page = (pages[route] ?: 0).coerceIn(0, total - 1)
        val visible = rows.drop(page * size).take(size)
        val cursor = cursors[route]?.takeIf { key -> visible.any { it.key == key } } ?: visible.firstOrNull()?.key
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
            else -> false
        } }
        LaunchedEffect(route, page, focusPage, busy, resultsFocus) { if (!busy && rows.isNotEmpty() && !MainActivity.typing) { withFrameNanos { }; runCatching { focus.requestFocus() } } }
        Column(Modifier.fillMaxSize()) {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                items(visible, key = { it.key }) { row ->
                    var focused by remember { mutableStateOf(false) }
                    Row(Modifier.fillMaxWidth().then(if (row.key == cursor) Modifier.focusRequester(focus) else Modifier)
                        .onFocusChanged { focused = it.isFocused; if (it.isFocused) cursors[route] = row.key }.background(if (row.active) Accent.copy(alpha = .14f) else Color(0xFF1B202C), RoundedCornerShape(10.dp))
                        .border(if (focused) 2.dp else 1.dp, if (focused) Accent else if (row.active) Accent.copy(alpha = .6f) else Color(0xFF454D5E), RoundedCornerShape(10.dp))
                        .clickable(enabled = !busy, onClick = row.action).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        row.slot?.let { Text(it.toString().padStart(2, '0'), fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Accent) }
                        Column(Modifier.weight(1f)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(row.title, modifier = Modifier.weight(1f), fontSize = 18.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                                if (row.badge.isNotBlank()) Text(row.badge, color = Accent, fontSize = 12.sp)
                            }
                            if (row.detail.isNotBlank()) Text(row.detail, color = Color(0xFFB7BECD), fontSize = 13.sp, maxLines = 2)
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
