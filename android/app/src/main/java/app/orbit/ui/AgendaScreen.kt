package app.orbit.ui

import android.app.DatePickerDialog
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Agenda
import app.orbit.data.AgendaItem
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter

private val DAY = DateTimeFormatter.ofPattern("dd.MM.yyyy")
private val WEEKDAY = DateTimeFormatter.ofPattern("EEEE", java.util.Locale("tr", "TR"))
private fun dateText(value: String) = runCatching { LocalDate.parse(value.take(10)).format(DAY) + " " + LocalDate.parse(value.take(10)).format(WEEKDAY) }.getOrDefault(value)
private fun enteredText(value: String) = runCatching { Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).toLocalDate().format(DAY) + " · " + Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5) }.getOrDefault(value.take(16))

@Composable
fun AgendaScreen() {
    val live by Live.state.collectAsState()
    val scope = rememberCoroutineScope()
    var form by remember { mutableStateOf(false) }
    var detail by remember { mutableStateOf<AgendaItem?>(null) }
    val items = remember(live.lastSync) { Agenda.current() }

    Card {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Title("Ajanda")
            IconButton(onClick = { form = true }, modifier = Modifier.size(44.dp)) { Text("＋", color = C.accent, fontSize = 26.sp) }
        }
    }
    if (items.isEmpty()) Card { Muted("Ajandada kayıt yok.") }
    for (item in items) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface).clickable { detail = item }.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val done = item.status == "done"
            Text(if (done) "☑" else "☐", color = if (done) C.good else C.muted, fontSize = 27.sp)
            Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Muted(enteredText(item.enteredAt), 12)
                Text(item.title, color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                Muted("${dateText(item.dueDate)}${item.dueTime?.take(5)?.let { " · $it" } ?: ""}", 12)
            }
        }
    }
    if (form) AgendaForm(onClose = { form = false })
    detail?.let { item -> AgendaDetail(item, onClose = { detail = null }, onDone = {
        scope.launch { withContext(Dispatchers.IO) { Agenda.setDone(item.id, item.status != "done") }; detail = null; Live.syncRequested = true }
    }) }
}

@Composable
private fun AgendaForm(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var dueDate by remember { mutableStateOf(LocalDate.now().toString()) }
    var dueTime by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var extra by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Ajandaya ekle") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(title, { title = it.take(160); error = "" }, label = { Text("Başlık") }, singleLine = true)
                DateButton(dueDate) { dueDate = it }
                OutlinedButton(onClick = { extra = !extra }) { Text("⌄") }
                if (extra) {
                    OutlinedTextField(dueTime, { dueTime = it.take(5) }, label = { Text("Saat") }, singleLine = true)
                    OutlinedTextField(note, { note = it.take(500) }, label = { Text("Açıklama") }, singleLine = true)
                }
                if (error.isNotBlank()) Text(error, color = C.bad, fontSize = 12.sp)
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("İptal") } },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                if (title.isBlank()) { error = "Başlık gerekli."; return@TextButton }
                busy = true
                scope.launch {
                    val ok = withContext(Dispatchers.IO) { Agenda.create("event", title.trim(), note.trim().ifBlank { null }, dueDate, dueTime.trim().ifBlank { null }, null, "EUR") }
                    if (ok) { Live.syncRequested = true; onClose() } else { busy = false; error = "Eklenemedi; internet bağlantısını kontrol et." }
                }
            }) { Text(if (busy) "Ekleniyor…" else "Ekle") }
        },
    )
}

@Composable
private fun DateButton(value: String, onChange: (String) -> Unit) {
    val context = LocalContext.current
    val date = runCatching { LocalDate.parse(value) }.getOrDefault(LocalDate.now())
    OutlinedButton(onClick = { DatePickerDialog(context, { _, y, m, d -> onChange("%04d-%02d-%02d".format(y, m + 1, d)) }, date.year, date.monthValue - 1, date.dayOfMonth).show() }) { Text(dateText(value)) }
}

@Composable
private fun AgendaDetail(item: AgendaItem, onClose: () -> Unit, onDone: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(item.title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Muted(enteredText(item.enteredAt), 13)
                Muted("${dateText(item.dueDate)}${item.dueTime?.take(5)?.let { " · $it" } ?: ""}", 13)
                item.note?.let { Text(it, color = C.text, fontSize = 14.sp) }
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Kapat") } },
        confirmButton = { TextButton(onClick = onDone) { Text(if (item.status == "done") "Açık yap" else "Tamamlandı") } },
    )
}
