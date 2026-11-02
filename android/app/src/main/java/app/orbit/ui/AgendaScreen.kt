package app.orbit.ui

import android.app.DatePickerDialog
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
private val COMPACT_DATE = DateTimeFormatter.ofPattern("dd.MM.yyyy · EEE", java.util.Locale("tr", "TR"))
private fun dateText(value: String) = runCatching { LocalDate.parse(value.take(10)).format(DAY) + " " + LocalDate.parse(value.take(10)).format(WEEKDAY) }.getOrDefault(value)
private fun compactDateText(value: String) = runCatching { LocalDate.parse(value.take(10)).format(COMPACT_DATE) }.getOrDefault(value)
private fun enteredText(value: String) = runCatching { Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).toLocalDate().format(DAY) + " · " + Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5) }.getOrDefault(value.take(16))

@Composable
fun AgendaScreen() {
    val live by Live.state.collectAsState()
    val scope = rememberCoroutineScope()
    var form by remember { mutableStateOf(false) }
    var detail by remember { mutableStateOf<AgendaItem?>(null) }
    var items by remember(live.lastSync) { mutableStateOf(Agenda.current()) }

    val openItems = items.filter { it.status != "done" }
    val doneItems = items.filter { it.status == "done" }

    fun toggle(item: AgendaItem) {
        val nextDone = item.status != "done"
        val before = items
        items = items.map { if (it.id == item.id) it.copy(status = if (nextDone) "done" else "open") else it }
        scope.launch {
            val ok = withContext(Dispatchers.IO) { Agenda.setDone(item.id, nextDone) }
            if (!ok) items = before
            Live.syncRequested = true
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 76.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (items.isEmpty()) Card { Muted("Ajandada kayıt yok.") }
            for (item in openItems) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface).padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { toggle(item) }) { Text("☐", color = C.muted, fontSize = 27.sp) }
                    Column(Modifier.weight(1f).clickable { detail = item }.padding(start = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Muted(enteredText(item.enteredAt), 12)
                        Text(item.title, color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                        Muted("${dateText(item.dueDate)}${item.dueTime?.take(5)?.let { " · $it" } ?: ""}", 12)
                    }
                }
            }
            if (doneItems.isNotEmpty()) {
                Title("Tamamlananlar")
                for (item in doneItems) {
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface).padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = { toggle(item) }) { Text("☑", color = C.good, fontSize = 27.sp) }
                        Column(Modifier.weight(1f).clickable { detail = item }.padding(start = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Muted(enteredText(item.enteredAt), 12)
                            Text(item.title, color = C.muted, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                            Muted("${dateText(item.dueDate)}${item.dueTime?.take(5)?.let { " · $it" } ?: ""}", 12)
                        }
                    }
                }
            }
        }
        FloatingActionButton(onClick = { form = true }, shape = CircleShape, containerColor = C.accent, contentColor = C.text, modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp).size(56.dp)) { Text("+", fontSize = 24.sp) }
    }
    if (form) AgendaForm(onClose = { form = false })
    detail?.let { item -> AgendaDetail(item, onClose = { detail = null }, onDone = {
        toggle(item)
        detail = null
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
                DateSelector(dueDate) { dueDate = it }
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
private fun DateSelector(value: String, onChange: (String) -> Unit) {
    val context = LocalContext.current
    val date = runCatching { LocalDate.parse(value) }.getOrDefault(LocalDate.now())
    var mode by remember { mutableStateOf("calendar") }
    var wheel by remember { mutableStateOf(false) }
    var day by remember(value) { mutableStateOf(date.dayOfMonth.toString()) }
    var month by remember(value) { mutableStateOf(date.monthValue.toString()) }
    var year by remember(value) { mutableStateOf(date.year.toString()) }
    fun apply(d: Int, m: Int, y: Int) { runCatching { onChange(LocalDate.of(y, m, d).toString()) } }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = { mode = "write" }) { Text("Yaz") }
            OutlinedButton(onClick = { mode = "wheel" }) { Text("Kaydır") }
            OutlinedButton(onClick = { mode = "calendar"; DatePickerDialog(context, { _, y, m, d -> onChange("%04d-%02d-%02d".format(y, m + 1, d)) }, date.year, date.monthValue - 1, date.dayOfMonth).show() }) { Text("Takvim") }
        }
        when (mode) {
            "write" -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(day, { day = it.filter(Char::isDigit).take(2); if (day.length == 2) apply(day.toInt(), month.toIntOrNull() ?: 1, year.toIntOrNull() ?: date.year) }, label = { Text("Gün") }, singleLine = true, modifier = Modifier.weight(1f))
                OutlinedTextField(month, { month = it.filter(Char::isDigit).take(2); if (month.length == 2) apply(day.toIntOrNull() ?: 1, month.toInt(), year.toIntOrNull() ?: date.year) }, label = { Text("Ay") }, singleLine = true, modifier = Modifier.weight(1f))
                OutlinedTextField(year, { year = it.filter(Char::isDigit).take(4); if (year.length == 4) apply(day.toIntOrNull() ?: 1, month.toIntOrNull() ?: 1, year.toInt()) }, label = { Text("Yıl") }, singleLine = true, modifier = Modifier.weight(1.3f))
            }
            "wheel" -> {
                OutlinedButton(onClick = { wheel = true }) { Text(compactDateText(value)) }
                if (wheel) AlertDialog(
                    onDismissRequest = { wheel = false },
                    title = { Text("Tarihi kaydırarak seç") },
                    text = {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Column(Modifier.weight(1f).height(150.dp).verticalScroll(rememberScrollState())) { (1..31).forEach { d -> TextButton(onClick = { day = d.toString(); apply(d, month.toIntOrNull() ?: 1, year.toIntOrNull() ?: date.year) }) { Text("%02d".format(d)) } } }
                            Column(Modifier.weight(1.4f).height(150.dp).verticalScroll(rememberScrollState())) { (1..12).forEach { m -> TextButton(onClick = { month = m.toString(); apply(day.toIntOrNull() ?: 1, m, year.toIntOrNull() ?: date.year) }) { Text(m.toString()) } } }
                            Column(Modifier.weight(1.2f).height(150.dp).verticalScroll(rememberScrollState())) { (date.year - 10..date.year + 10).forEach { y -> TextButton(onClick = { year = y.toString(); apply(day.toIntOrNull() ?: 1, month.toIntOrNull() ?: 1, y) }) { Text(y.toString()) } } }
                        }
                    },
                    confirmButton = { TextButton(onClick = { wheel = false }) { Text("Tamam") } },
                )
            }
            else -> OutlinedButton(onClick = { DatePickerDialog(context, { _, y, m, d -> onChange("%04d-%02d-%02d".format(y, m + 1, d)) }, date.year, date.monthValue - 1, date.dayOfMonth).show() }) { Text(compactDateText(value)) }
        }
    }
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
