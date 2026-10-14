package com.rommancer.sync

import android.view.KeyEvent
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
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

/** Above this a download is said to take a long time */
private const val LONG_GAMES = 50
private const val LONG_BYTES = 2_000_000_000L

/** Takes the browse keys (X, Y, START, L1/R1 and the page keys) while the screen shows */
@Composable
private fun PadKeys(handler: (Int) -> Boolean) {
    val current by rememberUpdatedState(handler)
    DisposableEffect(Unit) {
        val h: (Int) -> Boolean = { current(it) }
        MainActivity.pad = h
        onDispose { if (MainActivity.pad === h) MainActivity.pad = null }
    }
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
 * One row of a browse list, one focus stop: TICK the box (tapped alone it calls ON_TICK, for touch), RIGHT a short
 * fact at the end, DIM for what cannot be picked
 */
@Composable
private fun BrowseRow(
    index: Int, rows: RowFocus, text: String, sub: String? = null, tick: String? = null, right: String? = null, dim: Boolean = false,
    onTick: (() -> Unit)? = null, onClick: () -> Unit,
) {
    val requester = remember { FocusRequester() }
    DisposableEffect(index) {
        rows.requesters[index] = requester
        onDispose { if (rows.requesters[index] === requester) rows.requesters.remove(index) }
    }
    var focused by remember { mutableStateOf(false) }
    val color = if (focused) Accent else if (dim) Dim else Color.White
    Row(
        Modifier
            .fillMaxWidth()
            .focusRequester(requester)
            .onFocusChanged { focused = it.isFocused; if (it.isFocused) rows.at = index }
            .border(2.dp, if (focused) Accent else Color.Transparent, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tick != null) {
            val tap = onTick?.let { t -> Modifier.pointerInput(t) { detectTapGestures { t() } } } ?: Modifier
            Text(tick, fontSize = 20.sp, color = color, modifier = tap.padding(end = 10.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(text, fontSize = 18.sp, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, fontSize = 14.sp, color = Dim, maxLines = 1)
        }
        if (right != null) Text(right, fontSize = 15.sp, color = Dim, modifier = Modifier.padding(start = 10.dp))
    }
}

private fun tickOf(state: Int) = when (state) { 2 -> "☑"; 1 -> "⊟"; else -> "☐" }

/** The selection with its rough size, which opens the review; the keys' hint under it */
@Composable
private fun ColumnScope.BrowseFooter(pick: SyncEngine.BrowsePick, known: List<SyncEngine.BrowseSystem>, hint: String, onReview: () -> Unit) {
    val context = LocalContext.current
    if (!pick.isEmpty) {
        val (n, bytes) = pick.count(known)
        TextButton(onClick = onReview, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp), modifier = Modifier.fillMaxWidth()) {
            Text(
                stringResource(R.string.browse_selected, pluralStringResource(R.plurals.browse_games_count, n, n), size(context, bytes)),
                fontSize = 17.sp, color = Accent, modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    Text(hint, fontSize = 13.sp, color = Dim, modifier = Modifier.padding(horizontal = 14.dp).align(Alignment.Start))
}

/** Could not reach the server, why, and what is behind it */
@Composable
private fun BrowseFailure(failure: Pair<String, String>) {
    Text(stringResource(R.string.browse_unreachable), fontSize = 18.sp, color = MaterialTheme.colorScheme.error)
    Text(failure.first, color = Dim, fontSize = 15.sp)
    Text(failure.second, color = Dim, fontSize = 12.sp)
}

/**
 * The systems the server can send: Search first, then each system with its tri-state tick. A opens a system, X
 * ticks it whole, Y searches every system, START reviews the selection. START is the row focused first
 */
@Composable
internal fun BrowseSystems(
    systems: List<SyncEngine.BrowseSystem>?, failure: Pair<String, String>?, denied: Boolean, pick: SyncEngine.BrowsePick, start: Int,
    onOpen: (SyncEngine.BrowseSystem, Int) -> Unit, onSearch: () -> Unit, onTick: (String) -> Unit, onReview: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    val rows = remember { RowFocus(list) }
    val count = 1 + (systems?.size ?: 0)
    PadKeys { key ->
        when (key) {
            KeyEvent.KEYCODE_BUTTON_X -> systems?.getOrNull(rows.at - 1)?.let { if (it.fresh > 0) onTick(it.slug) }
            KeyEvent.KEYCODE_BUTTON_Y -> onSearch()
            KeyEvent.KEYCODE_BUTTON_START -> if (!pick.isEmpty) onReview()
            KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_PAGE_UP -> scope.launch { rows.page(-1, count) }
            KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_DOWN -> scope.launch { rows.page(1, count) }
            else -> return@PadKeys false
        }
        true
    }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.browse), fontSize = 22.sp)
        when {
            denied -> Text(stringResource(R.string.browse_denied), fontSize = 18.sp, color = Warn)
            failure != null -> BrowseFailure(failure)
            systems == null -> Text(stringResource(R.string.browse_contacting), color = Dim)
            systems.isEmpty() -> Text(stringResource(R.string.browse_empty), color = Dim)
        }
        if (!denied && failure == null && systems?.isNotEmpty() == true) {
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list) {
                item { BrowseRow(0, rows, stringResource(R.string.browse_search_all), onClick = onSearch) }
                items(systems.size) { i ->
                    val s = systems[i]
                    val sub = listOf(pluralStringResource(R.plurals.browse_games_count, s.games, s.games), size(context, s.bytes)).joinToString(" · ") +
                        (if (s.here > 0) " · ${s.here} ${stringResource(R.string.browse_here)}" else "")
                    BrowseRow(
                        i + 1, rows, s.name, sub = sub, tick = tickOf(pick.state(s.slug)), dim = s.fresh == 0,
                        onTick = { if (s.fresh > 0) onTick(s.slug) }.takeIf { s.fresh > 0 },
                    ) { onOpen(s, i + 1) }
                }
            }
            // The cursor starts on the first row (or the system just left), and the keyboard stays closed
            LaunchedEffect(Unit) { rows.focus(start.coerceIn(0, count - 1)) }
        }
        BrowseFooter(pick, systems.orEmpty(), stringResource(R.string.browse_hint_systems), onReview)
    }
}

/**
 * One system's games (SYSTEM null: every system, searched), the search field on top. Loads page by page as the
 * cursor nears the end; only the answer to the latest query is shown. A ticks, Y goes to the search, L1/R1 page,
 * START reviews. SEARCH_FIRST opens with the field focused
 */
@Composable
internal fun BrowseGames(
    store: Store, system: SyncEngine.BrowseSystem?, searchFirst: Boolean, known: List<SyncEngine.BrowseSystem>, text: String,
    onText: (String) -> Unit, pick: SyncEngine.BrowsePick, onToggle: (SyncEngine.BrowseGame) -> Unit, onReview: () -> Unit, onDenied: () -> Unit,
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

    fun load(first: Boolean) {
        val g = if (first) ++gen else gen
        val offset = if (first) 0 else games.size
        val q = applied
        loading = true
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).browseGames(system?.slug, q, offset) } }
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
        focusResults = true
    }

    LaunchedEffect(text) {
        if (text.trim() == applied) return@LaunchedEffect
        delay(SEARCH_DEBOUNCE)
        applied = text.trim()
    }
    LaunchedEffect(applied) {
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
    LaunchedEffect(Unit) { if (searchFirst) runCatching { field.requestFocus() } }

    PadKeys { key ->
        when (key) {
            KeyEvent.KEYCODE_BUTTON_Y -> runCatching { field.requestFocus() }
            KeyEvent.KEYCODE_BUTTON_START -> if (!pick.isEmpty) onReview()
            KeyEvent.KEYCODE_BUTTON_L1, KeyEvent.KEYCODE_PAGE_UP -> scope.launch { rows.page(-1, games.size) }
            KeyEvent.KEYCODE_BUTTON_R1, KeyEvent.KEYCODE_PAGE_DOWN -> scope.launch { rows.page(1, games.size) }
            else -> return@PadKeys false
        }
        true
    }

    val names = remember(known) { known.associate { it.slug to it.name } }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(system?.name ?: stringResource(R.string.browse_all_systems), fontSize = 22.sp)
        OutlinedTextField(
            text, onText, Modifier.fillMaxWidth().focusRequester(field), singleLine = true,
            label = { Text(stringResource(R.string.browse_search)) },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { searchNow() }),
        )
        // What the list shows, said at once: the wait after typing reads as intended
        val status = when {
            failure != null -> null
            text.trim() != applied -> stringResource(R.string.browse_searching)
            loading && games.isEmpty() -> stringResource(if (applied.isEmpty()) R.string.browse_contacting else R.string.browse_searching)
            total == 0 && applied.isNotEmpty() -> stringResource(R.string.browse_no_match, applied)
            total == 0 -> stringResource(R.string.browse_empty)
            total > 0 && applied.isNotEmpty() -> pluralStringResource(R.plurals.browse_games_match, total, total)
            total > 0 -> pluralStringResource(R.plurals.browse_games_count, total, total)
            else -> null
        }
        if (status != null) Text(status, color = Dim, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 4.dp))
        failure?.let { BrowseFailure(it) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list) {
            items(games.size + if (games.isNotEmpty() && games.size < total) 1 else 0) { i ->
                if (i >= games.size) {
                    Text(stringResource(R.string.browse_loading), color = Dim, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp))
                    return@items
                }
                val g = games[i]
                val open = g.state == "new"
                val right = when (g.state) {
                    "here" -> stringResource(R.string.browse_here)
                    "queued" -> stringResource(R.string.browse_queued)
                    else -> size(context, g.bytes)
                }
                BrowseRow(
                    i, rows, g.title, sub = if (system == null) names[g.system] ?: g.system else null,
                    tick = if (!open) "·" else if (pick.ticked(g)) "☑" else "☐", right = right, dim = !open,
                    onTick = { onToggle(g) }.takeIf { open },
                ) { if (open) onToggle(g) }
            }
        }
        BrowseFooter(pick, known, stringResource(R.string.browse_hint_games), onReview)
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

