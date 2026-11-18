package app.orbit.ui

import android.app.Activity
import android.app.DatePickerDialog
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Grades
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.LocalDate
import java.time.ZoneId

private fun parseColor(s: String?): Color = runCatching { Color(android.graphics.Color.parseColor(s)) }.getOrDefault(C.muted)
private fun dShort(d: String) = "${d.substring(8, 10)}.${d.substring(5, 7)}"

/** Çocuğun not ekranı: not tablosu, düzeltilecek notlar, yeni not ekleme */
@Composable
fun GradesScreen() {
    val st by Grades.state.collectAsState()
    val live by Live.state.collectAsState()
    LaunchedEffect(live.lastSync) { withContext(Dispatchers.IO) { Grades.refresh() } }
    // Kaydedilebilir: Orbit arka planda yeniden açılsa da form açık kalır
    var formId by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf<String?>(null) }
    val form = formId?.let { id -> st.grades.firstOrNull { it.id == id } }
    var adding by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }

    if (adding || form != null) {
        GradeForm(st, form) { done ->
            adding = false
            formId = null
            if (done != null) msg = done
        }
        return
    }
    val lvl = st.level
    Card {
        Title("Notlarım")
        when {
            !st.loaded -> Muted("Yükleniyor…")
            lvl == null -> Muted("Ebeveynin henüz sınıfını seçmedi.")
            else -> Muted("$lvl. sınıf")
        }
        msg?.let { Text(it, color = C.good, fontSize = 14.sp) }
        if (lvl != null && st.subjects.any { it.level == lvl }) Button(
            onClick = { msg = null; adding = true },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = C.accent),
        ) { Text("+ Not ekle", fontWeight = FontWeight.SemiBold) }
        else if (lvl != null && st.loaded) Muted("Ebeveynin henüz ders eklemedi.")
    }
    val rejected = st.grades.filter { it.status == "rejected" }
    if (rejected.isNotEmpty()) Card {
        Title("Düzeltmen gerekenler")
        rejected.forEach { g ->
            val s = st.subjects.firstOrNull { it.id == g.subjectId }
            Row(Modifier.fillMaxWidth().clickable { formId = g.id }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${s?.name ?: "Ders"} · ${Grades.KIND_TEXT[g.kind]} · ${Grades.show(g.grade)}", color = C.text, fontWeight = FontWeight.SemiBold)
                    g.rejectNote?.let { Text("Ebeveynin: $it", color = C.warn, fontSize = 13.sp) }
                }
                Text("Düzelt", color = C.accent, fontWeight = FontWeight.SemiBold)
            }
        }
    }
    if (lvl != null) GradeTable(st, lvl) { if (it.status == "pending") formId = it.id }
}

@Composable
private fun GradeTable(st: Grades.State, lvl: Int, onTap: (Grades.Grade) -> Unit) {
    val subs = st.subjects.filter { it.level == lvl }
    if (subs.isEmpty()) return
    val gl = st.grades.filter { it.level == lvl && it.status != "rejected" }
    val cols = Grades.KINDS.map { k -> k to (subs.maxOfOrNull { s -> gl.count { it.subjectId == s.id && it.kind == k } } ?: 0) }.filter { it.second > 0 }
    Card {
        Title("Not tablosu")
        if (cols.isEmpty()) { Muted("Henüz not yok."); return@Card }
        val cell = 40.dp
        Row {
            // Dersler solda sabit
            Column {
                Spacer(Modifier.padding(vertical = 2.dp)); Text("", fontSize = 12.sp); Text("", fontSize = 11.sp)
                subs.forEach { s ->
                    Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(parseColor(s.color)))
                        Text(" ${s.name}", color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1)
                    }
                }
            }
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()).padding(start = 8.dp)) {
                cols.forEach { (k, n) ->
                    Column {
                        Spacer(Modifier.padding(vertical = 2.dp))
                        Text(Grades.KIND_TEXT[k] ?: k, color = C.muted, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.width(cell * n))
                        Row { (1..n).forEach { Text("$it", color = C.muted, fontSize = 11.sp, textAlign = TextAlign.Center, modifier = Modifier.width(cell)) } }
                        subs.forEach { s ->
                            val xs = gl.filter { it.subjectId == s.id && it.kind == k }
                            Row(Modifier.padding(vertical = 8.dp)) {
                                (0 until n).forEach { i ->
                                    val g = xs.getOrNull(i)
                                    Box(Modifier.width(cell), contentAlignment = Alignment.Center) {
                                        if (g == null) Text("·", color = C.muted, fontSize = 14.sp)
                                        else Text(
                                            Grades.show(g.grade),
                                            color = if (g.status == "pending") C.warn else C.text,
                                            fontSize = 14.sp,
                                            modifier = Modifier.clickable { onTap(g) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Ortalama sağda sabit
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.padding(vertical = 2.dp)); Text("Ort.", color = C.muted, fontSize = 12.sp); Text("", fontSize = 11.sp)
                subs.forEach { s ->
                    val a = Grades.average(gl.filter { it.subjectId == s.id }, s.weights)
                    Text(
                        a?.let { "%.1f".format(it).replace('.', ',') } ?: "—",
                        color = if (a != null && a >= 3.5) C.warn else C.text, fontWeight = FontWeight.Bold, fontSize = 14.sp,
                        modifier = Modifier.padding(vertical = 8.dp, horizontal = 4.dp),
                    )
                }
            }
        }
        if (gl.any { it.status == "pending" }) Muted("Turuncu notlar onay bekliyor, ortalamaya girmez.", 12)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GradeForm(st: Grades.State, edit: Grades.Grade?, onClose: (String?) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val lvl = edit?.level ?: st.level ?: return
    val subs = st.subjects.filter { it.level == lvl }
    val today = LocalDate.now(ZoneId.of("Europe/Berlin"))
    HoldUi()
    // Alanlar kaydedilebilir: kamera dönüşünde ya da Orbit yeniden açıldığında yazılanlar kaybolmaz
    var subject by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(edit?.subjectId) }
    var kind by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(edit?.kind) }
    var digit by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(edit?.grade?.take(1)?.toIntOrNull()) }
    var mod by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(edit?.grade?.let { if (it.length == 3) "ara" else it.drop(1) } ?: "") }
    var dateText by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf((edit?.takenOn?.let { LocalDate.parse(it) } ?: today).toString()) }
    val date = LocalDate.parse(dateText)
    var note by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(edit?.note ?: "") }
    var photoList by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    val photos: List<String> = photoList
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val ps = res.data?.getStringArrayListExtra("paths") ?: return@rememberLauncherForActivityResult
        photoList = ArrayList(photoList + ps)
    }

    @Composable
    fun chip(text: String, on: Boolean, color: Color = C.accent, click: () -> Unit) = Box(
        Modifier.clip(RoundedCornerShape(50)).background(if (on) color else Color.Transparent)
            .border(1.dp, if (on) color else C.line, RoundedCornerShape(50)).clickable(onClick = click).padding(horizontal = 14.dp, vertical = 8.dp),
    ) { Text(text, color = if (on) Color.White else C.text, fontSize = 15.sp) }

    Card {
        Title(if (edit != null) "Notu düzelt" else "Not ekle")
        edit?.rejectNote?.let { Text("Ebeveynin: $it", color = C.warn, fontSize = 14.sp) }
        Muted("Ders", 13)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            subs.forEach { s -> chip(s.name, subject == s.id, parseColor(s.color)) { subject = s.id } }
        }
        Muted("Tür", 13)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Grades.KINDS.forEach { k -> chip(Grades.KIND_TEXT[k] ?: k, kind == k) { kind = k } }
        }
        Muted("Not", 13)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            (1..6).forEach { d -> Box(Modifier.weight(1f)) { chip("$d", digit == d) { digit = d; if (d == 6 && mod == "ara") mod = "" } } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            chip("+", mod == "+") { mod = "+" }
            chip("tam", mod == "") { mod = "" }
            chip("−", mod == "-") { mod = "-" }
            // Ara not: 1–2, 2–3 … (6 için yok)
            chip(digit?.takeIf { it < 6 }?.let { "$it–${it + 1}" } ?: "ara", mod == "ara") { if ((digit ?: 1) < 6) mod = "ara" }
            digit?.let { Text("  →  ${Grades.show(gradeText(it, mod))}", color = C.text, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.align(Alignment.CenterVertically)) }
        }
        Muted("Tarih", 13)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            chip("Bugün", date == today) { dateText = today.toString() }
            chip("Dün", date == today.minusDays(1)) { dateText = today.minusDays(1).toString() }
            chip(if (date != today && date != today.minusDays(1)) "%02d.%02d.%d".format(date.dayOfMonth, date.monthValue, date.year) else "Tarih seç…", date != today && date != today.minusDays(1)) {
                DatePickerDialog(ctx, { _, y, m, d -> dateText = LocalDate.of(y, m + 1, d).toString() }, date.year, date.monthValue - 1, date.dayOfMonth).apply {
                    datePicker.maxDate = System.currentTimeMillis()
                }.show()
            }
        }
        OutlinedTextField(note, { note = it.take(200) }, label = { Text("Konu / not (isteğe bağlı)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedButton(
            onClick = {
                launcher.launch(Intent(ctx, CaptureActivity::class.java).putExtra("media", "photo").putExtra("title", "Sınav kâğıdı").putExtra("minPhotos", 1).putExtra("maxPhotos", 20))
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (photos.isEmpty()) "📷 Kâğıdın fotoğrafını çek" else "📷 ${photos.size} sayfa · sayfa ekle", color = C.text) }
        if (edit != null && edit.photos.isNotEmpty()) Muted("Önceden ${edit.photos.size} sayfa gönderilmişti; yenileri eklenir.", 12)
        err?.let { Text(it, color = C.bad, fontSize = 14.sp) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { photos.forEach { File(it).delete() }; onClose(null) }, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Vazgeç", color = C.text) }
            Button(
                onClick = {
                    val s = subs.firstOrNull { it.id == subject }
                    val k = kind
                    val d = digit
                    when {
                        s == null -> { err = "Dersi seç"; return@Button }
                        k == null -> { err = "Türü seç"; return@Button }
                        d == null -> { err = "Notu seç"; return@Button }
                    }
                    err = null
                    busy = true
                    scope.launch {
                        val r = withContext(Dispatchers.IO) {
                            runCatching {
                                val start = (edit?.photos?.size ?: 0) + 1
                                val paths = photos.mapIndexed { i, p ->
                                    val f = File(p)
                                    Grades.uploadPhoto(f.readBytes(), lvl, s!!.name, date.toString(), k!!, start + i).also { f.delete() }
                                }
                                Grades.save(edit?.id, s!!.id, k!!, gradeText(d, mod), date.toString(), note.trim().ifBlank { null }, paths)
                                Grades.refresh()
                            }
                        }
                        busy = false
                        if (r.isSuccess) onClose("Not gönderildi, ebeveynin onayı bekleniyor")
                        else err = "Gönderilemedi: ${r.exceptionOrNull()?.message?.take(120) ?: "internet?"}"
                    }
                },
                enabled = !busy,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = C.accent),
            ) { Text(if (busy) "Gönderiliyor…" else "Gönder", fontWeight = FontWeight.SemiBold) }
        }
    }
}

/** Seçilen rakam + ek → kayıt metni: "2", "2+", "2-", ara not "2-3" */
private fun gradeText(d: Int, mod: String): String = if (mod == "ara") (if (d < 6) "$d-${d + 1}" else "$d") else "$d$mod"
