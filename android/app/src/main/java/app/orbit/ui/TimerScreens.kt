package app.orbit.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.AlarmDef
import app.orbit.data.Alarms
import app.orbit.data.Timers
import app.orbit.data.TimerSession
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.LocalTime

private fun clock(sec: Long): String {
    val h = sec / 3600
    val m = (sec % 3600) / 60
    val s = sec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

@Composable
private fun Chip(text: String, on: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.clip(RoundedCornerShape(16.dp))
            .background(if (on) C.accent else C.surface2)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
    ) { Text(text, color = if (on) Color.White else C.text, fontSize = 15.sp) }
}

/** Çalışan sayaç kartı (Bugün ekranında da gösterilir). */
@Composable
fun RunningTimerCard(s: TimerSession, compact: Boolean = false, onOpen: (() -> Unit)? = null) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(s.id, s.status) { while (true) { now = System.currentTimeMillis(); delay(1000) } }
    val focus = remember(s.focusId) { s.focusId?.let { Timers.profiles()[it] } }
    val left = s.remaining(now)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(C.surface)
            .then(if (onOpen != null) Modifier.clickable { onOpen() } else Modifier).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(s.icon ?: "⏱", fontSize = if (compact) 26.sp else 34.sp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(s.title, color = C.text, fontSize = if (compact) 17.sp else 22.sp, fontWeight = FontWeight.Bold)
                Muted(
                    listOfNotNull(
                        if (s.byParent) "ebeveynin başlattı" else null,
                        focus?.let { "${it.icon ?: "🎯"} ${it.name}" },
                        if (!s.running) "mola" else null,
                    ).joinToString(" · ").ifBlank { if (left != null) "geri sayım" else "kronometre" }, 13,
                )
            }
            Text(clock(left ?: s.elapsed(now)), color = if (s.running) C.text else C.warn, fontSize = if (compact) 22.sp else 40.sp, fontWeight = FontWeight.Bold)
        }
    }
}

// --- Sayaç ekranı -----------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TimerScreen() {
    val scope = rememberCoroutineScope()
    val live by Live.state.collectAsState()
    val remoteActive = remember(live.lastSync) { Timers.active() }
    var optimisticActive by remember { mutableStateOf<TimerSession?>(null) }
    LaunchedEffect(live.lastSync, remoteActive?.id) {
        if (remoteActive != null && optimisticActive?.id == "local") optimisticActive = null
    }
    val active = optimisticActive?.takeIf { it.active } ?: remoteActive
    val activities = remember(live.lastSync) { Timers.activities() }
    val profiles = remember(live.lastSync) { Timers.profiles() }
    var msg by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf<List<TimerSession>>(emptyList()) }
    LaunchedEffect(live.lastSync) { history = withContext(Dispatchers.IO) { Timers.today() } }

    fun act(label: String, f: () -> Boolean, onFailure: () -> Unit = {}) {
        busy = true; msg = ""
        scope.launch {
            val ok = withContext(Dispatchers.IO) { f() }
            busy = false
            if (!ok) onFailure()
            msg = if (ok) label else "Olmadı (internet ya da izin yok)"
            Live.syncRequested = true
        }
    }

    // Çocuk odak profili seçebilir mi: telefonu şu an kullanabiliyorsa (kilitli/kapalı saatte değilse)
    val s0 = live.snapshot
    val canPickFocus = s0 != null && !s0.locked && !(s0.sectionMode && s0.sectionClosed)

    Box(Modifier.fillMaxSize()) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 84.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
    if (active != null) {
        RunningTimerCard(active)
        val counts = Timers.currentCounts(active.id)
        val f = counts?.first ?: active.focusedSeconds
        val a = counts?.second ?: active.awaySeconds
        if (f + a > 60) Muted("Odaklı: ${f / 60} dk · başka şeylerle: ${a / 60} dk", 13)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (active.running && active.canPause) {
                OutlinedButton(onClick = {
                    optimisticActive = active.copy(status = "paused", pausedAt = System.currentTimeMillis())
                    act("Mola verildi", { Timers.pause(active) }) { optimisticActive = null }
                }, enabled = !busy) {
                    Text(if (active.byParent && active.pauseMode == "limit") "Mola (en fazla ${active.pauseMaxMinutes ?: 5} dk)" else "Mola")
                }
            }
            if (!active.running) Button(onClick = {
                optimisticActive = active.copy(status = "running", pausedAt = null)
                act("Devam", { Timers.resume(active) }) { optimisticActive = null }
            }, enabled = !busy, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Devam et") }
            if (active.canStop) {
                Button(onClick = {
                    optimisticActive = null
                    act("Kaydedildi 👍", { Timers.finish(active, "child", Timers.currentCounts(active.id)) })
                }, enabled = !busy, colors = ButtonDefaults.buttonColors(containerColor = C.good)) { Text("Bitir ve kaydet") }
            }
        }
        if (active.canStop) TextButton(onClick = { act("İptal edildi") { Timers.cancel(active, Timers.currentCounts(active.id)) } }, enabled = !busy) { Text("İptal et", color = C.bad) }
        else Muted("Bu sayacı ebeveynin başlattı; bitene kadar durdurulamaz.", 13)
        if (active.byParent && active.allowStop == "notify") Muted("Erken bitirirsen ebeveynine bildirilir.", 12)
        if (canPickFocus && active.canChangeFocus && profiles.isNotEmpty()) {
            Card {
                Title("Odak")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (!(active.byParent && active.focusChange == "stricter")) Chip("Serbest", active.focusId == null) { act("Odak kaldırıldı") { Timers.changeFocus(active, null) } }
                    for (p in profiles.values) Chip("${p.icon ?: "🎯"} ${p.name}", active.focusId == p.id) { act("Odak: ${p.name}") { Timers.changeFocus(active, p.id) } }
                }
            }
        }
    } else if (creating) {
        var activity by remember { mutableStateOf<String?>(null) }
        var title by remember { mutableStateOf("") }
        var minutes by remember { mutableStateOf<Int?>(25) }
        var focus by remember { mutableStateOf<String?>(null) }
        Card {
            Title("Ne yapacaksın?")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (a in activities) Chip("${a.icon ?: ""} ${a.name}".trim(), activity == a.id) {
                activity = a.id; title = a.name; if (canPickFocus) focus = a.defaultFocusId
                }
                Chip("✍️ Diğer", activity == "other") { activity = "other"; title = "" }
            }
            if (activity == "other") OutlinedTextField(title, { title = it.take(60) }, label = { Text("Adı") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        }
        Card {
            Title("Süre")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (m in listOf(15, 25, 30, 45, 60, 90)) Chip("$m dk", minutes == m) { minutes = m }
                Chip("⏱ Kronometre", minutes == null) { minutes = null }
            }
        }
        if (canPickFocus && profiles.isNotEmpty()) {
            Card {
                Title("Odak")
                Muted("Çalışırken telefonda sadece seçtiğin profildekiler açık kalır.", 13)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Chip("Serbest", focus == null) { focus = null }
                    for (p in profiles.values) Chip("${p.icon ?: "🎯"} ${p.name}", focus == p.id) { focus = p.id }
                }
            }
        }
        Button(
            onClick = {
                val a = activities.firstOrNull { it.id == activity }
                val sessionTitle = title.ifBlank { a?.name ?: "Çalışma" }
                val planned = minutes?.times(60)
                optimisticActive = TimerSession(
                    "local", sessionTitle, a?.icon, a?.id, if (planned != null) "countdown" else "stopwatch", planned,
                    if (canPickFocus) focus else null, "child", "yes", "child", null, "free", "running",
                    System.currentTimeMillis(), null, 0, 0, 0,
                )
                creating = false
                act("Başladı, kolay gelsin! 💪", { Timers.start(sessionTitle, a?.icon, a?.id, minutes, if (canPickFocus) focus else null) }) { optimisticActive = null }
            },
            enabled = !busy && activity != null && title.isNotBlank(),
            modifier = Modifier.fillMaxWidth().height(56.dp),
            colors = ButtonDefaults.buttonColors(containerColor = C.accent),
        ) { Text("Başlat", fontSize = 18.sp) }
    } else {
        Muted("Sayaç başlatmak için sağ alttaki + işaretine bas.", 14)
    }
    if (msg.isNotEmpty()) Text(msg, color = C.good)

    val done = history.filter { !it.active }
    if (done.isNotEmpty()) {
        Card {
            Title("Bugün")
            for (h in done) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(h.icon ?: "⏱", fontSize = 18.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(h.title, color = C.text, modifier = Modifier.weight(1f))
                    Muted(
                        "${(h.focusedSeconds + h.awaySeconds) / 60} dk · " + when (h.status) {
                            "done" -> "tamamlandı"; "stopped" -> "erken bitti"; "cancelled" -> "iptal"; else -> h.status
                        }, 13,
                    )
                }
            }
            Muted("Toplam: ${done.filter { it.status != "cancelled" }.sumOf { it.focusedSeconds + it.awaySeconds } / 60} dk", 13)
        }
    }
    }
    if (active == null) {
        FloatingActionButton(
            onClick = { creating = true },
            shape = CircleShape,
            containerColor = C.accent,
            contentColor = C.text,
            modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp).size(56.dp),
        ) { Text("+", fontSize = 24.sp) }
    }
    }
}

// --- Alarmlar ---------------------------------------------------------------

private val DAY_NAMES = listOf("Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz")

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AlarmsScreen() {
    val scope = rememberCoroutineScope()
    val live by Live.state.collectAsState()
    var list by remember(live.lastSync) { mutableStateOf(Alarms.list()) }
    var editing by remember { mutableStateOf<AlarmDef?>(null) }
    var creating by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf("") }

    fun run(label: String, f: () -> Boolean, onFailure: () -> Unit = {}) {
        scope.launch {
            val ok = withContext(Dispatchers.IO) { f() }
            if (!ok) onFailure()
            msg = if (ok) "" else "Olmadı (internet ya da izin yok)"
            if (ok) { editing = null; creating = false }
            Live.syncRequested = true
        }
    }

    if (creating || editing != null) {
        AlarmForm(editing, onCancel = { editing = null; creating = false }) { title, kind, time, days, date, active ->
            run("Kaydedildi") { Alarms.save(editing?.id, title, kind, time, days, date, active) }
        }
        return
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (msg.isNotEmpty()) Text(msg, color = C.bad)
            if (list.isEmpty()) Muted("Henüz alarm yok.")
            for (a in list) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(C.surface)
                        .then(if (a.editable) Modifier.clickable { editing = a } else Modifier).padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(a.time.toString().take(5), color = if (a.active) C.text else C.muted, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                        Text((if (a.kind == "alarm") "⏰ " else "🔔 ") + a.title, color = C.text)
                        Muted(
                            listOfNotNull(
                                if (a.days.isEmpty()) a.onDate?.let { if (it == LocalDate.now()) "bugün" else if (it == LocalDate.now().plusDays(1)) "yarın" else it.toString() } ?: "tek sefer"
                                else if (a.days.size == 7) "her gün" else a.days.sorted().joinToString(" ") { DAY_NAMES[it - 1] },
                                if (a.byParent) "ebeveynin kurdu" else null,
                                if (!a.editable) "değiştirilemez" else null,
                            ).joinToString(" · "), 12,
                        )
                    }
                    if (a.editable) Switch(
                        checked = a.active,
            onCheckedChange = { on ->
                val old = list
                list = list.map { if (it.id == a.id) it.copy(active = on) else it }
                run("", { Alarms.save(a.id, a.title, a.kind, a.time, a.days, a.onDate, on) }) { list = old }
            },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = C.text,
                            checkedTrackColor = C.accent,
                            uncheckedThumbColor = C.muted,
                            uncheckedTrackColor = C.surface2,
                            uncheckedBorderColor = C.line,
                        ),
                    )
                }
            }
        }
        FloatingActionButton(
            onClick = { creating = true },
            shape = CircleShape,
            containerColor = C.accent,
            contentColor = C.text,
            modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp).size(56.dp),
        ) { Text("+", fontSize = 24.sp) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AlarmForm(a: AlarmDef?, onCancel: () -> Unit, onSave: (String, String, LocalTime, Set<Int>, LocalDate?, Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf(a?.title ?: "") }
    var kind by remember { mutableStateOf(a?.kind ?: "alarm") }
    var hh by remember { mutableStateOf(a?.time?.hour ?: 7) }
    var mm by remember { mutableStateOf(a?.time?.minute ?: 0) }
    var days by remember { mutableStateOf(a?.days ?: emptySet()) }
    var tomorrow by remember { mutableStateOf(a?.onDate?.let { it != LocalDate.now() } ?: true) }
    var err by remember { mutableStateOf("") }

    Card {
        Title(if (a == null) "Yeni" else "Düzenle")
        OutlinedTextField(title, { title = it.take(60) }, label = { Text("Başlık") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Chip("⏰ Alarm", kind == "alarm") { kind = "alarm" }
            Chip("🔔 Hatırlatıcı", kind == "reminder") { kind = "reminder" }
        }
        // Saat: +/- düğmeleri
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
            Stepper("%02d".format(hh), { hh = (hh + 23) % 24 }, { hh = (hh + 1) % 24 })
            Text(":", color = C.text, fontSize = 36.sp, modifier = Modifier.padding(horizontal = 8.dp))
            Stepper("%02d".format(mm), { mm = (mm + 55) % 60 }, { mm = (mm + 5) % 60 })
        }
        Muted("Tekrar", 13)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (d in 1..7) Chip(DAY_NAMES[d - 1], d in days) { days = if (d in days) days - d else days + d }
        }
        if (days.isEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Chip("Bugün", !tomorrow) { tomorrow = false }
            Chip("Yarın", tomorrow) { tomorrow = true }
        }
        if (err.isNotEmpty()) Text(err, color = C.bad)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                val t = LocalTime.of(hh, mm)
                val date = if (days.isEmpty()) LocalDate.now().plusDays(if (tomorrow) 1 else 0) else null
                if (title.isBlank()) err = "Başlık yaz" else onSave(title, kind, t, days, date, a?.active ?: true)
            }, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Kaydet") }
            OutlinedButton(onClick = onCancel) { Text("Vazgeç") }
            if (a != null && a.deletable) TextButton(onClick = {
                scope.launch {
                    val ok = withContext(Dispatchers.IO) { Alarms.delete(a.id) }
                    if (ok) { Live.syncRequested = true; onCancel() } else err = "Silinemedi"
                }
            }) { Text("Sil", color = C.bad) }
        }
    }
}

@Composable
private fun Stepper(value: String, minus: () -> Unit, plus: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = plus).padding(horizontal = 18.dp, vertical = 4.dp)) { Text("▲", color = C.muted, fontSize = 20.sp) }
        Box(Modifier.clip(RoundedCornerShape(12.dp)).border(1.dp, C.line, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 6.dp)) {
            Text(value, color = C.text, fontSize = 40.sp, fontWeight = FontWeight.Bold)
        }
        Box(Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = minus).padding(horizontal = 18.dp, vertical = 4.dp)) { Text("▼", color = C.muted, fontSize = 20.sp) }
    }
}
