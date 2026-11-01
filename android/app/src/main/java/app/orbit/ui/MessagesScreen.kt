package app.orbit.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Messages
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val QUICK = listOf("Beni alır mısın?", "Eve vardım 🏠", "Beni ara 📞", "Tamam 👍", "Seni seviyorum ❤️")

/** Ebeveynle yazışma: baloncuklu sohbet, hızlı mesajlar. Telefon kilitli/kapalı saatlerde de çalışır. */
@Composable
fun MessagesScreen() {
    val scope = rememberCoroutineScope()
    val list by Messages.list.collectAsState()
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf("") }

    DisposableEffect(Unit) {
        Messages.screenOpen = true
        onDispose { Messages.screenOpen = false }
    }
    LaunchedEffect(list.size) {
        withContext(Dispatchers.IO) { Messages.refresh(); Messages.markRead() }
    }

    fun send(body: String) {
        if (body.isBlank() || busy) return
        busy = true; err = ""
        scope.launch {
            val ok = withContext(Dispatchers.IO) { Messages.send(body) }
            busy = false
            if (ok) text = "" else err = "Gönderilemedi, internet bağlantısını kontrol et"
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            reverseLayout = true,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (list.isEmpty()) item {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    Muted("Henüz mesaj yok. Ebeveynine buradan yazabilirsin.")
                }
            }
            items(list.reversed(), key = { it.id }) { m -> Bubble(m) }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (q in QUICK) {
                Box(
                    Modifier.clip(RoundedCornerShape(16.dp)).background(C.surface2).clickable(enabled = !busy) { send(q) }.padding(horizontal = 12.dp, vertical = 8.dp),
                ) { Text(q, color = C.text, fontSize = 14.sp) }
            }
        }
        if (err.isNotEmpty()) Text(err, color = C.bad, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp))
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                text, { text = it.take(1000) },
                placeholder = { Text("Mesaj yaz") },
                modifier = Modifier.weight(1f),
                maxLines = 4,
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = { send(text) },
                enabled = text.isNotBlank() && !busy,
                colors = ButtonDefaults.buttonColors(containerColor = C.accent),
            ) { Text("Gönder") }
        }
    }
}

@Composable
private fun Bubble(m: Messages.Msg) {
    val mine = !m.fromParent
    val time = remember(m.at) { SimpleDateFormat("d MMM HH:mm", Locale("tr")).format(Date(m.at)) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier.widthIn(max = 300.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (mine) C.accent else C.surface2)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            if (!mine) Text(m.sender ?: "Ebeveyn", color = C.warn, fontSize = 12.sp)
            Text(m.body, color = C.text, fontSize = 16.sp)
            Text(
                time + if (mine && m.read) " · görüldü" else "",
                color = if (mine) C.text.copy(alpha = 0.7f) else C.muted, fontSize = 11.sp,
                modifier = Modifier.align(Alignment.End),
            )
        }
    }
}
