package app.orbit.ui

import android.speech.tts.TextToSpeech
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.VCard
import app.orbit.data.VDeck
import app.orbit.data.VResult
import app.orbit.data.VState
import app.orbit.data.Vocab
import app.orbit.engine.SecRule
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.abs

/** 📚 Kelime kartları: desteler, çalışma (kaydır: sağ biliyorum, sol bilmiyorum), ekleme, ayarlar */
@Composable
fun VocabScreen() {
    val scope = rememberCoroutineScope()
    val state by Vocab.state.collectAsState()
    val live by Live.state.collectAsState()
    var note by remember { mutableStateOf<String?>(null) }
    var page by remember { mutableStateOf("home") } // home | study | study:<deck> | deck:<id>
    LaunchedEffect(Unit) {
        Vocab.cached()
        note = withContext(Dispatchers.IO) { Vocab.load() }
    }
    val s = state
    if (s == null) {
        Card { Column(Modifier.padding(16.dp)) { Title("📚 Kelime kartları"); Muted(note ?: "Yükleniyor…") } }
        return
    }
    // Kapalı saatte: ebeveyn izin vermediyse kapalı
    val closedNow = live.snapshot?.section?.section?.defaultRule == SecRule.BLOCKED
    if (closedNow && !s.settings.allowClosed) {
        Card { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Title("📚 Kelime kartları")
            Muted("Kelime kartları kapalı saatlerde kullanılamıyor (ebeveyn ayarı).")
        } }
        return
    }
    when {
        page == "study" || page.startsWith("study:") -> StudySession(s, page.removePrefix("study").removePrefix(":").ifEmpty { null }) { page = "home" }
        page.startsWith("deck:") -> {
            val d = s.decks.firstOrNull { it.id == page.removePrefix("deck:") }
            if (d == null) page = "home" else DeckDetail(s, d, onBack = { page = "home" }, onStudy = { page = "study:${d.id}" })
        }
        else -> VocabHome(s, note, onStudy = { page = "study" }, onDeck = { page = "deck:$it" }, onReload = { scope.launch { note = withContext(Dispatchers.IO) { Vocab.load() } } })
    }
}

private fun counts(cards: List<VCard>) = Triple(cards.count { it.isNew }, cards.count { !it.isNew && !it.learned }, cards.count { it.learned })

@Composable
private fun VocabHome(s: VState, note: String?, onStudy: () -> Unit, onDeck: (String) -> Unit, onReload: () -> Unit) {
    val scope = rememberCoroutineScope()
    var newDeck by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    val session = remember(s) { Vocab.buildSession(s) }
    Card {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Title("📚 Kelime kartları")
                Spacer(Modifier.weight(1f))
                TextButton(onClick = { settings = true }) { Text("⚙ Ayarlar") }
            }
            Text("Bugün ${s.doneToday} / ${s.settings.dailyGoal} kart", color = C.text, fontSize = 15.sp)
            LinearProgressIndicator(progress = { (s.doneToday.toFloat() / s.settings.dailyGoal.coerceAtLeast(1)).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth(), color = C.good)
            note?.let { Muted(it, 12) }
            if (session.isNotEmpty()) Button(
                onClick = onStudy, modifier = Modifier.fillMaxWidth().height(54.dp),
                colors = ButtonDefaults.buttonColors(containerColor = C.accent),
            ) { Text("▶ Çalış (${session.size} kart)", fontSize = 17.sp) }
            else Muted(if (s.decks.none { it.study }) "Çalışmak için aşağıdan bir desteyi çalışma alanına ekle ya da yeni deste oluştur." else "Bugün tekrar edilecek kart yok 🎉 Bir desteye girip tekrar çalışabilirsin.")
        }
    }
    val mine = s.decks.filter { it.study }
    val others = s.decks.filter { !it.study }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Title("Çalışma alanım")
        Spacer(Modifier.weight(1f))
        TextButton(onClick = { newDeck = true }) { Text("+ Yeni deste") }
    }
    if (mine.isEmpty()) Muted("Henüz deste yok.")
    for (d in mine) DeckRow(d) { onDeck(d.id) }
    if (others.isNotEmpty()) {
        Title("Diğer desteler")
        Muted("Kardeşinin ya da ebeveyninin eklediği desteler. Girip \"Çalışmama ekle\" diyebilirsin.", 12)
        for (d in others) DeckRow(d) { onDeck(d.id) }
    }
    if (newDeck) {
        var name by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { newDeck = false },
            title = { Text("Yeni deste") },
            text = { OutlinedTextField(name, { name = it }, label = { Text("Ad (ör. Unité 3)") }, singleLine = true) },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    newDeck = false
                    scope.launch { val id = withContext(Dispatchers.IO) { Vocab.addDeck(name) }; if (id != null) onDeck(id) }
                }) { Text("Oluştur") }
            },
            dismissButton = { TextButton(onClick = { newDeck = false }) { Text("Vazgeç") } },
        )
    }
    if (settings) VocabSettingsDialog(s) { settings = false }
}

@Composable
private fun DeckRow(d: VDeck, onClick: () -> Unit) {
    val (n, l, k) = counts(d.cards)
    Card(Modifier.clickable(onClick = onClick)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(d.name, color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Muted("${d.cards.size} kart", 13)
            }
            Muted((if (d.mine) "Sen ekledin" else "${d.by} ekledi") + " · yeni $n · öğreniliyor $l · öğrenildi $k", 12)
            if (d.cards.isNotEmpty()) LinearProgressIndicator(progress = { k.toFloat() / d.cards.size }, modifier = Modifier.fillMaxWidth(), color = C.good)
        }
    }
}

@Composable
private fun VocabSettingsDialog(s: VState, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var dir by remember { mutableStateOf(s.settings.direction) }
    var goal by remember { mutableIntStateOf(s.settings.dailyGoal) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Kelime ayarları") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Muted("Kartın ön yüzünde ne görünsün?", 13)
                for ((k, l) in listOf("fr_de" to "🇫🇷 Önce Fransızca", "de_fr" to "🇩🇪 Önce Almanca", "mixed" to "🔀 Karışık")) {
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (dir == k) C.surface2 else C.surface).clickable { dir = k }.padding(10.dp)) {
                        Text(if (dir == k) "●" else "○", color = if (dir == k) C.accent else C.muted)
                        Text("  $l", color = C.text)
                    }
                }
                Muted("Günlük hedef", 13)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { goal = (goal - 5).coerceAtLeast(5) }) { Text("−", fontSize = 22.sp) }
                    Text("$goal kart", color = C.text, fontSize = 18.sp)
                    TextButton(onClick = { goal = (goal + 5).coerceAtMost(200) }) { Text("+", fontSize = 22.sp) }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onClose(); scope.launch(Dispatchers.IO) { Vocab.setSettings(dir, goal) } }) { Text("Kaydet") } },
        dismissButton = { TextButton(onClick = onClose) { Text("Vazgeç") } },
    )
}

@Composable
private fun DeckDetail(s: VState, d: VDeck, onBack: () -> Unit, onStudy: () -> Unit) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf("") }
    var edit by remember { mutableStateOf<VCard?>(null) }
    var busy by remember { mutableStateOf(false) }
    var askDelete by remember { mutableStateOf<VCard?>(null) }
    val tts = rememberTts()
    val parsed = remember(text) { Vocab.parseLines(text) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onBack) { Text("‹ Geri") }
        Text(d.name, color = C.text, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
    }
    Card {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val (n, l, k) = counts(d.cards)
            Muted((if (d.mine) "Sen ekledin" else "${d.by} ekledi") + " · ${d.cards.size} kart · yeni $n · öğreniliyor $l · öğrenildi $k", 13)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Çalışma alanımda", color = C.text, modifier = Modifier.weight(1f))
                Switch(checked = d.study, onCheckedChange = { on -> scope.launch(Dispatchers.IO) { Vocab.setStudy(d.id, on) } })
            }
            if (d.cards.isNotEmpty()) Button(onClick = onStudy, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = C.accent)) {
                Text("▶ Bu desteyi baştan sona çalış")
            }
        }
    }
    Card {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Title("Kelime ekle")
            Muted("Her satıra bir kelime: Fransızca - Almanca\nÖrnek: le chat - die Katze", 12)
            OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth().height(140.dp), placeholder = { Text("le chat - die Katze\nle chien - der Hund") })
            if (text.isNotBlank()) Muted("${parsed.size} kelime algılandı", 12)
            if (msg.isNotEmpty()) Text(msg, color = C.good, fontSize = 13.sp)
            Button(enabled = parsed.isNotEmpty() && !busy, onClick = {
                // Çift basmaya karşı: ekleme bitene kadar düğme kapalı, kutu hemen boşalır
                busy = true
                val list = parsed.map { Triple(it.first, it.second, null as String?) }
                val before = text
                text = ""
                msg = "Ekleniyor…"
                scope.launch {
                    val n = withContext(Dispatchers.IO) { Vocab.addCards(d.id, list) }
                    busy = false
                    if (n != null) msg = if (n < list.size) "$n kelime eklendi (${list.size - n} zaten vardı)" else "$n kelime eklendi"
                    else { text = before; msg = "Eklenemedi (internet?)" }
                }
            }) { Text(if (busy) "Ekleniyor…" else "Ekle") }
        }
    }
    Title("Kartlar")
    if (d.cards.any { it.mine }) Muted("Kendi eklediğin kartı silmek için 🗑, düzeltmek için karta dokun.", 12)
    for (c in d.cards.asReversed()) {
        Card(Modifier.clickable(enabled = c.mine) { edit = c }) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.fr, color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text(c.de, color = C.muted, fontSize = 14.sp)
                    c.ex?.let { Text(it, color = C.muted, fontSize = 12.sp) }
                }
                Text(
                    when { c.isNew -> "yeni"; c.learned -> "✓ öğrenildi"; else -> "öğreniliyor" },
                    color = when { c.isNew -> C.muted; c.learned -> C.good; else -> C.warn }, fontSize = 12.sp,
                )
                TextButton(onClick = { tts.say(c.fr, Locale.FRENCH) }) { Text("🔊") }
                if (c.mine) TextButton(onClick = { askDelete = c }) { Text("🗑") }
            }
        }
    }
    askDelete?.let { c ->
        AlertDialog(
            onDismissRequest = { askDelete = null },
            title = { Text("Kart silinsin mi?") },
            text = { Text("${c.fr} – ${c.de}") },
            confirmButton = { TextButton(onClick = { askDelete = null; scope.launch(Dispatchers.IO) { Vocab.editCard(c.id, c.fr, c.de, c.ex, true) } }) { Text("Sil", color = C.bad) } },
            dismissButton = { TextButton(onClick = { askDelete = null }) { Text("Vazgeç") } },
        )
    }
    edit?.let { c ->
        var fr by remember(c.id) { mutableStateOf(c.fr) }
        var de by remember(c.id) { mutableStateOf(c.de) }
        var ex by remember(c.id) { mutableStateOf(c.ex ?: "") }
        AlertDialog(
            onDismissRequest = { edit = null },
            title = { Text("Kartı düzenle") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(fr, { fr = it }, label = { Text("Fransızca") }, singleLine = true)
                    OutlinedTextField(de, { de = it }, label = { Text("Almanca") }, singleLine = true)
                    OutlinedTextField(ex, { ex = it }, label = { Text("Örnek cümle (isteğe bağlı)") })
                    TextButton(onClick = { edit = null; scope.launch(Dispatchers.IO) { Vocab.editCard(c.id, c.fr, c.de, c.ex, true) } }) { Text("Kartı sil", color = C.bad) }
                }
            },
            confirmButton = {
                TextButton(enabled = fr.isNotBlank() && de.isNotBlank(), onClick = {
                    edit = null
                    scope.launch(Dispatchers.IO) { Vocab.editCard(c.id, fr, de, ex.ifBlank { null }, false) }
                }) { Text("Kaydet") }
            },
            dismissButton = { TextButton(onClick = { edit = null }) { Text("Vazgeç") } },
        )
    }
}

/** Telefonun konuşma motoru (internetsiz çalışır) */
class Tts(ctx: android.content.Context) {
    private var ready = false
    private val tts = TextToSpeech(ctx) { ready = it == TextToSpeech.SUCCESS }
    fun say(text: String, locale: Locale) {
        if (!ready) return
        tts.language = locale
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "vocab")
    }
    fun close() = runCatching { tts.stop(); tts.shutdown() }
}

@Composable
private fun rememberTts(): Tts {
    val ctx = LocalContext.current
    val t = remember { Tts(ctx) }
    DisposableEffect(Unit) { onDispose { t.close() } }
    return t
}

/** Çalışma: kart çevirme (dokun), sağa kaydır = biliyorum, sola = bilmiyorum (birkaç kart sonra tekrar gelir) */
@Composable
private fun StudySession(s: VState, deckId: String?, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val tts = rememberTts()
    val density = LocalDensity.current
    val queue = remember { mutableStateListOf<VCard>().apply { addAll(Vocab.buildSession(s, deckId)) } }
    val total = remember { queue.size }
    val first = remember { mutableStateMapOf<String, Boolean>() }
    val asked = remember { mutableStateMapOf<String, Int>() }
    // Karışık modda her kartın ön yüz dili sabit kalsın
    val frFront = remember { queue.associate { it.id to when (s.settings.direction) { "de_fr" -> false; "mixed" -> Math.random() < 0.5; else -> true } } }
    val started = remember { System.currentTimeMillis() }
    var flipped by remember { mutableStateOf(false) }
    var summary by remember { mutableStateOf<org.json.JSONObject?>(null) }
    var finished by remember { mutableStateOf(false) }
    val offset = remember { Animatable(0f) }
    val limit = with(density) { 110.dp.toPx() }

    fun finish() {
        if (finished) return
        finished = true
        val results = first.map { (id, k) -> VResult(id, k, asked[id] ?: 1) }
        scope.launch {
            summary = withContext(Dispatchers.IO) { Vocab.finishSession(started, ((System.currentTimeMillis() - started) / 1000).toInt(), results) }
                ?: org.json.JSONObject().put("offline", true)
        }
    }

    fun answer(known: Boolean) {
        val c = queue.firstOrNull() ?: return
        if (c.id !in first) first[c.id] = known
        asked[c.id] = (asked[c.id] ?: 0) + 1
        queue.removeAt(0)
        if (!known) queue.add(minOf(3, queue.size), c)
        flipped = false
        if (queue.isEmpty()) finish()
    }

    if (queue.isEmpty() || finished) {
        val known = first.values.count { it }
        val unknown = first.size - known
        Card {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (first.isEmpty()) "Çalışılacak kart yok" else "🎉 Çalışma bitti", color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                if (first.isNotEmpty()) {
                    Text("✓ $known biliyorum · ✗ $unknown tekrar edilecek", color = C.text, fontSize = 16.sp)
                    val sm = summary
                    when {
                        sm == null -> Muted("Kaydediliyor…")
                        sm.optBoolean("offline") -> Muted("İnternet yok; sonuç sonra gönderilecek.")
                        else -> Muted("Bugün toplam ${sm.optInt("done_today")} kart çalıştın.")
                    }
                }
                Button(onClick = onDone, colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Tamam") }
            }
        }
        return
    }

    val c = queue.first()
    val front = if (frFront[c.id] != false) c.fr else c.de
    val back = if (frFront[c.id] != false) c.de else c.fr
    val frontLoc = if (frFront[c.id] != false) Locale.FRENCH else Locale.GERMAN
    // Her kart için ayrı dönme: yeni kart hep ön yüzüyle başlar (önceden geri dönme animasyonu sırasında
    // yeni kartın arka yüzü — cevabı — bir an görünüyordu)
    val rotAnim = remember(c.id) { Animatable(0f) }
    LaunchedEffect(c.id, flipped) { rotAnim.animateTo(if (flipped) 180f else 0f, tween(300)) }
    val rot = rotAnim.value

    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { if (first.isEmpty()) onDone() else finish() }) { Text("‹ Bitir") }
        Spacer(Modifier.weight(1f))
        Muted("${first.size} / $total · kalan ${queue.size}", 13)
    }
    LinearProgressIndicator(progress = { first.size.toFloat() / total.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth(), color = C.accent)
    Box(
        Modifier.fillMaxWidth().height(320.dp)
            .graphicsLayer { translationX = offset.value; rotationZ = offset.value / 40f }
            .pointerInput(c.id) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        val v = offset.value
                        scope.launch {
                            if (abs(v) > limit) {
                                offset.animateTo(if (v > 0) limit * 4 else -limit * 4, tween(150))
                                answer(v > 0)
                                offset.snapTo(0f)
                            } else offset.animateTo(0f, tween(150))
                        }
                    },
                ) { _, d -> scope.launch { offset.snapTo(offset.value + d) } }
            }
            .clip(RoundedCornerShape(22.dp))
            .background(
                when {
                    offset.value > limit / 2 -> C.good.copy(alpha = 0.35f)
                    offset.value < -limit / 2 -> C.bad.copy(alpha = 0.35f)
                    else -> C.surface2
                }
            )
            .border(2.dp, if (flipped) C.accent else C.line, RoundedCornerShape(22.dp))
            .clickable { flipped = !flipped }
            .graphicsLayer { rotationY = rot; cameraDistance = 12 * density.density },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.padding(20.dp).graphicsLayer { rotationY = if (rot > 90f) 180f else 0f },
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (rot <= 90f) {
                Muted(if (frontLoc == Locale.FRENCH) "🇫🇷 Fransızca" else "🇩🇪 Almanca", 13)
                Text(front, color = C.text, fontSize = 32.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                Muted("Çevirmek için dokun", 12)
            } else {
                Muted(if (frontLoc == Locale.FRENCH) "🇩🇪 Almanca" else "🇫🇷 Fransızca", 13)
                Text(back, color = C.text, fontSize = 30.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                Text(front, color = C.muted, fontSize = 16.sp, textAlign = TextAlign.Center)
                c.ex?.let { Text(it, color = C.muted, fontSize = 14.sp, textAlign = TextAlign.Center) }
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = { answer(false) }, modifier = Modifier.weight(1f).height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = C.bad)) { Text("✗ Bilmiyorum") }
        TextButton(onClick = { tts.say(if (rot <= 90f) front else back, if (rot <= 90f) frontLoc else if (frontLoc == Locale.FRENCH) Locale.GERMAN else Locale.FRENCH) }, modifier = Modifier.width(56.dp)) { Text("🔊", fontSize = 22.sp) }
        Button(onClick = { answer(true) }, modifier = Modifier.weight(1f).height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = C.good)) { Text("✓ Biliyorum") }
    }
    Muted("Sağa kaydır: biliyorum · Sola kaydır: bilmiyorum (birkaç kart sonra tekrar gelir)", 12)
}
