package app.orbit.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Plan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.TextStyle
import java.util.Locale

private val TR = Locale("tr")
private val DAYS = listOf("Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz")

private fun dayTitle(d: LocalDate, today: LocalDate): String {
    val base = "${d.dayOfWeek.getDisplayName(TextStyle.SHORT, TR)} ${d.dayOfMonth} ${d.month.getDisplayName(TextStyle.SHORT, TR)}"
    return when (d) {
        today -> "Bugün · $base"
        today.plusDays(1) -> "Yarın · $base"
        today.minusDays(1) -> "Dün · $base"
        else -> base
    }
}

/** Planım: çocuğun kendi yapılacakları; saat ve hatırlatmayı kendisi ayarlar. */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun PlanScreen() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        Plan.init(ctx)
        withContext(Dispatchers.IO) { Plan.refresh() }
    }
    val st by Plan.state.collectAsState()
    val today = remember { Plan.today() }
    var day by remember { mutableStateOf(today) }
    var edit by remember { mutableStateOf<Plan.Item?>(null) }
    var adding by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf<Plan.Item?>(null) }
    var cats by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    val list = st.forDay(day)
    val done = list.count { st.isDone(it, day) }

    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable { day = day.minusDays(1) }.padding(10.dp)) { Text("‹", color = C.text, fontSize = 24.sp) }
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(dayTitle(day, today), color = C.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                if (list.isNotEmpty()) Muted("$done / ${list.size} tamam", 13)
            }
            Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable { day = day.plusDays(1) }.padding(10.dp)) { Text("›", color = C.text, fontSize = 24.sp) }
        }
        if (day != today) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text("Bugüne dön", color = C.accent, fontSize = 13.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { day = today }.padding(6.dp))
        }
    }

    Card {
        if (!st.loaded) Muted("Yükleniyor…")
        else if (list.isEmpty()) Muted("Bu gün için plan yok. ＋ Ekle ile başla.")
        for (i in list) {
            val ok = st.isDone(i, day)
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                    .combinedClickable(onClick = { edit = i }, onLongClick = { menu = i })
                    .padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(ok, { Plan.setDone(i, day, it) }, colors = CheckboxDefaults.colors(checkedColor = C.good, uncheckedColor = C.muted))
                Text(i.at?.toString()?.take(5) ?: " —  ", color = if (ok) C.muted else C.text, fontSize = 15.sp, modifier = Modifier.width(52.dp))
                Text(i.emoji ?: "📌", fontSize = 18.sp)
                Spacer(Modifier.width(8.dp))
                Text(
                    i.title, color = if (ok) C.muted else C.text, fontSize = 16.sp,
                    textDecoration = if (ok) TextDecoration.LineThrough else null, modifier = Modifier.weight(1f),
                )
                if (i.remind && i.at != null) Text("🔔", fontSize = 13.sp)
                if (i.repeat != "none") Text("🔁", fontSize = 13.sp)
            }
        }
    }

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Button(onClick = { adding = true }, colors = ButtonDefaults.buttonColors(containerColor = C.accent), modifier = Modifier.weight(1f)) { Text("＋ Ekle") }
        OutlinedButton(onClick = {
            val n = Plan.copyDay(day.minusDays(1), day)
            note = if (n == 0) "Kopyalanacak yeni madde yok" else "$n madde kopyalandı"
        }, modifier = Modifier.weight(1f)) { Text("Önceki günü kopyala") }
    }
    if (note.isNotEmpty()) Muted(note, 13)
    Text("Kategoriler", color = C.muted, fontSize = 13.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { cats = true }.padding(6.dp))
    Info("Dokun: düzenle · basılı tut: sil. Saatli maddelerde hatırlatmayı açarsan o saatte bildirim gelir.")

    if (adding || edit != null) PlanItemDialog(edit, day, st.allCategories, onClose = { adding = false; edit = null }) {
        Plan.save(it)
        adding = false; edit = null
    }
    menu?.let { m ->
        AlertDialog(
            onDismissRequest = { menu = null },
            title = { Text(m.title) },
            text = { Muted(if (m.repeat != "none") "Bu madde tekrarlıyor." else "Silinsin mi?") },
            confirmButton = {
                Column(horizontalAlignment = Alignment.End) {
                    if (m.repeat != "none") TextButton(onClick = { Plan.delete(m, day); menu = null }) { Text("Sadece bu gün") }
                    TextButton(onClick = { Plan.delete(m, null); menu = null }) { Text(if (m.repeat != "none") "Tümünü sil" else "Sil", color = C.bad) }
                }
            },
            dismissButton = { TextButton(onClick = { menu = null }) { Text("Vazgeç") } },
        )
    }
    if (cats) CategoriesDialog(st.categories) { cats = false }
    LaunchedEffect(st.items.size) { scope.launch(Dispatchers.IO) { Plan.flush() } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlanItemDialog(item: Plan.Item?, day: LocalDate, categories: List<Plan.Category>, onClose: () -> Unit, onSave: (Plan.Item) -> Unit) {
    var title by remember { mutableStateOf(item?.title ?: "") }
    var cat by remember { mutableStateOf(categories.firstOrNull { it.name == item?.category }) }
    var hasTime by remember { mutableStateOf(item?.at != null) }
    var hh by remember { mutableStateOf(item?.at?.hour ?: LocalTime.now().plusHours(1).hour) }
    var mm by remember { mutableStateOf(item?.at?.minute?.let { it - it % 5 } ?: 0) }
    var remind by remember { mutableStateOf(item?.remind ?: true) }
    var before by remember { mutableStateOf(item?.remindBefore ?: 0) }
    var repeat by remember { mutableStateOf(item?.repeat ?: "none") }
    var rdays by remember { mutableStateOf(item?.repeatDays ?: setOf(day.dayOfWeek.value)) }
    var err by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (item == null) "Yeni madde" else "Düzenle") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(title, { title = it.take(80); err = "" }, label = { Text("Ne yapacaksın?") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Muted("Kategori", 13)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (c in categories) PChip("${c.emoji} ${c.name}", cat?.name == c.name) { cat = if (cat?.name == c.name) null else c }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Saat", color = C.text, modifier = Modifier.weight(1f))
                    Switch(hasTime, { hasTime = it })
                }
                if (hasTime) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                        PStep("%02d".format(hh), { hh = (hh + 23) % 24 }, { hh = (hh + 1) % 24 })
                        Text(":", color = C.text, fontSize = 28.sp, modifier = Modifier.padding(horizontal = 6.dp))
                        PStep("%02d".format(mm), { mm = (mm + 55) % 60 }, { mm = (mm + 5) % 60 })
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("🔔 Hatırlat", color = C.text, modifier = Modifier.weight(1f))
                        Switch(remind, { remind = it })
                    }
                    if (remind) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (b in Plan.BEFORE) PChip(if (b == 0) "Tam saatinde" else "$b dk önce", before == b) { before = b }
                    }
                }
                Muted("Tekrar", 13)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((k, l) in Plan.REPEATS) PChip(l, repeat == k) { repeat = k }
                }
                if (repeat == "days") FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (d in 1..7) PChip(DAYS[d - 1], d in rdays) { rdays = if (d in rdays) rdays - d else rdays + d }
                }
                if (err.isNotEmpty()) Text(err, color = C.bad, fontSize = 13.sp)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                when {
                    title.isBlank() -> err = "Bir şey yaz"
                    repeat == "days" && rdays.isEmpty() -> err = "En az bir gün seç"
                    else -> {
                        val base = item ?: Plan.newItem(day, title.trim())
                        onSave(base.copy(
                            title = title.trim(), category = cat?.name, emoji = cat?.emoji,
                            at = if (hasTime) LocalTime.of(hh, mm) else null, remind = hasTime && remind, remindBefore = if (hasTime && remind) before else 0,
                            repeat = repeat, repeatDays = if (repeat == "days") rdays else emptySet(),
                        ))
                    }
                }
            }) { Text("Kaydet") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("Vazgeç") } },
    )
}

@Composable
private fun CategoriesDialog(own: List<Plan.Category>, onClose: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var emoji by remember { mutableStateOf("⭐") }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Kategoriler") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Muted(Plan.DEFAULTS.joinToString("  ") { "${it.emoji} ${it.name}" }, 13)
                for (c in own) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${c.emoji} ${c.name}", color = C.text, modifier = Modifier.weight(1f))
                    TextButton(onClick = { c.id?.let { Plan.deleteCategory(it) } }) { Text("Sil", color = C.bad) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(emoji, { emoji = it.take(4) }, label = { Text("Emoji") }, singleLine = true, modifier = Modifier.width(80.dp))
                    OutlinedTextField(name, { name = it.take(24) }, label = { Text("Ad") }, singleLine = true, modifier = Modifier.weight(1f))
                }
                TextButton(onClick = { if (name.isNotBlank()) { Plan.addCategory(name, emoji); name = "" } }) { Text("＋ Kategori ekle") }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Tamam") } },
    )
}

@Composable
private fun PChip(text: String, on: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(16.dp)).background(if (on) C.accent else C.surface2).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 7.dp),
    ) { Text(text, color = C.text, fontSize = 13.sp) }
}

@Composable
private fun PStep(value: String, minus: () -> Unit, plus: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.clip(RoundedCornerShape(10.dp)).clickable(onClick = plus).padding(horizontal = 14.dp, vertical = 2.dp)) { Text("▲", color = C.muted, fontSize = 16.sp) }
        Box(Modifier.clip(RoundedCornerShape(10.dp)).border(1.dp, C.line, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 4.dp)) {
            Text(value, color = C.text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
        }
        Box(Modifier.clip(RoundedCornerShape(10.dp)).clickable(onClick = minus).padding(horizontal = 14.dp, vertical = 2.dp)) { Text("▼", color = C.muted, fontSize = 16.sp) }
    }
}
