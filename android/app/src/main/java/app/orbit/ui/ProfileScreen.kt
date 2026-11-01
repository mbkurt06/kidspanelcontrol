package app.orbit.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
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
import java.io.ByteArrayOutputStream

private val AVATARS = listOf("🙂", "😎", "🦊", "🐼", "🐯", "🦄", "🚀", "⭐")

@Composable
fun OrbitAvatar(value: String?, modifier: Modifier = Modifier) {
    val image = remember(value) {
        value?.takeIf { it.startsWith("data:image") }?.substringAfter("base64,", "")?.let { encoded ->
            runCatching {
                val bytes = Base64.decode(encoded, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            }.getOrNull()
        }
    }
    if (image != null) Image(image, contentDescription = "Profil fotoğrafı", modifier = modifier.clip(CircleShape))
    else Box(modifier.clip(CircleShape).background(C.surface2), contentAlignment = androidx.compose.ui.Alignment.Center) { Text(value?.takeIf { !it.startsWith("data:image") } ?: "🙂", fontSize = 25.sp) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProfileScreen() {
    val context = LocalContext.current
    val live by Live.state.collectAsState()
    val rules = androidx.compose.runtime.remember(live.lastSync) { Store.rules() }
    val scope = rememberCoroutineScope()
    var name by remember(rules.profileNickname) { mutableStateOf(rules.profileNickname.orEmpty()) }
    var avatar by remember(rules.profileAvatar) { mutableStateOf(rules.profileAvatar ?: AVATARS.first()) }
    var message by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) runCatching {
            val source = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching
            val bitmap = BitmapFactory.decodeByteArray(source, 0, source.size) ?: return@runCatching
            val out = ByteArrayOutputStream()
            bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 72, out)
            avatar = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
    }
    val photo = remember(avatar) {
        avatar.substringAfter("base64,", "").takeIf { avatar.startsWith("data:image") }?.let { encoded ->
            runCatching { BitmapFactory.decodeByteArray(Base64.decode(encoded, Base64.DEFAULT), 0, Base64.decode(encoded, Base64.DEFAULT).size)?.asImageBitmap() }.getOrNull()
        }
    }
    Card {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (photo != null) Image(photo, contentDescription = "Profil fotoğrafı", modifier = Modifier.size(54.dp).clip(CircleShape)) else Text(avatar, fontSize = 44.sp)
            Column { Title(Store.childName.ifBlank { "Profil" }); Muted("Telefonundaki Orbit profili", 13) }
        }
        OutlinedButton(onClick = { photoPicker.launch("image/*") }) { Text("Profil fotoğrafı seç") }
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
