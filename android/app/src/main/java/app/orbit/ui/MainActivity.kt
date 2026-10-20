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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        paired = Store.creds != null
        setContent {
            OrbitTheme {
                Column(Modifier.fillMaxSize().background(C.bg).safeDrawingPadding()) {
                    if (paired) HomeScreen() else PairScreen(onPaired = {
                        paired = true
                        OrbitService.start(this@MainActivity)
                    })
                }
            }
        }
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HomeScreen() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val live by Live.state.collectAsState()
    val s = live.snapshot
    var msg by remember { mutableStateOf("") }
    var askOpen by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(Store.childName.ifBlank { "Orbit" }, color = C.text, fontSize = 26.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Muted(if (live.online) "bağlı" else "çevrimdışı", 12)
        }

        if (!Policy.hasUsageAccess(ctx)) {
            Card {
                Text("Kullanım erişimi gerekli", color = C.warn, fontWeight = FontWeight.SemiBold)
                Muted("Orbit'in süreyi sayabilmesi için bu izni bir ebeveyn açmalı.")
                OutlinedButton(onClick = {
                    runCatching { ctx.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }) { Text("Ayarı aç") }
            }
        }

        if (s == null) {
            Muted("Kurallar yükleniyor…")
            return@Column
        }

        Card {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val frac = if (s.allowanceMinutes > 0) s.remainingSeconds / (s.allowanceMinutes * 60f) else 0f
                Ring(frac, if (s.remainingSeconds > 600) C.blue else C.warn, 120.dp) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(minutesText(s.remainingSeconds / 60), color = C.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        Muted("kaldı", 12)
                    }
                }
                Spacer(Modifier.width(16.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Muted("Bugünkü hak: ${minutesText(s.allowanceMinutes.toLong())}")
                    Muted("Kullanılan: ${minutesText(s.usedMinutes.toLong())}")
                    if (s.extraMinutesToday != 0) Muted("Ekstra: ${minutesText(s.extraMinutesToday.toLong())}")
                    s.activeMode?.let { m ->
                        Text(
                            m.name + (s.modeEndsAt?.let { " · ${it.toString().take(5)}'e kadar" } ?: ""),
                            color = C.accent, fontWeight = FontWeight.SemiBold,
                        )
                        s.modeRemainingSeconds?.let { Muted("Durum süresi: ${minutesText(it / 60)}") }
                    }
                    if (s.locked) Text("Telefon kilitli", color = C.bad, fontWeight = FontWeight.SemiBold)
                }
            }
        }

        val tasks = remember(live.lastSync, live.snapshot?.now?.minute) { Tasks.current() }
        if (tasks.isNotEmpty() || Store.rulesJson != null) TasksCard(tasks)

        if (s.walletGrants.isNotEmpty()) {
            Card {
                Title("Süre cüzdanı")
                for (g in s.walletGrants) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(minutesText(g.minutes.toLong()), color = C.text, fontWeight = FontWeight.SemiBold)
                            Muted(listOfNotNull(g.note, g.expiresOn?.let { "son gün $it" }).joinToString(" · "), 12)
                        }
                        Button(onClick = {
                            scope.launch {
                                val ok = withContext(Dispatchers.IO) { Sync.activateGrant(g.id, s.day.toString()) }
                                msg = if (ok) "Süre bugüne eklendi" else "İnternet gerekli"
                                Live.syncRequested = true
                            }
                        }, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Bugün kullan") }
                    }
                }
            }
        }

        Card {
            Title("Şu an açık")
            if (live.allowedApps.isEmpty()) Muted("Şu an açık uygulama yok.")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((pkg, label) in live.allowedApps) AppTile(pkg, label) { launch(ctx, pkg) }
            }
        }

        Card {
            Title("Ebeveynden süre iste")
            if (!askOpen) {
                OutlinedButton(onClick = { askOpen = true }) { Text("Süre iste") }
            } else {
                OutlinedTextField(note, { note = it.take(120) }, label = { Text("Neden? (isteğe bağlı)") }, modifier = Modifier.fillMaxWidth())
                Button(onClick = {
                    scope.launch {
                        val ok = withContext(Dispatchers.IO) { Sync.event("time_request", JSONObject().put("note", note)) }
                        msg = if (ok) "İstek gönderildi" else "İnternet gerekli"
                        askOpen = false; note = ""
                    }
                }, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Gönder") }
            }
        }

        if (msg.isNotEmpty()) Text(msg, color = C.good)
        Spacer(Modifier.height(8.dp))
        Muted("Orbit ${BuildConfig.VERSION_NAME}${if (!Policy.isOwner(ctx)) " · cihaz sahibi değil" else ""}", 11)
    }
}
