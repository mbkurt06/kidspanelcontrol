package app.orbit.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.AlarmSound
import app.orbit.data.SoundPlayer
import app.orbit.data.Sounds

/** Alarm sesi seç: telefonun alarm/zil sesleri ya da Müziklerim; dokununca kısa önizleme. Ses seviyesi ve yavaş yükselme. */
@Composable
fun AlarmSoundDialog(current: AlarmSound, reminder: Boolean = false, onDone: (AlarmSound) -> Unit, onCancel: () -> Unit) {
    val ctx = LocalContext.current
    val system = remember { Sounds.system(ctx) }
    val music = remember { Sounds.music() }
    val preview = remember { SoundPlayer(ctx) }
    var sel by remember { mutableStateOf(current) }
    var custom by remember { mutableStateOf(current.volume != null) }
    var vol by remember { mutableStateOf((current.volume ?: 70).toFloat()) }
    var playing by remember { mutableStateOf<String?>(null) }
    DisposableEffect(Unit) { onDispose { preview.stop() } }

    fun pick(uri: String?, title: String?) {
        sel = sel.copy(uri = uri, title = title)
        if (playing == (uri ?: "default")) { preview.stop(); playing = null; return }
        preview.start(uri, if (custom) vol.toInt() else null, ramp = false)
        playing = uri ?: "default"
    }

    @Composable
    fun Item(uri: String?, title: String) {
        val on = sel.uri == uri
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (on) C.surface2 else C.surface).clickable { pick(uri, if (uri == null) null else title) }.padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (on) "●" else "○", color = if (on) C.accent else C.muted)
            Text("  $title", color = C.text, modifier = Modifier.weight(1f))
            if (playing == (uri ?: "default")) Text("▶", color = C.accent)
        }
    }

    AlertDialog(
        onDismissRequest = { preview.stop(); onCancel() },
        title = { Text(if (reminder) "Hatırlatıcı sesi" else "Alarm sesi") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Item(null, "Varsayılan")
                    if (system.isNotEmpty()) Muted("TELEFONUN SESLERİ", 12)
                    for (s in system) Item(s.uri, s.title)
                    if (music.isNotEmpty()) Muted("MÜZİKLERİM", 12)
                    for (s in music) Item(s.uri, s.title)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(custom, { custom = it; if (!it) preview.stop() })
                    Text("Ses seviyesi: " + if (custom) "%${vol.toInt()}" else "telefonun ayarı", color = C.text, fontSize = 14.sp)
                }
                if (custom) Slider(
                    value = vol, onValueChange = { vol = it; if (playing != null) preview.setVolume(it.toInt()) }, valueRange = 5f..100f,
                    colors = SliderDefaults.colors(thumbColor = C.accent, activeTrackColor = C.accent),
                )
                if (!reminder) Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(sel.ramp, { sel = sel.copy(ramp = it) })
                    Text("Yavaş yükselsin (30 sn'de tam ses)", color = C.text, fontSize = 14.sp)
                }
            }
        },
        dismissButton = { TextButton(onClick = { preview.stop(); onCancel() }) { Text("Vazgeç") } },
        confirmButton = { TextButton(onClick = { preview.stop(); onDone(sel.copy(volume = if (custom) vol.toInt() else null)) }) { Text("Tamam") } },
    )
}
