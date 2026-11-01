package app.orbit.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.orbit.BuildConfig
import app.orbit.data.Api
import app.orbit.data.Store
import app.orbit.data.Sync
import app.orbit.data.Tasks
import app.orbit.device.Policy
import app.orbit.service.Live
import app.orbit.service.OrbitService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private var paired by mutableStateOf(false)
    /** Bildirimden ya da kilit ekranından gelen "şu ekranı aç" isteği */
    private var request by mutableStateOf<Pair<Screen, Long>?>(null)

    private fun readRequest(i: android.content.Intent?) {
        val s = i?.getStringExtra(app.orbit.data.Notifier.EXTRA_SCREEN) ?: return
        runCatching { Screen.valueOf(s) }.getOrNull()?.let { request = it to System.nanoTime() }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        readRequest(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        paired = Store.creds != null
        readRequest(intent)
        // Tam kilit: Orbit ekrana kilitlenir (cihaz sahibi izniyle, sabitleme sorusu çıkmadan)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                Live.state.collect { syncLockTask(it.kiosk != null) }
            }
        }
        setContent {
            OrbitTheme {
                Column(Modifier.fillMaxSize().background(C.bg).safeDrawingPadding()) {
                    if (paired) OrbitHome(request) else PairScreen(onPaired = {
                        paired = true
                        OrbitService.start(this@MainActivity)
                    })
                }
            }
        }
    }

    private fun syncLockTask(on: Boolean) {
        val am = getSystemService(android.app.ActivityManager::class.java)
        val inLock = am.lockTaskModeState != android.app.ActivityManager.LOCK_TASK_MODE_NONE
        if (on && !inLock) runCatching { startLockTask() }
        if (!on && inLock) runCatching { stopLockTask() }
    }

    override fun onResume() {
        super.onResume()
        if (Store.creds != null) {
            OrbitService.start(this)
            Live.syncRequested = true
        }
    }
}

@Composable
private fun PairScreen(onPaired: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf("") }
    val owner = Policy.isOwner(ctx)

    Column(
        Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Orbit", color = C.text, fontSize = 32.sp, fontWeight = FontWeight.Bold)
        Muted("Ebeveyn panelinde çocuğun sayfası → Telefon → \"Eşleştirme kodu al\". 8 haneli kodu buraya yaz.")
        OutlinedTextField(
            value = code,
            onValueChange = { v -> code = v.filter { it.isDigit() }.take(8) },
            label = { Text("Eşleştirme kodu") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
        if (err.isNotEmpty()) Text(err, color = C.bad)
        if (!owner) Text("Uyarı: Orbit bu telefonda cihaz sahibi değil. Uygulamalar kapatılamaz, sadece süre sayılır.", color = C.warn, fontSize = 13.sp)
        Button(
            onClick = {
                busy = true; err = ""
                scope.launch {
                    val res = withContext(Dispatchers.IO) {
                        runCatching {
                            Api.pair(code, "${Build.MANUFACTURER} ${Build.MODEL}", Build.VERSION.RELEASE, BuildConfig.VERSION_NAME, owner)
                        }
                    }
                    res.onSuccess { p ->
                        Store.creds = Store.Creds(p.deviceId, p.childId, p.familyId, p.email, p.password)
                        onPaired()
                    }.onFailure { err = it.message ?: "Bağlantı hatası" }
                    busy = false
                }
            },
            enabled = code.length == 8 && !busy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = C.accent),
        ) { Text(if (busy) "Eşleşiyor…" else "Eşleştir") }
        Muted("Orbit ${BuildConfig.VERSION_NAME}", 12)
    }
}
