package app.orbit.ui

import android.app.DatePickerDialog
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import androidx.compose.ui.Modifier
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
import java.util.Locale

private val DAY = DateTimeFormatter.ofPattern("dd.MM.yyyy")
private val TYPES = listOf("homework" to "📚 Ödev", "exam" to "📝 Sınav", "payment" to "💶 Ödeme", "event" to "📅 Program")

private fun dayText(value: String) = runCatching { LocalDate.parse(value.take(10)).format(DAY) }.getOrDefault(value)
private fun enteredText(value: String) = runCatching { Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).toLocalDate().format(DAY) }.getOrDefault(value.take(10))

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AgendaScreen() {
    val live by Live.state.collectAsState()
    val scope = rememberCoroutineScope()
    var form by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    val items = remember(live.lastSync) { Agenda.current() }

    Card {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Title("Ajanda")
            Button(onClick = { form = true }) { Text("+ Ekle") }
        }
        Muted("Ödev, sınav, ödeme ve programlar. Çocuk eklediği kaydı silemez.", 13)
        if (message.isNotBlank()) Text(message, color = C.good, fontSize = 13.sp)
    }

    if (items.isEmpty()) Card { Muted("Ajandada kayıt yok.") }
    for (item in items) {
        Card {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("${TYPES.firstOrNull { it.first == item.kind }?.second ?: "📌"} · ${item.title}", color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    Muted("Girildi: ${enteredText(item.enteredAt)}", 12)
                    Muted("Son tarih: ${dayText(item.dueDate)}${item.dueTime?.take(5)?.let { " · $it" } ?: ""}", 12)
                    item.note?.let { Muted(it, 13) }
                    if (item.kind == "payment" && item.amount != null) Text("${item.amount} ${item.currency}", color = C.warn, fontSize = 13.sp)
                }
                Button(onClick = {
                    val done = item.status != "done"
                    scope.launch {
                        val ok = withContext(Dispatchers.IO) { Agenda.setDone(item.id, done) }
                        message = if (ok) "Güncellendi." else "Güncellenemedi; internet bağlantısını kontrol et."
                        if (ok) Live.syncRequested = true
                    }
                }) { Text(if (item.status == "done") "Açık yap" else "Tamamlandı") }
            }
        }
    }

    if (form) AgendaForm(
        onClose = { form = false },
        onSaved = {
            form = false
            message = "Ajandaya eklendi."
            Live.syncRequested = true
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AgendaForm(onClose: () -> Unit, onSaved: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf("homework") }
    var title by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var dueDate by remember { mutableStateOf(LocalDate.now().toString()) }
    var dueTime by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var currency by remember { mutableStateOf("EUR") }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Ajandaya ekle") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((value, label) in TYPES) OutlinedButton(onClick = { kind = value }) { Text(if (kind == value) "✓ $label" else label, fontSize = 12.sp) }
                }
                OutlinedTextField(title, { title = it.take(160); error = "" }, label = { Text("Başlık") }, singleLine = true)
                OutlinedTextField(note, { note = it.take(500) }, label = { Text("Not (isteğe bağlı)") }, singleLine = true)
                DateButton(dueDate) { dueDate = it }
                OutlinedTextField(dueTime, { dueTime = it.take(5) }, label = { Text("Saat (isteğe bağlı, ör. 15:00)") }, singleLine = true)
                if (kind == "payment") {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(amount, { amount = it.take(10) }, label = { Text("Tutar") }, modifier = Modifier.weight(1f), singleLine = true)
                        OutlinedTextField(currency, { currency = it.take(3).uppercase(Locale.ROOT) }, label = { Text("Para") }, modifier = Modifier.weight(1f), singleLine = true)
                    }
                }
                if (error.isNotBlank()) Text(error, color = C.bad, fontSize = 12.sp)
            }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("İptal") } },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                val parsedDate = runCatching { LocalDate.parse(dueDate) }.getOrNull()
                val parsedAmount = amount.trim().replace(',', '.').takeIf { it.isNotBlank() }?.toDoubleOrNull()
                when {
                    title.isBlank() -> error = "Başlık gerekli."
                    parsedDate == null -> error = "Tarih geçersiz."
                    amount.isNotBlank() && parsedAmount == null -> error = "Tutar geçersiz."
                    else -> {
                        busy = true
                        scope.launch {
                            val ok = withContext(Dispatchers.IO) {
                                Agenda.create(kind, title.trim(), note.trim().ifBlank { null }, dueDate, dueTime.trim().ifBlank { null }, if (kind == "payment") parsedAmount else null, currency.ifBlank { "EUR" })
                            }
                            if (ok) onSaved() else { busy = false; error = "Eklenemedi; internet bağlantısını kontrol et." }
                        }
                    }
                }
            }) { Text(if (busy) "Ekleniyor…" else "Ekle") }
        },
    )
}

@Composable
private fun DateButton(value: String, onChange: (String) -> Unit) {
    val context = LocalContext.current
    val date = runCatching { LocalDate.parse(value) }.getOrDefault(LocalDate.now())
    OutlinedButton(onClick = {
        DatePickerDialog(context, { _, year, month, day -> onChange("%04d-%02d-%02d".format(year, month + 1, day)) }, date.year, date.monthValue - 1, date.dayOfMonth).show()
    }) { Text("Son tarih: ${dayText(value)}") }
}
