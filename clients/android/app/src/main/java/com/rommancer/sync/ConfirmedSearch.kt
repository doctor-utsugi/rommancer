package com.rommancer.sync

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.input.ImeAction

internal class SearchSubmission { var accept: (() -> Unit)? = null }

@Composable
internal fun ConfirmedSearch(applied: String, label: String, requester: FocusRequester, submission: SearchSubmission, onAccept: (String) -> Unit) {
    var draft by remember(applied) { mutableStateOf(applied) }
    val submit = { onAccept(draft.trim()) }
    SideEffect { submission.accept = submit }
    DisposableEffect(submission) { onDispose { submission.accept = null; MainActivity.typing = false } }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(draft, { draft = it }, Modifier.weight(1f).focusRequester(requester).onFocusChanged { MainActivity.typing = it.isFocused },
            singleLine = true, label = { Text(label) }, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }))
        TextButton(onClick = submit) { Text("Accept") }
    }
}
