package app.orbit.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Sync
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Kapalı bir uygulama açılınca gelen ekran: neden kapalı, ne zaman açılır, şu an neler açık. */
class LockActivity : ComponentActivity() {
    private var reason by mutableStateOf("")
    private var pkg by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        read(intent)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                goHome(this@LockActivity)
                finish()
            }
        })
        setContent { OrbitTheme { LockScreen(reason, pkg) { goHome(this); finish() } } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        read(intent)
    }

    private fun read(i: Intent) {
        reason = i.getStringExtra("reason") ?: "Bu uygulama şu an kapalı"
        pkg = i.getStringExtra("pkg")
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LockScreen(reason: String, pkg: String?, onHome: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val live by Live.state.collectAsState()
    var sent by remember { mutableStateOf(false) }
    val label = pkg?.let { p -> runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(p, 0)).toString() }.getOrNull() }

    Column(
        Modifier.fillMaxSize().background(C.bg).safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        if (pkg != null) AppIcon(pkg, 64.dp)
        Text(label ?: "Uygulama", color = C.muted, fontSize = 16.sp)
        Text(reason, color = C.text, fontSize = 24.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        live.snapshot?.let { s ->
            val sub = when {
                s.locked && s.lockUntil != null -> "Kilit ${java.time.Instant.ofEpochMilli(s.lockUntil).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5)}'te açılır"
                s.activeMode != null && s.modeEndsAt != null -> "${s.activeMode.name} ${s.modeEndsAt.toString().take(5)}'te biter"
                s.section != null -> "${s.section.section.name} ${s.section.endsAt.toString().take(5)}'te biter" +
                    (if (s.remainingSeconds in 1 until app.orbit.engine.UNLIMITED_SECONDS) " · kalan süren ${minutesText(s.remainingSeconds / 60)}" else "")
                s.remainingSeconds in 1 until app.orbit.engine.UNLIMITED_SECONDS -> "Kalan süren: ${minutesText(s.remainingSeconds / 60)}"
                else -> null
            }
            sub?.let { Muted(it, 15) }
        }
        if (live.allowedApps.isNotEmpty()) {
            Card {
                Title("Şu an açık olanlar")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for ((p, l) in live.allowedApps) AppTile(p, l) { launch(ctx, p) }
                }
            }
        }
        Button(
            onClick = {
                scope.launch {
                    sent = withContext(Dispatchers.IO) {
                        Sync.event("time_request", JSONObject().put("package", pkg ?: "").put("label", label ?: "").put("note", reason))
                    }
                }
            },
            enabled = !sent,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            colors = ButtonDefaults.buttonColors(containerColor = C.accent),
        ) { Text(if (sent) "İstek gönderildi" else "Ebeveynden süre iste") }
        if (reason.startsWith("Önce görevini yap")) {
            Button(
                onClick = { ctx.startActivity(android.content.Intent(ctx, MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = C.blue),
            ) { Text("Görevlerime git") }
        }
        OutlinedButton(onClick = onHome, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Ana ekrana dön") }
    }
}
