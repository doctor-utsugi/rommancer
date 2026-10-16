package com.rommancer.sync

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val SlotGreen = Color(0xFF70E5A0)
private val SlotFill = Color(0xFF123C29)

/** A line of a Journeys list: HEADER is the section line drawn above it */
private data class JourneyLine(val text: String, val sub: String? = null, val right: String? = null, val header: String? = null, val run: () -> Unit)

/** Asked before an action that replaces this console's save files */
private class Confirm(val title: String, val text: String, val ok: String, val safeFirst: Boolean, val run: () -> Unit)

/**
 * Journeys on a console: games with slots first, then consoles and their games, then one game's slots. The pad moves
 * through every list (L/R page), Y opens the search, A uses a slot at once, X opens its options
 */
@Composable
internal fun JourneysScreen(store: Store, onBack: () -> Unit) {
    val context = LocalContext.current
    val engine = remember { Journeys(context, store) }
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val list = rememberLazyListState()
    val rows = remember { RowFocus(list) }
    val field = remember { FocusRequester() }
    val submission = remember { SearchSubmission() }
    val naming = remember { SearchSubmission() }

    var games by remember { mutableStateOf<List<Journeys.Game>?>(null) }
    var system by remember { mutableStateOf<String?>(null) }
    var game by remember { mutableStateOf<Journeys.Game?>(null) }
    var slots by remember { mutableStateOf<List<Journeys.Item>?>(null) }
    var queued by remember { mutableStateOf(false) }
    var options by remember { mutableStateOf<Journeys.Item?>(null) }
    var renaming by remember { mutableStateOf<Journeys.Item?>(null) }
    val queries = remember { mutableStateMapOf<String, String>() }
    var editing by remember { mutableStateOf(false) }
    var focusField by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    // Where the cursor was on each list, so going back lands on the row just left
    val cursors = remember { mutableStateMapOf<String, Int>() }
    var refocus by remember { mutableIntStateOf(0) }

    val level = when { confirm != null -> "confirm"; renaming != null -> "rename"; options != null -> "options"; game != null -> "game"; system != null -> "system/$system"; else -> "home" }
    val queryKey = system ?: "home"
    val query = queries[queryKey].orEmpty()

    fun leaveSearch() { keyboard?.hide(); MainActivity.typing = false; editing = false }
    fun go(change: () -> Unit) {
        cursors[level] = rows.at
        leaveSearch(); note = null
        change()
        refocus++
    }
    fun back() {
        if (busy != null) return
        when {
            editing -> { leaveSearch(); refocus++ }
            confirm != null -> go { confirm = null }
            renaming != null -> go { renaming = null }
            options != null -> go { options = null }
            game != null -> go { game = null; slots = null }
            query.isNotEmpty() -> go { queries.remove(queryKey) }
            system != null -> go { system = null }
            else -> onBack()
        }
    }
    BackHandler { back() }

    fun loadSlots(id: String, refresh: Boolean = true) = scope.launch {
        val r = withContext(Dispatchers.IO) { runCatching { engine.items(id, refresh) to engine.pending(id) } }
        r.onSuccess { (items, pending) -> slots = items; queued = pending }.onFailure { note = (it.message ?: "Could not read the slots") to true }
    }

    /** TASK replaces save files (FILES): asked first unless the console can tell no emulator runs */
    fun change(label: String, done: (String) -> String, files: Boolean = true, task: () -> String) {
        if (busy != null) return
        val g = game ?: return
        val start: () -> Unit = {
            busy = label; note = null; options = null; renaming = null
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { task() } }
                r.onSuccess { text -> note = done(text) to false }.onFailure { note = (it.message ?: "Could not change slots. Your saves are kept.") to true }
                g.identity?.let { id ->
                    val items = withContext(Dispatchers.IO) { runCatching { engine.items(id, false) to engine.pending(id) }.getOrNull() }
                    if (items != null) { slots = items.first; queued = items.second }
                }
                busy = null
                cursors["game"] = slots?.indexOfFirst { it.current }?.coerceAtLeast(0) ?: 0
                refocus++
            }
            Unit
        }
        if (!files) return start()
        scope.launch {
            val (state, pkg) = withContext(Dispatchers.IO) { Foreground.runningEmulator(context) }
            val name = pkg?.let(::emulatorName)
            cursors[level] = rows.at
            when (state) {
                Foreground.JourneyState.STOPPED -> start()
                Foreground.JourneyState.RUNNING -> confirm = Confirm(
                    "$name is open", (if (name == "RetroArch") "Close the game in RetroArch first (Quick Menu → Close Content)." else "Quit $name first.") +
                        " If this game is still loaded it writes its old save over the slot when it exits. Another game being open does no harm.",
                    "The game is closed", safeFirst = true, run = start,
                )
                Foreground.JourneyState.UNKNOWN -> confirm = Confirm(
                    "Is the game closed?", "An emulator with this game loaded would write its old save over the slot when it exits.",
                    "Yes, continue", safeFirst = false, run = start,
                )
            }
        }
    }

    LaunchedEffect(Unit) {
        val r = withContext(Dispatchers.IO) { runCatching { engine.games() } }
        r.onSuccess { games = it }.onFailure { games = emptyList(); note = (it.message ?: "Could not load your games") to true }
        refocus++
    }
    LaunchedEffect(game?.identity) {
        val id = game?.identity ?: return@LaunchedEffect
        slots = null
        loadSlots(id, refresh = false).join()
        refocus++
        loadSlots(id).join()
        // Progress saved on another console goes in by itself when nothing could write over it
        if (slots?.firstOrNull { it.current }?.incoming == true && withContext(Dispatchers.IO) { Foreground.runningEmulator(context).first } == Foreground.JourneyState.STOPPED)
            change("Loading newer progress…", { "Loaded the newer progress saved on another console." }, files = false) { engine.applyPending(id) }
    }

    val g = game
    val all = games.orEmpty()
    val lines = mutableListOf<JourneyLine>()
    var title = "Journeys"
    var section = ""
    var body: String? = null
    var hint = "A Open · Y Search · B Back"
    var slotList: List<Journeys.Item>? = null
    when {
        confirm != null -> {
            val c = confirm!!
            title = c.title
            section = "Before changing slots"
            body = c.text
            hint = "A Choose · B Cancel"
            val ok = JourneyLine(c.ok) { confirm = null; c.run() }
            val cancel = JourneyLine("Cancel") { go { confirm = null } }
            lines += if (c.safeFirst) listOf(cancel, ok) else listOf(ok, cancel)
        }
        renaming != null -> { title = "Rename slot ${renaming!!.slot.toString().padStart(2, '0')}"; section = "New name"; hint = "START Save · B Cancel" }
        options != null -> {
            val o = options!!
            title = "Slot ${o.slot.toString().padStart(2, '0')} · ${o.name}"
            section = if (o.current) "In use on this console" else "Not in use on this console"
            hint = "A Choose · B Back"
            if (o.current && o.conflict) lines += JourneyLine("Keep both versions", "The other console's progress stays in this slot; yours goes on in a new one") {
                change("Keeping both versions…", { "Your progress is now in its own slot." }) { engine.keepBoth(g!!.identity!!, true) }
            }
            if (!o.current) lines += JourneyLine("Use this slot", "Load its saves and states on this console") { change("Changing slot…", { "Now using ${o.name}. Start the game to play it." }) { engine.switch(g!!.identity!!, o.id, true) } }
            if (o.current && !o.conflict) lines += JourneyLine("Copy into a new slot", "Keep this one as it is and go on playing in the copy") {
                change("Copying slot…", { "Now using the copy. ${o.name} stays as it was." }) { engine.create(g!!.identity!!, "${o.name} copy".take(80), true, true) }
            }
            lines += JourneyLine("Rename", o.name) { go { renaming = o } }
        }
        g != null && g.identity == null -> {
            title = g.title.substringBeforeLast('.')
            section = g.systemName
            body = "This game has no save slots on this console yet. Setting them up keeps the saves and states it has now in a slot of their own; the slots you made on other consoles appear next to it, ready to use."
            hint = "A Set up · B Back"
            lines += JourneyLine("Set up save slots") {
                change("Setting up slots…", { "Your saves on this console are kept in a slot." }) {
                    engine.enroll(g).also { id -> scope.launch { game = g.copy(identity = id); games = games?.map { if (it.rom == g.rom) it.copy(identity = id) else it } } }
                    "ok"
                }
            }
        }
        g != null -> {
            title = g.title.substringBeforeLast('.')
            val items = slots
            slotList = items
            val active = items?.firstOrNull { it.current }
            section = if (items == null) "Loading slots…" else active?.let { "In use: ${it.slot.toString().padStart(2, '0')} ${it.name}" } ?: "No slot in use"
            hint = "A Use slot · X Options · B Back"
        }
        system != null -> {
            val name = all.firstOrNull { it.system == system }?.systemName ?: LocalLibrary.systemName(system!!)
            title = "Journeys · $name"
            val found = all.filter { it.system == system && LocalLibrary.matches(query, it.title) }.sortedWith(compareBy({ it.identity == null }, { it.title.lowercase() }))
            section = if (query.isEmpty()) plural(found.size, "game") else "${plural(found.size, "result")} for “$query”"
            found.forEach { v -> lines += JourneyLine(v.title.substringBeforeLast('.'), right = if (v.identity != null) "Slots ready" else null) { go { game = v } } }
        }
        else -> {
            val enrolled = all.filter { it.identity != null }.sortedBy { it.title.lowercase() }
            val systems = all.groupBy { it.system }.entries.sortedBy { it.value.first().systemName.lowercase() }
            if (query.isEmpty()) {
                section = if (games == null) "Loading your games…" else "${plural(enrolled.size, "game")} with slots · ${plural(systems.size, "console")}"
                enrolled.forEachIndexed { i, v -> lines += JourneyLine(v.title.substringBeforeLast('.'), v.systemName, "Slots ready", header = if (i == 0) "Games with slots" else null) { go { game = v } } }
                systems.forEachIndexed { i, (slug, list) -> lines += JourneyLine(list.first().systemName, right = plural(list.size, "game"), header = if (i == 0) "Consoles" else null) { go { system = slug } } }
            } else {
                val consoles = systems.filter { (slug, list) -> LocalLibrary.matches(query, list.first().systemName, slug) }
                val found = all.filter { LocalLibrary.matches(query, it.title, it.systemName) }.sortedWith(compareBy({ it.identity == null }, { it.title.lowercase() }))
                section = "${plural(consoles.size + found.size, "result")} for “$query”"
                consoles.forEach { (slug, list) -> lines += JourneyLine(list.first().systemName, right = plural(list.size, "game")) { go { system = slug } } }
                found.forEach { v -> lines += JourneyLine(v.title.substringBeforeLast('.'), v.systemName, if (v.identity != null) "Slots ready" else null) { go { game = v } } }
            }
        }
    }
    val searchable = g == null && options == null && renaming == null && confirm == null
    val count = slotList?.let { it.size + 1 + if (queued) 1 else 0 } ?: lines.size

    fun openSearch() { if (searchable && busy == null) { editing = true; focusField++ } }
    PadKeys { key ->
        when (key) {
            KeyEvent.KEYCODE_BUTTON_Y -> openSearch()
            KeyEvent.KEYCODE_BUTTON_X -> slotList?.getOrNull(rows.at)?.let { if (busy == null) go { options = it } }
            KeyEvent.KEYCODE_BUTTON_START -> if (editing) submission.accept?.invoke() else if (renaming != null) naming.accept?.invoke()
            KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_PAGE_UP -> scope.launch { rows.page(-1, count) }
            KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_DOWN -> scope.launch { rows.page(1, count) }
            else -> return@PadKeys false
        }
        true
    }
    LaunchedEffect(focusField) {
        if (focusField == 0) return@LaunchedEffect
        withFrameNanos { }
        runCatching { field.requestFocus() }
        keyboard?.show()
    }
    // A list just shown starts on the row left there (the slot in use on a game), never in the search
    LaunchedEffect(refocus, level, count > 0, busy == null) {
        if (count == 0 || editing || busy != null || renaming != null) return@LaunchedEffect
        val start = cursors[level] ?: if (level == "game") slotList?.indexOfFirst { it.current }?.coerceAtLeast(0) ?: 0 else 0
        rows.at = start.coerceIn(0, count - 1)
        runCatching { list.scrollToItem(rows.at) }
        rows.focus(rows.at)
    }
    RefocusOnKeys(rows, count)

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BrowseBar(title, rows, ::back) {
            if (searchable) {
                if (editing || query.isNotEmpty()) SearchField(
                    query, if (system == null) "Search consoles and games" else "Search this console's games", busy = false, field = field, rows = rows,
                    editing = editing, submission = submission, onEdit = { openSearch() }, onLeave = { leaveSearch() },
                    onSubmit = { v -> cursors.remove(level); if (v.isEmpty()) queries.remove(queryKey) else queries[queryKey] = v; leaveSearch(); refocus++ },
                    onClose = { cursors.remove(level); queries.remove(queryKey); leaveSearch(); refocus++ },
                ) else SearchButton(rows) { openSearch() }
            }
        }
        BrowseSection(busy ?: section, busy = busy != null || games == null, hint = hint)
        body?.let { Text(it, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) }
        if (confirm == null) note?.let { (text, bad) -> Text(text, color = if (bad) MaterialTheme.colorScheme.error else SlotGreen, fontSize = 15.sp, maxLines = 2, modifier = Modifier.padding(horizontal = 12.dp)) }
        if (renaming != null) {
            RenameField(renaming!!, naming) { name -> val o = renaming!!; if (name.isNotBlank()) change("Renaming…", { "Renamed to $name" }, files = false) { engine.rename(g!!.identity!!, o.id, name) } else go { renaming = null } }
            Spacer(Modifier.weight(1f))
        } else if (slotList != null && confirm == null) {
            val active = slotList.firstOrNull { it.current }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(count) { i ->
                    val item = slotList.getOrNull(i)
                    when {
                        item != null -> SlotRow(i, rows, item) {
                            if (item.current) go { options = item }
                            else change("Changing slot…", { "Now using ${item.name}. Start the game to play it." }) { engine.switch(g!!.identity!!, item.id, true) }
                        }
                        i == slotList.size -> {
                            val label = { "New game · " + SimpleDateFormat("d MMM HH:mm", Locale.ENGLISH).format(Date()) }
                            SlotRow(i, rows, null, label()) {
                                // Named when created, not when the list was drawn
                                val name = label()
                                change("Creating slot…", { "Now using a new empty slot. ${active?.name ?: "Your other slots"} keep${if (active == null) "" else "s"} its progress." }) { engine.create(g!!.identity!!, name, false, true) }
                            }
                        }
                        else -> {
                            val newer = active?.incoming == true
                            BrowseRow(i, rows, if (newer) "Load the newer progress" else "Apply the queued slot change", sub = if (newer) "Saved on another console · close the game first" else "Once the game is closed") {
                                change("Applying…", { if (newer) "Newer progress loaded. Start the game to play it." else it }) { engine.applyPending(g!!.identity!!) }
                            }
                        }
                    }
                }
            }
        } else {
            if (games != null && lines.isEmpty()) BrowseNote(if (all.isEmpty()) "No games here can use slots yet. Run Sync now so the server knows this console's games." else "Nothing matches “$query”.")
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list) {
                items(lines.size) { i ->
                    val l = lines[i]
                    Column {
                        l.header?.let { Text(it.uppercase(), fontSize = 12.sp, letterSpacing = 0.6.sp, color = Accent, modifier = Modifier.padding(start = 12.dp, top = if (i == 0) 0.dp else 10.dp, bottom = 2.dp)) }
                        BrowseRow(i, rows, l.text, sub = l.sub, right = l.right) { if (busy == null) l.run() }
                    }
                }
            }
        }
    }

    DisposableEffect(Unit) { onDispose { MainActivity.typing = false } }
}

/** A save slot: its number, name, what it holds and when it changed; ITEM null is the empty slot that starts a new game */
@Composable
private fun SlotRow(index: Int, rows: RowFocus, item: Journeys.Item?, emptyName: String = "", onClick: () -> Unit) {
    val requester = remember { FocusRequester() }
    DisposableEffect(index) {
        rows.requesters[index] = requester
        onDispose { if (rows.requesters[index] === requester) rows.requesters.remove(index) }
    }
    val cursor = rows.at == index
    val active = item?.current == true
    val shape = RoundedCornerShape(10.dp)
    val fg = if (cursor) Ink else Color.White
    val faint = if (cursor) Ink else Color(0xFFB7BECD)
    Row(
        Modifier.fillMaxWidth().focusRequester(requester).onFocusChanged { if (it.isFocused) rows.at = index }.clip(shape)
            .background(if (cursor) Accent else if (active) SlotFill else Bar)
            .border(if (active) 2.dp else 0.dp, if (active) SlotGreen else Color.Transparent, shape)
            .clickable { rows.at = index; onClick() }.padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(if (item == null) "+" else item.slot.toString().padStart(2, '0'), fontSize = 26.sp, fontWeight = FontWeight.Bold, color = if (cursor) Ink else if (active) SlotGreen else Accent, modifier = Modifier.widthIn(min = 38.dp))
        Column(Modifier.weight(1f)) {
            Text(item?.name ?: "Empty slot", fontSize = 18.sp, fontWeight = FontWeight.Medium, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(item?.let { slotDetail(it) } ?: "Start a new game as “$emptyName”. Your other slots keep their progress", fontSize = 13.sp, color = faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (active) Text("IN USE", color = Color(0xFF082315), fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.background(SlotGreen, RoundedCornerShape(4.dp)).padding(horizontal = 7.dp, vertical = 3.dp))
        else if (item?.conflict == true) Text("TWO VERSIONS", color = if (cursor) Ink else Warn, fontSize = 13.sp, fontWeight = FontWeight.Bold)
    }
}

/** "com.retroarch.aarch64" -> "RetroArch": the package's own label needs a visibility query per emulator */
private fun emulatorName(pkg: String): String {
    val known = mapOf("retroarch" to "RetroArch", "ppsspp" to "PPSSPP", "duckstation" to "DuckStation", "dolphin" to "Dolphin", "azahar" to "Azahar",
        "melonds" to "melonDS", "drastic" to "DraStic", "flycast" to "Flycast", "mupen64" to "Mupen64Plus", "lemuroid" to "Lemuroid", "armsx2" to "ARMSX2", "mgba" to "mGBA")
    return known.entries.firstOrNull { it.key in pkg.lowercase() }?.value ?: "The emulator"
}

private fun slotDetail(item: Journeys.Item): String {
    val content = when {
        item.conflict -> "Two versions of this progress · X to choose"
        item.incoming -> "Newer progress from another console waiting"
        !item.cached -> "Needs a download · connect to use it"
        item.files == 0 -> "No saves yet"
        item.files == 1 -> "1 save file"
        else -> "${item.files} saves and states"
    }
    val date = if (item.updatedAt > 0) SimpleDateFormat("d MMM yyyy · HH:mm", Locale.ENGLISH).format(Date(item.updatedAt)) else null
    return listOfNotNull(content, date, "some states are for another core version".takeIf { item.incompatible > 0 }, "waiting to sync".takeIf { item.pendingSync }).joinToString(" · ")
}

/** The name field, focused with the keyboard open: Done or START saves it, B leaves it unchanged */
@Composable
private fun RenameField(item: Journeys.Item, submission: SearchSubmission, onDone: (String) -> Unit) {
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = remember { FocusRequester() }
    var name by remember(item.id) { mutableStateOf(item.name) }
    SideEffect { submission.accept = { onDone(name.trim()) } }
    LaunchedEffect(item.id) { withFrameNanos { }; runCatching { focus.requestFocus() }; keyboard?.show() }
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(name, { name = it.take(80) }, Modifier.weight(1f).focusRequester(focus).onFocusChanged { MainActivity.typing = it.isFocused }, singleLine = true,
            label = { Text("Slot name") }, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { keyboard?.hide(); onDone(name.trim()) }))
        TextButton({ keyboard?.hide(); onDone(name.trim()) }) { Text("Save") }
    }
    DisposableEffect(Unit) { onDispose { MainActivity.typing = false; submission.accept = null } }
}

private fun plural(n: Int, word: String) = "$n $word" + if (n == 1) "" else "s"
