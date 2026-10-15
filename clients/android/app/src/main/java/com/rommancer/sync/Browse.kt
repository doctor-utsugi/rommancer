package com.rommancer.sync

import android.view.KeyEvent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The search goes out this long after the last edit of its text; the keyboard's Search key does not wait */
private const val SEARCH_DEBOUNCE = 2_000L

/** Text on the accent fill, the bars' background, a game already here */
private val Ink = Color(0xFF0B1220)
private val Bar = Color(0x14FFFFFF)
private val Done = Color(0xFF5DCAA5)

/** Above this a download is said to take a long time */
private const val LONG_GAMES = 50
private const val LONG_BYTES = 2_000_000_000L

/** Takes the browse keys (X, Y, START, L1/R1 and the page keys) while the screen shows */
@Composable
internal fun PadKeys(handler: (Int) -> Boolean) {
    val current by rememberUpdatedState(handler)
    DisposableEffect(Unit) {
        val h: (Int) -> Boolean = { current(it) }
        MainActivity.pad = h
        onDispose { if (MainActivity.pad === h) MainActivity.pad = null }
    }
}

/**
 * Touch mode gives a row no focus, so the first pad key would start from the top bar: when the pad takes over, the
 * focus goes back to the cursor row
 */
@Composable
private fun RefocusOnKeys(rows: RowFocus, count: Int) {
    val mode = LocalInputModeManager.current.inputMode
    // The first key may already have moved the focus (and the cursor) into the bar: the row from before it
    val last = remember { intArrayOf(rows.at) }
    SideEffect { if (mode == InputMode.Touch) last[0] = rows.at }
    LaunchedEffect(mode) { if (mode == InputMode.Keyboard && last[0] in 0 until count) rows.focus(last[0]) }
}

/** Where the focus is in a browse list, and moving it to a row that may not be composed yet (paging) */
private class RowFocus(val list: LazyListState) {
    val requesters = HashMap<Int, FocusRequester>()
    var at by mutableIntStateOf(0)

    suspend fun focus(index: Int) {
        if (list.layoutInfo.visibleItemsInfo.none { it.index == index }) list.scrollToItem(index)
        // The row exists once the list laid it out
        repeat(5) {
            requesters[index]?.let { runCatching { it.requestFocus() }; return }
            withFrameNanos { }
        }
    }

    /** DIR pages up (-1) or down (1) among COUNT rows */
    suspend fun page(dir: Int, count: Int) {
        if (count == 0) return
        val step = list.layoutInfo.visibleItemsInfo.size.coerceAtLeast(1)
        focus((at + dir * step).coerceIn(0, count - 1))
    }
}

/**
 * One line, one focus stop: TICK alone calls ON_TICK (touch), DIM cannot be picked. The cursor row is filled
 * whether the pad or a finger put it there (touch mode shows no focus)
 */
@Composable
private fun BrowseRow(
    index: Int, rows: RowFocus, text: String, sub: String? = null, tick: String? = null, tickColor: Color? = null, right: String? = null,
    dim: Boolean = false, onTick: (() -> Unit)? = null, onClick: () -> Unit,
) {
    val requester = remember { FocusRequester() }
    DisposableEffect(index) {
        rows.requesters[index] = requester
        onDispose { if (rows.requesters[index] === requester) rows.requesters.remove(index) }
    }
    val cursor = rows.at == index
    val color = if (cursor) Ink else if (dim) Dim else Color.White
    val faint = if (cursor) Ink else Dim
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .focusRequester(requester)
            .onFocusChanged { if (it.isFocused) rows.at = index }
            .clip(shape)
            .background(if (cursor) Accent else Color.Transparent)
            .clickable { rows.at = index; onClick() }
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tick != null) {
            val tap = onTick?.let { t -> Modifier.pointerInput(t) { detectTapGestures { rows.at = index; t() } } } ?: Modifier
            Text(tick, fontSize = 20.sp, color = if (cursor) Ink else tickColor ?: color, modifier = tap.padding(end = 10.dp))
        }
        Text(text, fontSize = 17.sp, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (sub != null) Text(sub, fontSize = 13.sp, color = faint, maxLines = 1, modifier = Modifier.padding(start = 10.dp))
        if (right != null) Text(right, fontSize = 14.sp, color = faint, maxLines = 1, modifier = Modifier.padding(start = 10.dp))
    }
}

private fun tickOf(state: Int) = when (state) { 2 -> "☑"; 1 -> "⊟"; else -> "☐" }

/**
 * A button of the browse bars, focusable by the pad: filled while focused, outlined while SELECTED (a filter that is
 * on). CONTENT gets the color its text and icons take
 */
@Composable
private fun BarButton(
    onClick: () -> Unit, modifier: Modifier = Modifier, selected: Boolean = false, onFocused: () -> Unit = {},
    content: @Composable RowScope.(Color) -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val shape = RoundedCornerShape(18.dp)
    Row(
        modifier
            .onFocusChanged { if (it.isFocused) onFocused() }
            .clip(shape)
            .background(if (focused) Accent else if (selected) Accent.copy(alpha = 0.18f) else Color.Transparent)
            .border(1.dp, if (focused || selected) Accent else Dim.copy(alpha = 0.5f), shape)
            .clickable(interactionSource = source, indication = null, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { content(if (focused) Ink else if (selected) Accent else Color.White) }
}

/** The owned games' filter: on (the default) the games already on this console stay out of the lists */
@Composable
private fun OwnedChip(showAll: Boolean, rows: RowFocus, onShowAll: () -> Unit) {
    BarButton(onShowAll, selected = !showAll, onFocused = { rows.at = -1 }) { c ->
        if (!showAll) Icon(Icons.Default.Check, null, tint = c, modifier = Modifier.size(16.dp).padding(end = 2.dp))
        Text(stringResource(R.string.browse_hide_owned), color = c, fontSize = 14.sp, maxLines = 1)
    }
}

/**
 * The bar on top of the browse screens, one line: back, where this is, then ACTIONS (the search icon and the
 * owned filter, or the open search field)
 */
@Composable
private fun BrowseBar(title: String, rows: RowFocus, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bar).padding(horizontal = 6.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        BarButton(onBack, onFocused = { rows.at = -1 }) { c -> Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.press_back), tint = c, modifier = Modifier.size(20.dp)) }
        Text(title, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        actions()
    }
}

/**
 * The search, open in the bar: TEXT, a spinner while BUSY (waiting for the debounce or the server), X to close it.
 * Editable only while EDITING: once searched it shows the query (A or a tap edits it again), so a gamepad keyboard
 * such as the Thor's no longer takes the pad's keys from the list
 */
@Composable
private fun RowScope.SearchField(
    text: String, onText: (String) -> Unit, hint: String, busy: Boolean, field: FocusRequester, rows: RowFocus,
    editing: Boolean, onEdit: () -> Unit, onLeave: () -> Unit, onSubmit: () -> Unit, onClose: () -> Unit,
) {
    val shape = RoundedCornerShape(18.dp)
    if (!editing) {
        BarButton(onEdit, Modifier.weight(3f), onFocused = { rows.at = -1 }) { c ->
            Icon(Icons.Default.Search, null, tint = c, modifier = Modifier.size(18.dp))
            Text(text.ifEmpty { hint }, color = if (text.isEmpty()) Dim else c, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
            if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
        }
    } else {
    var had by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { MainActivity.typing = false } }
    BasicTextField(
        text, onText,
        Modifier.weight(3f).focusRequester(field).onFocusChanged {
            MainActivity.typing = it.isFocused
            if (it.isFocused) {
                had = true
                rows.at = -1
            } else if (had) onLeave()
        },
        singleLine = true,
        textStyle = TextStyle(color = Color.White, fontSize = 17.sp),
        cursorBrush = SolidColor(Accent),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSubmit() }),
        decorationBox = { inner ->
            Row(Modifier.clip(shape).border(2.dp, Accent, shape).padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Search, null, tint = Accent, modifier = Modifier.size(18.dp))
                Box(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                    if (text.isEmpty()) Text(hint, color = Dim, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
                if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Accent)
            }
        },
    )
    }
    BarButton(onClose, onFocused = { rows.at = -1 }) { c -> Icon(Icons.Default.Close, stringResource(R.string.browse_search_close), tint = c, modifier = Modifier.size(20.dp)) }
}

/** The search icon, closed */
@Composable
private fun SearchButton(rows: RowFocus, onClick: () -> Unit) {
    BarButton(onClick, onFocused = { rows.at = -1 }) { c -> Icon(Icons.Default.Search, stringResource(R.string.browse_search), tint = c, modifier = Modifier.size(20.dp)) }
}

/** What the list below is and how many it holds, a spinner while the server is asked; HINT the keys that work in it */
@Composable
private fun BrowseSection(text: String, busy: Boolean = false, hint: String? = null) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        if (busy) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = Accent)
        Text(
            text.uppercase(), fontSize = 12.sp, letterSpacing = 0.6.sp, color = if (busy) Accent else Dim, maxLines = 1,
            modifier = Modifier.weight(1f).padding(start = if (busy) 8.dp else 0.dp),
        )
        if (hint != null) Text(hint, fontSize = 12.sp, color = Dim, maxLines = 1)
    }
}

/** Fixed at the bottom: the selection with its rough size and the button that reviews it, or the keys' hint */
@Composable
private fun BrowseFooter(pick: SyncEngine.BrowsePick, known: List<SyncEngine.BrowseSystem>, hint: String, rows: RowFocus, onReview: () -> Unit) {
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Bar).padding(horizontal = 12.dp, vertical = 5.dp).heightIn(min = 34.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (pick.isEmpty) {
            Text(hint, fontSize = 13.sp, color = Dim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        } else {
            val (n, bytes) = pick.count(known)
            Text(
                stringResource(R.string.browse_selected, pluralStringResource(R.plurals.browse_games_count, n, n), size(context, bytes)),
                fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            BarButton(onReview, selected = true, onFocused = { rows.at = -1 }) { c ->
                Text(stringResource(R.string.browse_review_button), color = c, fontSize = 15.sp, maxLines = 1)
            }
        }
    }
}

/** Could not reach the server, why, and what is behind it */
@Composable
private fun BrowseFailure(failure: Pair<String, String>) {
    Column(Modifier.padding(horizontal = 12.dp)) {
        Text(stringResource(R.string.browse_unreachable), fontSize = 18.sp, color = MaterialTheme.colorScheme.error)
        Text(failure.first, color = Dim, fontSize = 15.sp)
        Text(failure.second, color = Dim, fontSize = 12.sp)
    }
}

/** A line under the section, centered on what the list cannot show */
@Composable
private fun BrowseNote(text: String, color: Color = Dim) {
    Text(text, color = color, fontSize = 16.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
}

/**
 * The systems the server can send, each with its tri-state tick. A opens, X ticks it whole, Y searches every
 * system, START reviews; START is the row focused first
 */
@Composable
internal fun BrowseSystems(
    systems: List<SyncEngine.BrowseSystem>?, failure: Pair<String, String>?, denied: Boolean, pick: SyncEngine.BrowsePick, start: Int,
    showAll: Boolean, onShowAll: () -> Unit, onBack: () -> Unit,
    onOpen: (SyncEngine.BrowseSystem, Int) -> Unit, onSearch: () -> Unit, onTick: (String) -> Unit, onReview: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    val rows = remember { RowFocus(list) }
    // Systems with nothing left to download only show with the games already here
    val shown = systems?.filter { showAll || it.fresh > 0 }
    val count = shown?.size ?: 0
    PadKeys { key ->
        when (key) {
            KeyEvent.KEYCODE_BUTTON_X -> shown?.getOrNull(rows.at)?.let { if (it.fresh > 0) onTick(it.slug) }
            KeyEvent.KEYCODE_BUTTON_Y -> onSearch()
            KeyEvent.KEYCODE_BUTTON_START -> if (!pick.isEmpty) onReview()
            KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_PAGE_UP -> scope.launch { rows.page(-1, count) }
            KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_DOWN -> scope.launch { rows.page(1, count) }
            else -> return@PadKeys false
        }
        true
    }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BrowseBar(stringResource(R.string.browse), rows, onBack) {
            if (!denied) {
                SearchButton(rows, onSearch)
                OwnedChip(showAll, rows, onShowAll)
            }
        }
        when {
            denied -> BrowseNote(stringResource(R.string.browse_denied), Warn)
            failure != null -> BrowseFailure(failure)
            systems == null -> BrowseSection(stringResource(R.string.browse_contacting), busy = true)
            systems.isEmpty() -> BrowseNote(stringResource(R.string.browse_empty))
            else -> {
                val fresh = systems.count { it.fresh > 0 }
                BrowseSection(
                    if (showAll) pluralStringResource(R.plurals.browse_section_systems_all, shown!!.size, shown.size)
                    else pluralStringResource(R.plurals.browse_section_systems, fresh, fresh),
                    hint = stringResource(R.string.browse_keys_systems),
                )
                if (shown!!.isEmpty()) BrowseNote(stringResource(R.string.browse_all_here))
            }
        }
        if (!denied && failure == null && !shown.isNullOrEmpty()) {
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list) {
                items(shown.size) { i ->
                    val s = shown[i]
                    val right = if (s.fresh > 0) stringResource(R.string.browse_system_new, s.fresh, size(context, s.newBytes)) else stringResource(R.string.browse_here)
                    BrowseRow(
                        i, rows, s.name, sub = if (showAll && s.here > 0 && s.fresh > 0) stringResource(R.string.browse_here_count, s.here) else null,
                        tick = tickOf(pick.state(s.slug)), right = right, dim = s.fresh == 0,
                        onTick = { onTick(s.slug) }.takeIf { s.fresh > 0 },
                    ) { onOpen(s, i) }
                }
            }
            // The cursor starts on the first row (or the system just left), and the keyboard stays closed
            LaunchedEffect(Unit) { rows.at = start.coerceIn(0, count - 1); rows.focus(rows.at) }
            RefocusOnKeys(rows, count)
        } else Spacer(Modifier.weight(1f))
        BrowseFooter(pick, systems.orEmpty(), stringResource(R.string.browse_hint_systems), rows, onReview)
    }
}

/**
 * One system's games (SYSTEM null: every system, searched), paged; the bar's search filters on the server as typed.
 * Only the latest query's answer shows. A ticks, Y searches, L1/R1 page, START reviews, B closes the search first
 */
@Composable
internal fun BrowseGames(
    store: Store, system: SyncEngine.BrowseSystem?, searchFirst: Boolean, known: List<SyncEngine.BrowseSystem>, text: String,
    onText: (String) -> Unit, pick: SyncEngine.BrowsePick, showAll: Boolean, onShowAll: () -> Unit, onBack: () -> Unit,
    onToggle: (SyncEngine.BrowseGame) -> Unit, onReview: () -> Unit, onDenied: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    val rows = remember { RowFocus(list) }
    val field = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var applied by remember { mutableStateOf(text.trim()) }
    var games by remember { mutableStateOf(emptyList<SyncEngine.BrowseGame>()) }
    var total by remember { mutableIntStateOf(-1) }
    var loading by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<Pair<String, String>?>(null) }
    // Bumped by every new query: answers to an older one (first page or next) are dropped
    var gen by remember { mutableIntStateOf(0) }
    var focusResults by remember { mutableStateOf(!searchFirst) }
    // Searching every system has nothing to show without the field; a system's list opens it on demand
    var open by remember { mutableStateOf(system == null || searchFirst || text.isNotBlank()) }
    var focusField by remember { mutableIntStateOf(if (searchFirst) 1 else 0) }
    var editing by remember { mutableStateOf(searchFirst) }

    fun load(first: Boolean) {
        val g = if (first) ++gen else gen
        val offset = if (first) 0 else games.size
        val q = applied
        loading = true
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseGames(system?.slug, q, offset, all = showAll) } }
            if (g != gen) return@launch
            loading = false
            r.onSuccess { p ->
                games = if (first) p.games else games + p.games
                total = p.total
            }.onFailure { e -> if (e is SyncEngine.BrowseDenied) onDenied() else failure = Failure.describe(context, store, e) }
        }
    }

    fun searchNow() {
        applied = text.trim()
        keyboard?.hide()
        editing = false
        focusResults = true
    }

    fun openSearch() {
        open = true
        editing = true
        focusField++
    }

    fun closeSearch() {
        if (system == null) return onBack()
        keyboard?.hide()
        editing = false
        onText("")
        applied = ""
        open = false
        focusResults = true
    }

    BackHandler(enabled = open && system != null) { closeSearch() }
    LaunchedEffect(text) {
        if (text.trim() == applied) return@LaunchedEffect
        delay(SEARCH_DEBOUNCE)
        applied = text.trim()
    }
    LaunchedEffect(applied, showAll) {
        games = emptyList()
        total = -1
        failure = null
        runCatching { list.scrollToItem(0) }
        load(true)
    }
    // The next page, before the cursor reaches the end
    LaunchedEffect(list) {
        snapshotFlow {
            val last = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            games.isNotEmpty() && games.size < total && last >= games.size - 10 && !loading && failure == null
        }.collect { if (it) load(false) }
    }
    LaunchedEffect(games.isNotEmpty(), focusResults) {
        if (focusResults && games.isNotEmpty()) {
            focusResults = false
            rows.focus(0)
        }
    }
    // The field exists once composed open
    LaunchedEffect(focusField) {
        if (focusField == 0) return@LaunchedEffect
        withFrameNanos { }
        runCatching { field.requestFocus() }
        keyboard?.show()
    }

    PadKeys { key ->
        when (key) {
            KeyEvent.KEYCODE_BUTTON_Y -> openSearch()
            KeyEvent.KEYCODE_BUTTON_START -> if (!pick.isEmpty) onReview()
            KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_PAGE_UP -> scope.launch { rows.page(-1, games.size) }
            KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_DOWN -> scope.launch { rows.page(1, games.size) }
            else -> return@PadKeys false
        }
        true
    }

    RefocusOnKeys(rows, games.size)
    // Searched before the systems arrived (or they could not be fetched): asked here, for the systems' names
    var fetched by remember { mutableStateOf<List<SyncEngine.BrowseSystem>?>(null) }
    LaunchedEffect(known.isEmpty()) {
        if (known.isEmpty() && fetched == null) fetched = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseSystems() }.getOrNull() }
    }
    val names = remember(known, fetched) { known.ifEmpty { fetched.orEmpty() }.associate { it.slug to it.name } }
    val title = system?.name ?: stringResource(R.string.browse_all_systems)
    // Typed but not searched yet, or the first page on its way: the spinner says the server is being asked
    val waiting = text.trim() != applied || (loading && games.isEmpty())
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BrowseBar(title, rows, onBack) {
            if (open) {
                SearchField(
                    text, onText, if (system == null) stringResource(R.string.browse_search_all) else stringResource(R.string.browse_search_in, system.name),
                    busy = waiting || loading, field = field, rows = rows, editing = editing, onEdit = { openSearch() },
                    onLeave = { editing = false; keyboard?.hide() }, onSubmit = { searchNow() }, onClose = { closeSearch() },
                )
            } else {
                SearchButton(rows) { openSearch() }
                OwnedChip(showAll, rows, onShowAll)
            }
        }
        val section = when {
            failure != null -> null
            waiting -> stringResource(if (applied.isEmpty() && text.isBlank()) R.string.browse_contacting else R.string.browse_searching)
            total >= 0 && applied.isNotEmpty() -> pluralStringResource(R.plurals.browse_section_results, total, total)
            total >= 0 -> pluralStringResource(R.plurals.browse_section_games, total, total)
            else -> null
        }
        if (section != null) BrowseSection(section, busy = waiting, hint = stringResource(R.string.browse_keys_games))
        failure?.let { BrowseFailure(it) }
        if (!waiting && failure == null && total == 0) {
            BrowseNote(
                when {
                    applied.isNotEmpty() -> stringResource(R.string.browse_no_match, applied)
                    showAll -> stringResource(R.string.browse_empty)
                    else -> stringResource(R.string.browse_all_here)
                },
            )
        }
        // Faded while typed and not searched yet: those games are not the answer
        LazyColumn(Modifier.weight(1f).fillMaxWidth().alpha(if (text.trim() != applied) 0.35f else 1f), state = list) {
            items(games.size + if (games.isNotEmpty() && games.size < total) 1 else 0) { i ->
                if (i >= games.size) {
                    Text(stringResource(R.string.browse_loading), color = Dim, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                    return@items
                }
                val g = games[i]
                val open = g.state == "new"
                BrowseRow(
                    i, rows, g.title, sub = if (system == null) names[g.system] ?: g.system else null,
                    tick = when { g.state == "here" -> "✓"; !open -> "↓"; pick.ticked(g) -> "☑"; else -> "☐" },
                    tickColor = when (g.state) { "here" -> Done; "queued" -> Accent; else -> null },
                    right = when (g.state) {
                        "here" -> stringResource(R.string.browse_here)
                        "queued" -> stringResource(R.string.browse_queued)
                        else -> size(context, g.bytes)
                    },
                    dim = !open, onTick = { onToggle(g) }.takeIf { open },
                ) { if (open) onToggle(g) }
            }
        }
        BrowseFooter(pick, known, stringResource(R.string.browse_hint_games), rows, onReview)
    }
}

/**
 * The server's check of the selection: what downloads and the space it leaves, or why nothing does. True when it
 * can go ahead
 */
@Composable
internal fun BrowseCheckLines(c: SyncEngine.BrowseCheck, pick: SyncEngine.BrowsePick, known: List<SyncEngine.BrowseSystem>): Boolean {
    val context = LocalContext.current
    val pending = @Composable { if (c.pending > 0) Text(stringResource(R.string.browse_pending, size(context, c.pending)), color = Dim, fontSize = 16.sp) }
    when {
        c.usable == null -> {
            Text(stringResource(R.string.browse_space_unknown), fontSize = 20.sp, color = Warn)
            return false
        }
        c.needGames == 0 && !c.nospace -> {
            Text(stringResource(R.string.browse_nothing), fontSize = 20.sp)
            return false
        }
        !c.fits || c.nospace -> {
            Text(stringResource(R.string.browse_nospace, size(context, c.needBytes), size(context, c.usable ?: 0L)), fontSize = 20.sp, color = Warn)
            pending()
            return false
        }
    }
    Text(stringResource(R.string.browse_review_ask, pluralStringResource(R.plurals.browse_games_count, c.needGames, c.needGames), size(context, c.needBytes)), fontSize = 20.sp)
    Text(stringResource(R.string.browse_usable, size(context, c.usable ?: 0L), size(context, c.free), size(context, c.kept)), color = Dim, fontSize = 16.sp)
    pending()
    for ((slug, skip) in pick.systems) {
        val s = known.firstOrNull { it.slug == slug } ?: continue
        Text(stringResource(R.string.browse_whole_system, s.name, (s.fresh - skip.size).coerceAtLeast(0)), color = Dim, fontSize = 15.sp)
    }
    if (c.have > 0) Text(pluralStringResource(R.plurals.browse_have, c.have, c.have), color = Dim, fontSize = 15.sp)
    if (c.needGames > LONG_GAMES || c.needBytes > LONG_BYTES) Text(stringResource(R.string.browse_long), color = Warn, fontSize = 15.sp)
    return true
}
