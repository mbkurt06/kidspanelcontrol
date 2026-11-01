package app.orbit.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Api
import app.orbit.data.Store
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

private val AVATARS = listOf("🙂", "😎", "🦊", "🐼", "🐯", "🦄", "🚀", "⭐")

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProfileScreen() {
    val live by Live.state.collectAsState()
    val rules = androidx.compose.runtime.remember(live.lastSync) { Store.rules() }
    val scope = rememberCoroutineScope()
    var name by remember(rules.profileNickname) { mutableStateOf(rules.profileNickname.orEmpty()) }
    var avatar by remember(rules.profileAvatar) { mutableStateOf(rules.profileAvatar ?: AVATARS.first()) }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    Card {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(avatar, fontSize = 44.sp)
            Column { Title(Store.childName.ifBlank { "Profil" }); Muted("Telefonundaki Orbit profili", 13) }
        }
        OutlinedTextField(name, { name = it.take(60) }, label = { Text("İsim veya takma ad") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AVATARS.forEach { a -> Chip(a, avatar == a) { avatar = a } }
        }
        Button(enabled = !busy, onClick = {
            busy = true
            scope.launch {
                val ok = withContext(Dispatchers.IO) { runCatching { val c = Store.creds ?: return@runCatching false; Api.patch("children?id=eq.${c.childId}", JSONObject().put("profile_nickname", name.trim().ifBlank { JSONObject.NULL }).put("profile_avatar", avatar)); true }.getOrDefault(false) }
                busy = false
                message = if (ok) "Profil kaydedildi." else "Profil kaydedilemedi; internet bağlantısını kontrol et."
                if (ok) Live.syncRequested = true
            }
        }) { Text(if (busy) "Kaydediliyor…" else "Kaydet") }
        if (message.isNotBlank()) Text(message, color = C.good, fontSize = 13.sp)
    }
}

@Composable
private fun Chip(text: String, on: Boolean, click: () -> Unit) {
    androidx.compose.material3.OutlinedButton(onClick = click) { Text(if (on) "✓ $text" else text) }
}
