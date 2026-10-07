package com.rommancer.sync

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    // Bumped on resume so the storage permission screen updates after returning from Settings
    private val resumes = mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.fillMaxSize()) { App(resumes.intValue) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        resumes.intValue++
    }
}

@Composable
private fun App(resumes: Int) {
    val context = LocalContext.current
    val store = remember { Store(context) }
    var linked by remember { mutableStateOf(store.linked) }
    val canRead = remember(resumes) { Environment.isExternalStorageManager() }
    Column(
        Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Rommancer Sync", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
        when {
            !canRead -> StoragePermission()
            linked -> Linked(store) { linked = false }
            else -> Setup(store) { linked = true }
        }
    }
}

@Composable
private fun StoragePermission() {
    val context = LocalContext.current
    Text(stringResource(R.string.storage_title), style = MaterialTheme.typography.titleMedium)
    Text(stringResource(R.string.storage_text))
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
                    engine.sync()
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
                    null -> if (store.linked) e.message else msgBadServer
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
    var busy by remember { mutableStateOf(false) }
    var last by remember { mutableStateOf(store.lastResult) }
    Text(stringResource(R.string.connected, store.server, store.user ?: "?"))
    Text(stringResource(R.string.last_sync, last.ifBlank { stringResource(R.string.never) }), style = MaterialTheme.typography.bodySmall)
    Text(stringResource(R.string.background), style = MaterialTheme.typography.bodySmall)
    Button(enabled = !busy, onClick = {
        busy = true
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { SyncEngine(context, store).sync() } }
            last = r.fold({ store.lastResult }, { "${it.message}" })
            busy = false
        }
    }) { Text(stringResource(if (busy) R.string.syncing else R.string.sync_now)) }
    OutlinedButton(onClick = {
        SyncWorker.cancel(context)
        store.unlink()
        onUnlinked()
    }) { Text(stringResource(R.string.unlink)) }
}
