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

private fun statusText(t: TaskItem) = when (t.status) {
    "open" -> null
    "started" -> "Başladın — bitince \"Tamamladım\"a bas"
    "submitted" -> "Ebeveyn onayı bekleniyor"
    "approved" -> "Onaylandı" + (t.rewardMinutes?.let { " · +$it dk" } ?: "")
    "rejected" -> "Tekrar yap" + (t.rejectNote?.let { ": $it" } ?: "")
    "claimed" -> "Kardeşin yaptı"
    "expired" -> "Süresi doldu"
    else -> t.status
}

private fun rewardText(t: TaskItem): String? {
    val parts = mutableListOf<String>()
    t.rewardMinutes?.let {
        parts += "+$it dk" + when (t.rewardValidity) {
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

private fun mediaFor(proof: String) = when (proof) {
    "video" -> "video"
    "photo_or_video" -> "either"
    else -> "photo"
}

/** Görevler: başla (öncesi kanıtı), tamamladım (sonrası/kanıt), gönder. */
@Composable
fun TasksCard(tasks: List<TaskItem>) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<Pair<TaskItem, String>?>(null) }
    var busyRun by remember { mutableStateOf<String?>(null) }
    var msg by remember { mutableStateOf("") }

    fun submit(t: TaskItem) {
        busyRun = t.runId
        scope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { Sync.submitTask(t.runId) } }
            busyRun = null
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
        val path = res.data?.getStringExtra("path") ?: return@rememberLauncherForActivityResult
        val media = res.data?.getStringExtra("media") ?: "photo"
        val (task, stage) = p
        busyRun = task.runId
        msg = "Yükleniyor…"
        scope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    val f = File(path)
                    Sync.uploadProof(task.runId, stage, media, f.readBytes(), if (media == "video") "video/mp4" else "image/jpeg")
                    f.delete()
                    if (stage != "before") Sync.submitTask(task.runId)
                }
            }
            busyRun = null
            msg = when {
                r.isFailure -> "Yüklenemedi: ${r.exceptionOrNull()?.message ?: "internet?"}"
                stage == "before" -> "Öncesi kaydedildi. Görevi yap, sonra \"Tamamladım\"a bas."
                else -> "\"${task.title}\" gönderildi, onay bekleniyor"
            }
            Live.syncRequested = true
        }
    }

    fun capture(t: TaskItem, stage: String) {
        pending = t to stage
        val title = when (stage) {
            "before" -> "${t.title} — öncesi"
            "after" -> "${t.title} — sonrası"
            else -> t.title
        }
        launcher.launch(Intent(ctx, CaptureActivity::class.java).putExtra("media", mediaFor(t.proof)).putExtra("title", title))
    }

    Card {
        Title("Görevlerim")
        if (tasks.isEmpty()) Muted("Bugün görev yok.")
        for (t in tasks) {
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(C.surface2).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t.title, color = C.text, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                    if (t.mandatory && t.open) Text("zorunlu", color = C.warn, fontSize = 12.sp)
                }
                t.description?.let { Muted(it, 13) }
                rewardText(t)?.let { Text("Ödül: $it", color = C.good, fontSize = 13.sp) }
                val due = listOfNotNull(t.dueDate?.let { "son gün $it" }, t.dueTime?.let { "$it'e kadar" }).joinToString(" · ")
                if (due.isNotBlank()) Muted(due, 12)
                if (t.firstWins && t.open) Muted("İlk yapan alır", 12)
                statusText(t)?.let {
                    Text(it, color = if (t.status == "rejected") C.warn else if (t.status == "approved") C.good else C.muted, fontSize = 13.sp)
                }
                if (t.open && t.needsRecording) {
                    val rec = app.orbit.data.Recorder.current()?.takeIf { it.runId == t.runId }
                    when {
                        rec?.active == true || (!t.recordingDone && !(t.needsProof && t.beforeAfter && !t.hasBefore)) -> Button(
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
                val recordFirst = t.needsRecording && !t.recordingDone && !(t.needsProof && t.beforeAfter && !t.hasBefore)
                if (t.open && !recordFirst && !(t.needsRecording && app.orbit.data.Recorder.current()?.let { it.runId == t.runId && it.active } == true)) {
                    val busy = busyRun == t.runId
                    val needBefore = t.needsProof && t.beforeAfter && !t.hasBefore
                    Button(
                        onClick = {
                            when {
                                needBefore -> capture(t, "before")
                                t.needsProof -> capture(t, if (t.beforeAfter) "after" else "single")
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
                                needBefore -> "Başla (öncesi ${if (t.proof == "video") "videosu" else "fotoğrafı"})"
                                t.needsProof -> "Tamamladım (${if (t.beforeAfter) "sonrası " else ""}${if (t.proof == "video") "video" else "fotoğraf"})"
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
