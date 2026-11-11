package app.orbit.ui

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.withStyle
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Sync
import app.orbit.data.TaskItem
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private fun statusText(t: TaskItem) = when (t.status) {
    "open" -> null
    "started" -> "Başladın — bitince \"Tamamladım\"a bas"
    "submitted" -> "Ebeveyn onayı bekleniyor"
    "approved" -> "Onaylandı" + (t.rewardMinutes?.let { " · ${if (it > 0) "+" else ""}$it dk" } ?: "")
    "rejected" -> "Tekrar yap" + (t.rejectNote?.let { ": $it" } ?: "")
    "claimed" -> "Kardeşin yaptı"
    "expired" -> "Süresi doldu"
    else -> t.status
}

private fun rewardText(t: TaskItem): String? {
    val parts = mutableListOf<String>()
    t.rewardMinutes?.let {
        parts += "${if (it > 0) "+" else ""}$it dk" + when (t.rewardValidity) {
            "tomorrow" -> " (yarın)"
            "wallet" -> " (cüzdana)"
            "vault" -> " (süre kasasına)"
            "date" -> " (belirli gün)"
            else -> ""
        }
    }
    t.rewardText?.let { parts += it }
    return parts.joinToString(" · ").ifBlank { null }
}

private val taskDay = DateTimeFormatter.ofPattern("dd.MM.yyyy EEEE", java.util.Locale("tr", "TR"))
private fun taskDate(value: String?): String? = value?.let { runCatching { java.time.LocalDate.parse(it.take(10)).format(taskDay) }.getOrNull() }
private fun taskEntered(value: String?): String? = value?.let { runCatching { Instant.parse(it).atZone(ZoneId.systemDefault()).toLocalDate().format(DateTimeFormatter.ofPattern("dd.MM.yyyy")) + " · " + Instant.parse(it).atZone(ZoneId.systemDefault()).toLocalTime().toString().take(5) }.getOrNull() }

private fun mediaFor(proof: String) = when (proof) {
    "video" -> "video"
    "photo_or_video" -> "either"
    else -> "photo"
}

/** Ajandadan bir göreve gelince o görev öne çıkar. */
object TaskFocus {
    var taskId by mutableStateOf<String?>(null)
}

private fun lockText(t: TaskItem, all: List<TaskItem>): String {
    if (t.startAfter.isNotEmpty()) {
        val now0 = java.time.LocalTime.now().toString().take(5)
        val waiting = all.filter { it.groupId == t.groupId && it.dueDate == t.dueDate && it.title in t.startAfter && it.status != "approved" && it.status != "claimed" }
        if (waiting.isNotEmpty()) return "${waiting.joinToString(", ") { it.title }} bitince başlayabilirsin"
        if (t.startTime != null && now0 < t.startTime) return "${t.startTime}'de açılır"
    }
    val prev = all.filter { it.groupId == t.groupId && it.dueDate == t.dueDate }.takeWhile { it.runId != t.runId }.lastOrNull { it.status != "approved" && it.status != "claimed" }
    val now = java.time.LocalTime.now().toString().take(5)
    if (t.startTime != null && now < t.startTime) return "${t.startTime}'de açılır"
    return when {
        prev == null -> "Sırası gelince açılır"
        prev.status == "submitted" -> "“${prev.title}” onaylanınca açılır"
        else -> "Önce “${prev.title}”i bitir"
    }
}

/** Grup başlığı: ilerleme ve bekleyen süre */
@Composable
private fun GroupHeader(t: TaskItem) {
    val left = (t.groupNeed - t.groupApproved).coerceAtLeast(0)
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(C.surface2).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(t.groupName ?: "Görev grubu", color = C.text, fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.weight(1f))
            Text("${t.groupApproved}/${t.groupNeed}", color = if (t.groupStatus == "met") C.good else C.text, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
        androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(C.surface)) {
            val frac = if (t.groupNeed > 0) (t.groupApproved.toFloat() / t.groupNeed).coerceIn(0f, 1f) else 0f
            androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth(frac).height(6.dp).clip(RoundedCornerShape(3.dp)).background(C.good))
        }
        Text(
            when (t.groupStatus) {
                "met" -> "Tamamladın! Süren açıldı."
                "failed" -> "Bu sefer olmadı. Kazandığın süre kasaya gitti."
                else -> when {
                    t.groupMandatoryLeft > 0 && left > 0 -> "Zorunlu görevleri yap · $left görev daha${if (t.groupHeld > 0) " · ${t.groupHeld} dk seni bekliyor" else ""}"
                    left > 0 -> "$left görev daha${if (t.groupHeld > 0) " → ${t.groupHeld} dk açılır" else ""}"
                    t.groupMandatoryLeft > 0 -> "Zorunlu görev bekleniyor"
                    else -> "Onay bekleniyor"
                }
            },
            color = if (t.groupStatus == "met") C.good else C.muted, fontSize = 13.sp,
        )
    }
}

private val CIRCLED = listOf("①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩")

/** Bağ başlığı: sıra numarası, birlikte açılacak süre, bekleyen puan, sıra uyarısı */
@Composable
private fun BundleHeader(t: TaskItem) {
    val n = t.bundlePos ?: return
    val mark = CIRCLED.getOrElse(n - 1) { "$n." }
    val label = when {
        t.bundleDone && t.bundleReady -> "TAMAM"
        t.bundleOptional -> "SEÇMELİ"
        t.bundleCurrent -> "SIRADA"
        else -> "SONRA"
    }
    val what = if (t.bundleSize > 1) "hepsi bitince ${t.bundleMinutes} dk açılır" else "${t.bundleMinutes} dk"
    val color = when (label) { "TAMAM" -> C.good; "SIRADA" -> C.accent; else -> C.muted }
    Column(
        Modifier.fillMaxWidth().padding(top = 6.dp).clip(RoundedCornerShape(12.dp))
            .background(if (label == "SIRADA") C.accent.copy(alpha = 0.16f) else C.surface).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("$mark $label", color = color, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Text("  ·  $what", color = C.muted, fontSize = 13.sp, modifier = Modifier.weight(1f))
            if (t.bundleHeld > 0) Text("🔒 ${t.bundleHeld} dk bekliyor", color = C.warn, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
        when {
            t.bundleDone && !t.bundleReady -> Muted("Bu bağ bitti. Puanın önceki bağlar bitince açılır.", 12)
            !t.bundleDone && !t.bundleReady -> Muted("Önce önceki bağı bitir. Şimdi yaparsan puanın birikir, sırası gelince açılır.", 12)
            t.bundleOptional && !t.bundleDone -> Muted("Zorunlu görevler bitince açılır.", 12)
        }
    }
}

/** Görevler: başla (öncesi kanıtı), tamamladım (sonrası/kanıt), gönder. */
@Composable
fun TasksCard(tasks: List<TaskItem>) {
    val ctx = LocalContext.current
    val session by app.orbit.data.TaskSession.flow.collectAsState()
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<Pair<TaskItem, String>?>(null) }
    var busyRun by remember { mutableStateOf<String?>(null) }
    var optimisticSubmitted by remember { mutableStateOf<Set<String>>(emptySet()) }
    var msg by remember { mutableStateOf("") }
    var shotFor by remember { mutableStateOf<TaskItem?>(null) }

    fun addShots(t: TaskItem, uris: List<android.net.Uri>) {
        busyRun = t.runId
        msg = "Ekran görüntüleri yükleniyor…"
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    for (u in uris) {
                        val bytes = Screenshots.jpeg(ctx, u) ?: continue
                        Sync.uploadProof(t.runId, "screenshot", "photo", bytes, "image/jpeg")
                    }
                }
            }
            busyRun = null
            msg = if (r.isSuccess) "${uris.size} ekran görüntüsü eklendi" else "Yüklenemedi: ${r.exceptionOrNull()?.message ?: "internet?"}"
            Live.syncRequested = true
        }
    }

    fun submit(t: TaskItem) {
        app.orbit.data.TaskSession.stop(t.runId)
        optimisticSubmitted = optimisticSubmitted + t.runId
        busyRun = t.runId
        scope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { Sync.submitTask(t.runId) } }
            busyRun = null
            if (ok.isFailure) optimisticSubmitted = optimisticSubmitted - t.runId
            msg = if (ok.isSuccess) "\"${t.title}\" gönderildi, onay bekleniyor"
                else if ("screen_recording_missing" in (ok.exceptionOrNull()?.message ?: "")) "Önce ekran kaydını tamamla"
                else if ("recording_missing" in (ok.exceptionOrNull()?.message ?: "")) "Önce kaydı tamamla"
                else if ("screenshot_missing" in (ok.exceptionOrNull()?.message ?: "")) "Önce ekran görüntüsü ekle"
                else if ("recording_short" in (ok.exceptionOrNull()?.message ?: "")) "Kayıt en az süreden kısa"
                else if ("locked" in (ok.exceptionOrNull()?.message ?: "")) "Bu görev henüz açılmadı"
                else "Gönderilemedi: ${ok.exceptionOrNull()?.message ?: "internet?"}"
            Live.syncRequested = true
        }
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val p = pending ?: return@rememberLauncherForActivityResult
        pending = null
        if (res.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val paths = res.data?.getStringArrayListExtra("paths") ?: res.data?.getStringExtra("path")?.let { arrayListOf(it) } ?: return@rememberLauncherForActivityResult
        val media = res.data?.getStringExtra("media") ?: "photo"
        val (task, stage) = p
        busyRun = task.runId
        val thenSubmit = stage != "before" && !task.needsScreenshot && !task.needsScreenRec
        if (thenSubmit) optimisticSubmitted = optimisticSubmitted + task.runId
        msg = "Yükleniyor…"
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    for (path in paths) {
                        val f = File(path)
                        Sync.uploadProof(task.runId, stage, media, f.readBytes(), if (media == "video") "video/mp4" else "image/jpeg")
                        f.delete()
                    }
                    if (thenSubmit) Sync.submitTask(task.runId)
                }
            }
            busyRun = null
            if (r.isFailure && thenSubmit) optimisticSubmitted = optimisticSubmitted - task.runId
            msg = when {
                r.isFailure -> "Yüklenemedi: ${r.exceptionOrNull()?.message ?: "internet?"}"
                stage == "before" -> "${paths.size} öncesi fotoğrafı kaydedildi. Görevi yap, sonra \"Tamamladım\"a bas."
                !thenSubmit -> if (task.needsScreenRec) "Fotoğraflar eklendi. Şimdi ekran kaydını yap." else "Fotoğraflar eklendi. Şimdi ekran görüntüsünü ekle."
                else -> "\"${task.title}\" gönderildi, onay bekleniyor"
            }
            Live.syncRequested = true
        }
    }

    fun capture(t: TaskItem, stage: String, minPhotos: Int, maxPhotos: Int) {
        pending = t to stage
        val title = when (stage) {
            "before" -> "${t.title} — öncesi"
            "after" -> "${t.title} — sonrası"
            else -> t.title
        }
        launcher.launch(
            Intent(ctx, CaptureActivity::class.java)
                .putExtra("media", mediaFor(t.proof))
                .putExtra("title", title)
                .putExtra("minPhotos", minPhotos)
                .putExtra("maxPhotos", maxPhotos),
        )
    }

    // Biten görevler (onaylanan, süresi dolan, kardeşin yaptığı) ayrı "Geçmiş" bölümünde; grup tamamen bitince grup da oraya geçer
    val finalSet = setOf("approved", "expired", "claimed")
    // Grup bütünlüğü gün gün: dünkü bitmiş görevler bugünkü grup bitmedi diye listede kalmasın
    val today = java.time.LocalDate.now().toString()
    val done = tasks.filter { t ->
        t.runId !in optimisticSubmitted && t.status in finalSet &&
            (t.groupId == null || (t.dueDate != null && t.dueDate < today) ||
                tasks.filter { it.groupId == t.groupId && it.dueDate == t.dueDate }.all { it.status in finalSet })
    }
    val active = tasks.filter { it !in done }
    var showDone by remember { mutableStateOf(false) }
    var showSummary by remember { mutableStateOf(false) }
    if (showSummary) SummaryDialog(tasks) { showSummary = false }
    Card {
        Title("Görevlerim")
        if (tasks.any { it.groupId != null || it.failMinutes != null }) Button(
            onClick = { showSummary = true },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = C.accent),
        ) { Text("📋 Neyi yaparsam ne olur?", fontWeight = FontWeight.SemiBold) }
        if (active.isEmpty()) Muted(if (done.isEmpty()) "Bugün görev yok." else "Şu an yapılacak görev yok 🎉")
        val focus = TaskFocus.taskId
        var lastGroup: String? = null
        var lastBundle: Int? = null
        for (raw in active) {
            val t = if (raw.runId in optimisticSubmitted) raw.copy(status = "submitted") else raw
            if (t.groupId != null && t.groupId != lastGroup) { GroupHeader(t); lastBundle = null }
            lastGroup = t.groupId
            if (t.bundlePos != null && t.bundlePos != lastBundle) BundleHeader(t)
            else if (t.bundlePos == null && lastBundle != null && t.groupId != null) Muted("Diğer görevler", 12)
            lastBundle = t.bundlePos
            if (t.locked && t.open) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("🔒", fontSize = 18.sp, modifier = Modifier.padding(end = 10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(t.title, color = C.muted, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        Muted(lockText(t, tasks), 12)
                    }
                    t.rewardMinutes?.takeIf { it > 0 }?.let { Text("+$it dk", color = C.muted, fontSize = 12.sp) }
                }
                continue
            }
            val focused = focus != null && focus == t.taskId
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (focused) C.accent.copy(alpha = 0.18f) else C.surface2).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t.title, color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                    if (t.mandatory && t.groupId != null) Text("Zorunlu", color = C.bad, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
                if (t.agendaItemId != null) Muted("📋 Ajandandan", 12)
                t.description?.let { Muted(it, 13) }
                rewardText(t)?.let { Text("Ödül: $it", color = C.good, fontSize = 13.sp) }
                if (t.open && t.earnText != null) Muted("Süren ${t.earnText} bitince açılır", 12)
                if (t.open) t.failMinutes?.let { PenaltyBox(t, it) }
                if (t.held) HeldBox(t)
                if (t.open && t.vocabCards != null) {
                    val vctx = androidx.compose.ui.platform.LocalContext.current
                    Text(
                        "📚 Bugün ${t.vocabDone} / ${t.vocabCards} kart · " +
                            if (t.needsProof || t.needsRecording || t.screenshotMin != null || t.screenRecMinutes != null) "hedefe ulaşınca kanıtını gönder" else "hedefe ulaşınca kendiliğinden tamamlanır",
                        color = C.muted, fontSize = 13.sp,
                    )
                    androidx.compose.material3.Button(
                        onClick = {
                            vctx.startActivity(android.content.Intent(vctx, MainActivity::class.java)
                                .putExtra(app.orbit.data.Notifier.EXTRA_SCREEN, Screen.VOCAB.name)
                                .addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP or android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                        },
                        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = C.accent),
                    ) { Text("📚 Kelime çalış") }
                }
                val due = listOfNotNull(taskEntered(t.createdAt), taskDate(t.dueDate), t.dueTime?.let { it }).joinToString(" · ")
                if (due.isNotBlank()) Muted(due, 12)
                if (t.firstWins && t.open) Muted("İlk yapan alır", 12)
                statusText(t)?.let {
                    Text(it, color = if (t.status == "rejected") C.warn else if (t.status == "approved") C.good else C.muted, fontSize = 13.sp)
                }
                if (t.open && t.needsRecording) {
                    val rec = app.orbit.data.Recorder.current()?.takeIf { it.runId == t.runId }
                    when {
                        rec?.active == true || (!t.recordingDone && !(t.needsProof && t.beforeCount < t.beforePhotoMin)) -> Button(
                            onClick = { ctx.startActivity(Intent(ctx, RecordActivity::class.java).putExtra("runId", t.runId)) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = C.bad),
                        ) {
                            Text(
                                when {
                                    rec?.reached == true -> "✅ Kayıt süresi doldu — seç"
                                    rec?.status == "paused" -> "📹 Kayda devam et"
                                    rec?.active == true -> "📹 Kayıt sürüyor — aç"
                                    t.recStatus == "recording" || t.recStatus == "paused" -> "📹 Kayda devam et"
                                    else -> "📹 Kayda başla (${t.recordMinutes} dk)"
                                }
                            )
                        }
                        t.recordingDone -> Text("📹 Kayıt tamam (${t.recSeconds / 60} dk)", color = C.good, fontSize = 13.sp)
                    }
                }
                if (t.open && t.allowedPackages.isNotEmpty() && t.screenRecMinutes == null) {
                    val label = remember(t.allowedPackages) { t.allowedPackages.joinToString(", ") { pkg -> runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg.substringAfterLast('.')) } }
                    val openApp = { ctx.packageManager.getLaunchIntentForPackage(t.allowedPackages.first())?.let { runCatching { ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } } ?: run { msg = "Uygulama telefonda yüklü değil" } }
                    if (session?.runId == t.runId) {
                        Text("▶ Görev sürüyor: sadece $label açık, süren düşmüyor", color = C.good, fontSize = 13.sp)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { openApp() }, modifier = Modifier.weight(1f), colors = ButtonDefaults.buttonColors(containerColor = C.accent)) { Text("Uygulamaya dön") }
                            OutlinedButton(onClick = { app.orbit.data.TaskSession.stop(t.runId) }, modifier = Modifier.weight(1f)) { Text("⏸ Duraklat", color = C.text) }
                        }
                    } else Button(
                        onClick = { app.orbit.data.TaskSession.start(t.runId, t.title, t.allowedPackages, screen = false); openApp() },
                        enabled = session == null && !t.locked,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = C.blue),
                    ) { Text("▶ Göreve başla ($label)") }
                } else if (t.open && t.allowedPackages.isNotEmpty() && t.screenRecMinutes == null) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        t.allowedPackages.forEach { pkg ->
                            val label = remember(pkg) { runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg.substringAfterLast('.')) }
                            OutlinedButton(onClick = {
                                ctx.packageManager.getLaunchIntentForPackage(pkg)?.let { runCatching { ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
                                    ?: run { msg = "$label telefonda yüklü değil" }
                            }) { Text("▶ $label aç", color = C.text, fontSize = 13.sp) }
                        }
                    }
                }
                if (t.open && t.screenRecMinutes != null) {
                    val active = app.orbit.service.ScreenCaptureService.running
                    if (t.needsScreenRec || t.screenRecStatus != "done") Button(
                        onClick = { ScreenCaptureActivity.start(ctx, t, "record") },
                        enabled = !active && !t.locked,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = C.bad),
                    ) {
                        val minTxt = t.screenRecMinMinutes?.let { "en az $it · " } ?: ""
                        Text(
                            when {
                                active -> "🎬 Ekran kaydı sürüyor (yuvarlak düğme)"
                                t.screenRecStatus == "recording" || t.screenRecStatus == "paused" -> "🎬 Ekran kaydına devam et (${t.screenRecSeconds / 60} dk)"
                                else -> "🎬 Ekran kaydını başlat (${minTxt}en fazla ${t.screenRecMinutes} dk)"
                            }
                        )
                    }
                    else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("🎬 Ekran kaydı tamam (${t.screenRecSeconds / 60} dk)", color = C.good, fontSize = 13.sp)
                        TextButton(onClick = { ScreenCaptureActivity.start(ctx, t, "record") }) { Text("Yeniden kaydet", fontSize = 13.sp) }
                    }
                }
                if (t.open && t.screenshotMin != null) {
                    val mx = t.screenshotMax ?: t.screenshotMin
                    if (t.screenshotCount < mx) {
                        Button(
                            onClick = { ScreenCaptureActivity.start(ctx, t, "shot") },
                            enabled = busyRun != t.runId && !app.orbit.service.ScreenCaptureService.running,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = if (t.needsScreenshot) C.blue else C.surface),
                        ) { Text("📱 Ekran görüntüsü al (${t.screenshotCount}/${t.screenshotMin}${if (mx > t.screenshotMin) "–$mx" else ""})") }
                        TextButton(onClick = { shotFor = t }) { Text("Galeriden seç", fontSize = 12.sp) }
                    }
                    else Text("📱 ${t.screenshotCount} ekran görüntüsü eklendi", color = C.good, fontSize = 13.sp)
                }
                val needBefore = t.needsProof && t.beforeCount < t.beforePhotoMin
                val needAfter = t.needsProof && t.afterCount < t.afterPhotoMin
                val recordFirst = t.needsRecording && !t.recordingDone && !needBefore
                if (t.open && !recordFirst && !(t.needsRecording && app.orbit.data.Recorder.current()?.let { it.runId == t.runId && it.active } == true)) {
                    val busy = busyRun == t.runId
                    Button(
                        onClick = {
                            when {
                                needBefore -> capture(t, "before", t.beforePhotoMin, t.beforePhotoMax)
                                needAfter -> capture(t, if (t.beforeAfter) "after" else "single", t.afterPhotoMin, t.afterPhotoMax)
                                t.needsScreenRec -> ScreenCaptureActivity.start(ctx, t, "record")
                                t.needsScreenshot -> ScreenCaptureActivity.start(ctx, t, "shot")
                                else -> submit(t)
                            }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = if (needBefore) C.blue else C.accent),
                    ) {
                        Text(
                            when {
                                busy -> "Gönderiliyor…"
                                needBefore -> "Başla (${t.beforeCount}/${t.beforePhotoMin} öncesi)"
                                needAfter -> "Tamamladım (${t.afterCount}/${t.afterPhotoMin} sonrası)"
                                t.needsScreenRec -> "Önce ekran kaydını yap"
                                t.needsScreenshot -> "Önce ekran görüntüsü al"
                                else -> "Tamamladım"
                            }
                        )
                    }
                }
            }
        }
        if (done.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { showDone = !showDone }.padding(vertical = 10.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("🕘 Geçmiş (${done.size})", color = C.muted, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(if (showDone) "▴" else "▾", color = C.muted, fontSize = 16.sp)
            }
            if (showDone) for (t in done) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(t.title, color = C.text, fontSize = 14.sp)
                        taskDate(t.dueDate ?: t.createdAt)?.let { Muted(it, 12) }
                    }
                    Text(
                        statusText(t) ?: "",
                        color = when (t.status) { "approved" -> C.good; "expired" -> C.muted; else -> C.muted },
                        fontSize = 12.sp,
                    )
                }
            }
        }
        if (msg.isNotEmpty()) Text(msg, color = C.good, fontSize = 13.sp)
        shotFor?.let { t ->
            val mx = (t.screenshotMax ?: t.screenshotMin ?: 1) - t.screenshotCount
            ScreenshotPicker(max = mx.coerceAtLeast(1), onDismiss = { shotFor = null }) { uris -> shotFor = null; addShots(t, uris) }
        }
    }
}


private fun failWhere(target: String?) = when (target) {
    "vault" -> "kasadan düşülür"
    "wallet" -> "cüzdanına borç yazılır"
    else -> "bugünkü süreden düşülür"
}

/** Cezalı görev: çocuk özellikle bilsin */
@Composable
private fun PenaltyBox(t: TaskItem, minutes: Int) {
    val left = t.dueTime?.let { runCatching { java.time.Duration.between(java.time.LocalTime.now(), java.time.LocalTime.parse(it)) }.getOrNull() }
        ?.takeIf { !it.isNegative && (t.dueDate == null || t.dueDate == java.time.LocalDate.now().toString()) }
    val leftText = left?.let { d -> " · " + (if (d.toHours() > 0) "${d.toHours()} sa ${d.toMinutes() % 60} dk" else "${d.toMinutes()} dk") + " kaldı" } ?: ""
    Text(
        "⚠️ Yapmazsan${t.dueTime?.let { " $it'de" } ?: ""} −$minutes dk ${failWhere(t.failTarget)}$leftText",
        color = Color(0xFFF8B4B4), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFF3D1C22)).padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

/** Onaylandı ama süresi bekliyor */
@Composable
private fun HeldBox(t: TaskItem) {
    Text(
        "⏳ ${t.minutes} dk bekliyor" + (t.earnText?.let { " · $it bitince açılır" } ?: "") + " · bugün açılmazsa kasaya gider",
        color = Color(0xFFF3D48A), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFF3A2F12)).padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

private val todayStr get() = java.time.LocalDate.now().toString()

/** Bugünün görevleri (önceki günler görünmez; bugün süren tek seferlikler dahil) */
private fun todays(tasks: List<TaskItem>): List<TaskItem> {
    val today = todayStr
    return tasks.filter { (it.day ?: it.dueDate) == today || (it.open && it.groupId == null && (it.dueDate == null || it.dueDate >= today)) }
}

/** Kazanma koşulunda kalan görevler: kendisi ve bugün onaylananlar hariç */
private fun earnLeft(t: TaskItem, list: List<TaskItem>): List<String> =
    t.earnTitles.filter { n -> n != t.title && list.none { it.title == n && it.status == "approved" } }

private fun hm(v: String?) = v?.take(5)

/** Görev çipleri: panelle aynı simgeler, aynı sıra */
private fun chips(t: TaskItem, list: List<TaskItem>): List<Pair<String, Color?>> {
    val c = mutableListOf<Pair<String, Color?>>()
    c += "⭐ +${t.minutes.coerceAtLeast(0)}" to Color(0xFF7EE2A8)
    t.failMinutes?.let { f -> c += ("⚠️ −$f " + when (t.failTarget) { "wallet" -> "👛"; "vault" -> "🏦"; else -> "⏱" }) to Color(0xFFF8B4B4) }
    if (t.groupId != null) c += (if (t.mandatory) "❗ Zorunlu" else "☆ Seçmeli") to null
    c += when (t.restriction) { "kiosk" -> "🔒 Tam kilit"; "limit" -> "🔐 Kilitli"; "mode" -> "🎯 Profil"; else -> "🟢 Serbest" } to null
    val left = earnLeft(t, list)
    c += (if (left.isEmpty() || t.status == "approved") "✅ Onaylanınca" else when (t.earnMode) {
        "any" -> "🔗 ${left.joinToString(" ya da ")} bitince"
        "min" -> "🔗 ${left.joinToString(", ")}'den en az ${minOf(t.earnMin, left.size)} tanesi bitince"
        else -> "🔗 ${left.joinToString(" + ")} bitince"
    }) to null
    c += when (t.rewardValidity) {
        "wallet" -> "👛 Cüzdana"
        "vault" -> "🏦 Kasaya"
        else -> "⚡ Şimdi · " + when (t.useMode) { "clock" -> "saat gibi"; "within" -> "süre içinde"; else -> "kullandıkça" }
    } to null
    val after = t.startAfter.filter { n -> list.none { it.title == n && it.status == "approved" } }
    c += (if (after.isNotEmpty() && t.open) "⏸ ${after.joinToString(", ")}'dan sonra" else "▶️ Şimdi yapabilir") to null
    val proofs = buildList {
        if (t.needsProof) add("📷 Fotoğraf")
        t.recordMinutes?.let { add("🎥 Kamera $it dk") }
        t.screenshotMin?.let { add("🖼 Ekran görüntüsü") }
        t.screenRecMinutes?.let { add("🖥 Ekran kaydı $it dk") }
    }
    if (proofs.isEmpty()) c += "🚫 Kanıt yok" to null else proofs.forEach { c += it to null }
    val a = hm(t.windowStart); val b = hm(t.windowEnd ?: t.dueTime)
    if (b != null) c += (if (a != null) "🕗 $a–$b" else "🕗 $b'e kadar") to null
    return c
}

private fun failWhereShort(target: String?) = when (target) { "wallet" -> " cüzdanına borç"; "vault" -> " kasadan"; else -> "" }

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun SummaryDialog(tasks: List<TaskItem>, onClose: () -> Unit) {
    val live by Live.state.collectAsState()
    val list = todays(tasks)
    val locks = live.taskLocks
    val kiosk = live.kiosk
    val ready = live.readyMinutes
    // Kilidi açan görevler: tek görev kilidi → o görev; grup kilidi → gruptaki açık kısıtlı görevlerden biri
    val singleLocks = locks.filter { it.second == null }.map { it.first }.distinct()
    val groupLocks = locks.mapNotNull { it.second }.distinct()
    val groupAlts = groupLocks.associateWith { g -> list.filter { it.groupId == g && it.open && it.restriction != "none" }.map { it.title }.distinct() }
    val unlockers = (singleLocks + groupAlts.values.flatten()).toSet()
    val unlockText = (singleLocks.map { "**$it**" } + groupAlts.values.filter { it.isNotEmpty() }.map { alts -> alts.joinToString(" ya da ") { "**$it**" } }).joinToString(" + ")
    val programLock = kiosk != null && kiosk.source != "task"

    val wait = list.filter { it.held }.sumOf { it.minutes }
    val wallet = list.filter { it.status == "approved" && !it.held && it.rewardValidity == "wallet" }.sumOf { it.minutes }
    val vault = list.filter { it.status == "approved" && !it.held && it.rewardValidity == "vault" }.sumOf { it.minutes }
    val order = list.sortedBy { t -> when { t.title in unlockers && t.open -> 0; t.open || t.status == "submitted" -> 1; else -> 2 } }

    androidx.compose.ui.window.Dialog(onDismissRequest = onClose, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.fillMaxWidth().padding(12.dp).clip(RoundedCornerShape(20.dp)).background(C.bg).padding(16.dp)
                .verticalScroll(androidx.compose.foundation.rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Neyi yaparsam ne olur?", color = C.text, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                TextButton(onClick = onClose) { Text("Kapat") }
            }
            // Durum kutusu: her onayda ve her dakika güncellenir
            val locked = programLock || locks.isNotEmpty()
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (locked) Color(0xFF3D1C22) else Color(0xFF17331F)).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                when {
                    programLock -> {
                        Text("🌙 ${kiosk!!.name} · telefon kilitli", color = C.text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        kiosk.untilMs?.let { Text("${java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalTime().toString().take(5)}'de açılır", color = C.text.copy(alpha = 0.85f), fontSize = 14.sp) }
                    }
                    locks.isNotEmpty() -> {
                        Text("🔒 Telefonun şu an kilitli", color = C.text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        Text(if (ready > 0) "🎁 $ready dk süren hazır, kilit kalkınca kullanırsın" else "🎁 Henüz hazır süren yok", color = C.text.copy(alpha = 0.9f), fontSize = 14.sp)
                        if (unlockText.isNotBlank()) Text(md("👉 Açmak için: $unlockText"), color = C.text, fontSize = 15.sp)
                    }
                    else -> {
                        Text("🟢 Telefonun açık" + (if (ready > 0) " · $ready dk kullanabilirsin" else ""), color = C.text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Tile("🎁 Hazır", ready, Color(0xFF17331F), Modifier.weight(1f))
                Tile("⏳ Bekleyen", wait, Color(0xFF3A2F12), Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Tile("👛 Cüzdan", wallet, Color(0xFF1D2550), Modifier.weight(1f))
                Tile("🏦 Kasa", vault, Color(0xFF2A2145), Modifier.weight(1f))
            }
            for (t in order) {
                val isUnlocker = t.title in unlockers && t.open
                val badge = when {
                    isUnlocker -> "👉 Şimdi bunu yap"
                    t.status == "approved" && t.held -> "⏳ Bekliyor"
                    t.status == "approved" -> "✅ Yaptın"
                    t.status == "submitted" -> "Onayda"
                    t.status == "expired" -> "Yapılmadı"
                    t.locked && t.open -> "🔒 Sonra"
                    else -> "Sırada"
                }
                val lines = mutableListOf<Pair<String, Color>>()
                val left = earnLeft(t, list)
                when (t.status) {
                    "approved" -> lines += (if (t.held) "⏳ ${t.minutes} dk hazır, ${left.joinToString(", ")} bitince açılır" else "🎉 ${t.minutes} dk kazandın" + if (t.failMinutes != null) " · cezadan kurtuldun" else "") to Color(0xFFA6E7BD)
                    "expired" -> lines += ("Yapılmadı" + (t.failMinutes?.let { " · −$it dk" } ?: "")) to Color(0xFFF8B4B4)
                    else -> {
                        if (t.minutes > 0) {
                            // Bu görev bitince kalan kilitler
                            val restSingles = singleLocks.filter { it != t.title }
                            val restGroups = groupLocks.filter { g -> !(t.groupId == g && t.restriction != "none" && t.mandatory && left.isEmpty() && t.rewardValidity !in setOf("wallet", "vault")) }
                            val opens = isUnlocker && restSingles.isEmpty() && restGroups.isEmpty() && !programLock
                            val waiting = list.filter { o -> o.held && t.title in o.earnTitles && earnLeft(o, list) == listOf(t.title) }.sumOf { it.minutes }
                            val plus = if (left.isEmpty() && t.rewardValidity !in setOf("wallet", "vault")) t.minutes else 0
                            lines += when {
                                opens -> "✅ Yaparsan kilit açılır, ${ready + plus + waiting} dk kullanırsın"
                                left.isNotEmpty() -> "✅ Yaparsan ${t.minutes} dk kazanırsın, ${left.joinToString(", ")} bitince açılır"
                                t.rewardValidity == "wallet" -> "✅ Yaparsan ${t.minutes} dk cüzdanına eklenir"
                                t.rewardValidity == "vault" -> "✅ Yaparsan ${t.minutes} dk kasaya gider"
                                waiting > 0 -> "✅ Yaparsan ${t.minutes} dk eklenir + bekleyen $waiting dk açılır"
                                else -> "✅ Yaparsan ${t.minutes} dk eklenir"
                            } to Color(0xFFA6E7BD)
                        }
                        t.failMinutes?.let { f -> lines += "⚠️ Yapmazsan${hm(t.dueTime)?.let { " $it'de" } ?: ""} −$f dk${failWhereShort(t.failTarget)}" to Color(0xFFF8B4B4) }
                    }
                }
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface)
                        .then(if (isUnlocker) Modifier.background(C.accent.copy(alpha = 0.12f)) else Modifier).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(t.title, color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        Text(badge, color = if (isUnlocker) C.accent else C.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((label, color) in chips(t, list)) Text(
                            label, color = color ?: C.text.copy(alpha = 0.85f), fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.clip(RoundedCornerShape(50)).background(C.surface2).padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                    for ((l, col) in lines) Text(l, color = col, fontSize = 14.sp)
                }
            }
            val end = buildList {
                list.filter { it.open && it.failMinutes != null }.forEach { add("${it.title} −${it.failMinutes} dk${failWhereShort(it.failTarget)}") }
                list.filter { it.held }.forEach { add("${it.title}'in bekleyen ${it.minutes} dk'sı kasaya") }
            }
            if (end.isNotEmpty()) {
                val due = list.mapNotNull { hm(it.dueTime) }.maxOrNull()
                Text(
                    "🌙 ${due?.let { "$it'e kadar " } ?: ""}yapılmazsa: " + end.joinToString(" · "),
                    color = C.text.copy(alpha = 0.85f), fontSize = 14.sp,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.surface).padding(12.dp),
                )
            }
        }
    }
}

/** **kalın** işaretli metin */
private fun md(s: String) = androidx.compose.ui.text.buildAnnotatedString {
    val parts = s.split("**")
    parts.forEachIndexed { i, p ->
        if (i % 2 == 1) withStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)) { append(p) } else append(p)
    }
}

@Composable
private fun Tile(label: String, minutes: Int, bg: Color, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(bg).padding(12.dp)) {
        Text(label, color = C.text.copy(alpha = 0.85f), fontSize = 13.sp)
        Text("$minutes dk", color = C.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
    }
}
