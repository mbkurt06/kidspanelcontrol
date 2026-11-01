package app.orbit.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Kiosk
import app.orbit.data.Store
import app.orbit.data.Tasks
import app.orbit.engine.KioskNow
import app.orbit.service.Live
import java.time.Instant
import java.time.ZoneId

/** Tam kilitte açık olabilecek Orbit ekranları ve anahtarları */
fun Screen.kioskKey(): String = name.lowercase()

/** Tam kilit ana ekranı: saat, ebeveynin mesajı, bitiş ve izin verilen ekranlar. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KioskToday(k: KioskNow, open: (Screen) -> Unit) {
    val live by Live.state.collectAsState()
    val now = live.snapshot?.now
    var pin by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(now?.toString()?.take(5) ?: "", color = C.text, fontSize = 64.sp, fontWeight = FontWeight.Bold)
        Text("🔒 ${if (k.source == "manual") "Kilitli" else k.name}", color = C.accent, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        k.message?.let { Text(it, color = C.text, fontSize = 18.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 12.dp)) }
        Muted(
            k.untilMs?.let { "Bitiş: " + Instant.ofEpochMilli(it).atZone(ZoneId.of(Store.rules().timezone)).toLocalTime().toString().take(5) }
                ?: "Ebeveynin kaldırana kadar",
            14,
        )
    }
    val tasks = remember(live.lastSync) { Tasks.current().count { it.open } }
    val tiles = Screen.entries.filter { it != Screen.TODAY && it != Screen.ABOUT && it.kioskKey() in k.screens }
    if (tiles.isNotEmpty()) {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (s in tiles) {
                Column(
                    Modifier.width(100.dp).clip(RoundedCornerShape(18.dp)).background(C.surface).clickable { open(s) }.padding(vertical = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(s.icon, fontSize = 28.sp)
                    Text(s.title, color = C.text, fontSize = 13.sp, textAlign = TextAlign.Center)
                    if (s == Screen.TASKS && tasks > 0) Text("$tasks açık", color = C.warn, fontSize = 11.sp)
                }
            }
        }
    }
    if (Store.rules().pinHash != null) {
        Text(
            "🔐 Ebeveyn",
            color = C.muted,
            fontSize = 14.sp,
            modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable { pin = true }.padding(12.dp),
        )
    }
    if (pin) PinDialog { pin = false }
}

/** Ebeveyn PIN'i: doğruysa 15 dk boyunca tam kilit ve sınırlamalar kalkar. */
@Composable
fun PinDialog(onClose: () -> Unit) {
    var code by remember { mutableStateOf("") }
    var err by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Ebeveyn PIN'i") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = code,
                    onValueChange = { v -> code = v.filter { it.isDigit() }.take(8); err = "" },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                )
                if (err.isNotEmpty()) Text(err, color = C.bad, fontSize = 13.sp)
                Muted("Doğru PIN ile ${Store.rules().pinMinutes} dakika boyunca bütün kısıtlamalar kalkar (ayarlar dahil).", 12)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (Kiosk.tryPin(code)) {
                    Live.syncRequested = true
                    onClose()
                } else {
                    val w = Kiosk.waitMs()
                    err = if (w > 0) "Çok fazla yanlış deneme. ${(w / 60_000) + 1} dk sonra tekrar dene." else "PIN yanlış"
                    code = ""
                }
            }) { Text("Aç") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Vazgeç") } },
    )
}
