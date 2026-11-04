package app.orbit.ui

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
    val prev = all.filter { it.groupId == t.groupId }.takeWhile { it.runId != t.runId }.lastOrNull { it.status != "approved" && it.status != "claimed" }
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

/** Görevler: başla (öncesi kanıtı), tamamladım (sonrası/kanıt), gönder. */
@Composable
fun TasksCard(tasks: List<TaskItem>) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<Pair<TaskItem, String>?>(null) }
    var busyRun by remember { mutableStateOf<String?>(null) }
    var optimisticSubmitted by remember { mutableStateOf<Set<String>>(emptySet()) }
    var msg by remember { mutableStateOf("") }

    fun submit(t: TaskItem) {
        optimisticSubmitted = optimisticSubmitted + t.runId
        busyRun = t.runId
        scope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { Sync.submitTask(t.runId) } }
            busyRun = null
            if (ok.isFailure) optimisticSubmitted = optimisticSubmitted - t.runId
            msg = if (ok.isSuccess) "\"${t.title}\" gönderildi, onay bekleniyor"
                else if ("recording_missing" in (ok.exceptionOrNull()?.message ?: "")) "Önce kaydı tamamla"
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
        if (stage != "before") optimisticSubmitted = optimisticSubmitted + task.runId
        msg = "Yükleniyor…"
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    for (path in paths) {
                        val f = File(path)
                        Sync.uploadProof(task.runId, stage, media, f.readBytes(), if (media == "video") "video/mp4" else "image/jpeg")
                        f.delete()
                    }
                    if (stage != "before") Sync.submitTask(task.runId)
                }
            }
            busyRun = null
            if (r.isFailure && stage != "before") optimisticSubmitted = optimisticSubmitted - task.runId
            msg = when {
                r.isFailure -> "Yüklenemedi: ${r.exceptionOrNull()?.message ?: "internet?"}"
                stage == "before" -> "${paths.size} öncesi fotoğrafı kaydedildi. Görevi yap, sonra \"Tamamladım\"a bas."
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

    Card {
        Title("Görevlerim")
        if (tasks.isEmpty()) Muted("Bugün görev yok.")
        val focus = TaskFocus.taskId
        var lastGroup: String? = null
        for (raw in tasks) {
            val t = if (raw.runId in optimisticSubmitted) raw.copy(status = "submitted") else raw
            if (t.groupId != null && t.groupId != lastGroup) GroupHeader(t)
            lastGroup = t.groupId
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
                                else -> "Tamamladım"
                            }
                        )
                    }
                }
            }
        }
        if (msg.isNotEmpty()) Text(msg, color = C.good, fontSize = 13.sp)
    }
}
