package app.orbit.ui

import android.widget.Toast

import kotlinx.coroutines.delay

import androidx.compose.runtime.LaunchedEffect

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import app.orbit.data.Recorder
import app.orbit.data.TaskItem
import app.orbit.data.Tasks
import app.orbit.service.Live
import app.orbit.service.RecordService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Kameralı görev ekranı: başlat, mola, bitir. Kayıt sürerken ekran açık kalır, dokununca karartılır/aydınlanır. */
class RecordActivity : ComponentActivity() {
    private var dim by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            app.orbit.device.Policy.grantSelf(this, Manifest.permission.CAMERA)
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
            }
        }
        val runId = intent.getStringExtra("runId") ?: Recorder.current()?.runId
        setContent { OrbitTheme { Screen(runId) } }
    }

    private fun applyDim(on: Boolean) {
        dim = on
        window.attributes = window.attributes.apply { screenBrightness = if (on) 0.02f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE }
    }

    @Composable
    private fun Screen(runId: String?) {
        val state by Recorder.state.collectAsState()
        val task = remember(runId) { Tasks.current().firstOrNull { it.runId == runId } }
        // İade sonrası yeni deneme: ekran açılırken duran eski (bitmiş) kayıt yok sayılır; bu ekranda yeni biten kayıt gösterilir
        val staleId = remember(runId) {
            Recorder.state.value?.takeIf { !it.active && it.runId == runId && task?.status == "rejected" }?.id
        }
        val s = state?.takeIf { it.runId == runId || runId == null }?.takeIf { it.id != staleId }
        Column(
            Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()
                .clickable(enabled = s?.status == "recording") { applyDim(!dim) },
        ) {
            when {
                s != null && s.active && s.reached -> Reached(task)
                s != null && s.active -> Recording()
                s != null -> Finished()
                // Kayıt bitip gönderildiyse (ya da görev onaylandıysa) başlangıç ekranı tekrar açılmasın: Orbit ana ekranına dön
                task != null && !startable(task) -> LaunchedEffect(Unit) { finish() }
                task != null -> Start(task)
                else -> Column(Modifier.padding(20.dp)) {
                    Muted("Görev bulunamadı.")
                    Button(onClick = { finish() }) { Text("Kapat") }
                }
            }
        }
    }

    /** Yeni kayıt başlatılabilir mi: görev açık ve kaydı bitmemiş (ya da iade edilip yeniden istenmiş) */
    private fun startable(t: TaskItem): Boolean {
        val live = Tasks.current().firstOrNull { it.runId == t.runId } ?: t
        return live.open && (live.status == "rejected" || !live.recordingDone)
    }

    @Composable
    private fun Start(t: TaskItem) {
        val scope = rememberCoroutineScope()
        var cam by remember { mutableStateOf(if (t.recordCamera == "front") "front" else "back") }
        var busy by remember { mutableStateOf(false) }
        var msg by remember { mutableStateOf("") }
        Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("📹 ${t.title}", color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text(t.recordMinMinutes?.let { "En az $it, en fazla ${t.recordMinutes} dakika kayıt" } ?: "${t.recordMinutes} dakika kayıt", color = C.accent, fontSize = 18.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Info("Telefonu sabit bir yere koy; kamera seni ve çalıştığın yeri görsün. Kayıt sırasında diğer uygulamalar kapalı olur.")
            }
            Muted(
                when (t.recordPause) {
                    "none" -> "Bu görevde mola yok."
                    "limit" -> "Toplam ${t.recordPauseMax ?: 0} dk mola verebilirsin."
                    else -> "İstediğinde mola verebilirsin; mola süresi kayda sayılmaz."
                }
            )
            if (t.recordCamera == "choose") {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for ((k, label) in listOf("back" to "Arka kamera", "front" to "Ön kamera")) {
                        Button(
                            onClick = { cam = k },
                            colors = ButtonDefaults.buttonColors(containerColor = if (cam == k) C.accent else C.surface2),
                        ) { Text(label) }
                    }
                }
            } else {
                Muted(if (cam == "front") "Ön kamera kullanılacak." else "Arka kamera kullanılacak.")
            }
            Spacer(Modifier.weight(1f))
            if (msg.isNotEmpty()) Text(msg, color = C.bad)
            Button(
                enabled = !busy,
                onClick = {
                    if (ContextCompat.checkSelfPermission(this@RecordActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                        msg = "Kamera izni gerekli"
                        requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
                        return@Button
                    }
                    busy = true
                    scope.launch {
                        val err = withContext(Dispatchers.IO) { Recorder.begin(t, cam) }
                        busy = false
                        if (err != null) msg = err
                        else {
                            RecordService.send(this@RecordActivity, RecordService.ACTION_START)
                            Live.syncRequested = true
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().height(60.dp),
                colors = ButtonDefaults.buttonColors(containerColor = C.bad),
            ) { Text(if (busy) "Başlatılıyor…" else "● Kayda başla", fontSize = 18.sp) }
            OutlinedButton(onClick = { finish() }, modifier = Modifier.fillMaxWidth()) { Text("Vazgeç") }
        }
    }

    /** Kameranın akıcı canlı görüntüsü (kaydın kendisi serviste sürer) */
    @Composable
    private fun LivePreview() {
        AndroidView(
            factory = { ctx ->
                PreviewView(ctx).apply {
                    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                    scaleType = PreviewView.ScaleType.FIT_CENTER
                    Recorder.previewSurface.value = surfaceProvider
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
        DisposableEffect(Unit) { onDispose { Recorder.previewSurface.value = null } }
    }

    @Composable
    private fun Recording() {
        val s by Recorder.state.collectAsState()
        val st = s ?: return
        val bmp by Recorder.preview.collectAsState()
        val err by Recorder.error.collectAsState()
        var confirm by remember { mutableStateOf(false) }
        val recording = st.status == "recording"
        // Servis kapanmışsa (telefon yeniden başladı vb.) mola durumunda kalır; devam düğmesi servisi yeniden açar

        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (recording) "● KAYIT" else "❚❚ MOLA", color = if (recording) C.bad else C.warn, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                Text(st.title, color = C.muted, fontSize = 14.sp)
            }
            Box(
                Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(16.dp)).background(C.surface),
                contentAlignment = Alignment.Center,
            ) {
                val b = bmp
                val live by Recorder.livePreview.collectAsState()
                if (dim) Muted("Ekran karartıldı — kayıt sürüyor. Dokun.")
                else if (live) LivePreview()
                else if (b != null) Image(b.asImageBitmap(), null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                else Muted("Kamera açılıyor…")
            }
            err?.let { Text(it, color = C.bad) }
            Text(
                "${clock(st.recordedSeconds)} / ${clock(st.plannedSeconds)}",
                color = C.text, fontSize = 40.sp, fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            LinearProgressIndicator(
                progress = { (st.recordedSeconds.toFloat() / st.plannedSeconds.coerceAtLeast(1)).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(), color = C.accent,
            )
            val pauseInfo = when (st.pausePolicy) {
                "none" -> "Mola yok"
                "limit" -> "Mola hakkı: ${clock(st.pauseLeftSeconds)}"
                else -> if (st.pausedSeconds > 0) "Mola: ${clock(st.pausedSeconds)}" else ""
            }
            if (pauseInfo.isNotEmpty()) Muted(pauseInfo, 13)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (recording && st.canPause) {
                    Button(
                        onClick = { RecordService.send(this@RecordActivity, RecordService.ACTION_PAUSE) },
                        modifier = Modifier.weight(1f).height(56.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = C.surface2),
                    ) { Text("Mola") }
                }
                if (!recording) {
                    Button(
                        onClick = { RecordService.send(this@RecordActivity, RecordService.ACTION_RESUME) },
                        modifier = Modifier.weight(1f).height(56.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = C.accent),
                    ) { Text("Devam et") }
                }
                Button(
                    onClick = { confirm = true },
                    modifier = Modifier.weight(1f).height(56.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = C.bad),
                ) { Text("Bitir") }
            }
        }
        val minSec = remember(st.runId) { Tasks.current().firstOrNull { it.runId == st.runId }?.recordMinMinutes?.times(60) }
        if (confirm && minSec != null && st.recordedSeconds < minSec) {
            AlertDialog(
                onDismissRequest = { confirm = false },
                title = { Text("Biraz daha") },
                text = { Text("Bu görev için en az ${minSec / 60} dakika kayıt gerekli. Şu an ${clock(st.recordedSeconds)}. ${clock(minSec - st.recordedSeconds)} sonra bitirebilirsin.") },
                confirmButton = { TextButton(onClick = { confirm = false }) { Text("Devam") } },
            )
        } else if (confirm) {
            val early = st.recordedSeconds < st.plannedSeconds
            AlertDialog(
                onDismissRequest = { confirm = false },
                title = { Text("Kaydı bitir?") },
                text = { Text(if (early) "Süre dolmadı (${clock(st.recordedSeconds)}). Erken bitirirsen ebeveynine bildirilir." else "Kayıt tamamlandı.") },
                confirmButton = {
                    TextButton(onClick = {
                        confirm = false
                        if (RecordService.running) RecordService.send(this@RecordActivity, RecordService.ACTION_FINISH)
                        else {
                            // Servis yoksa (kesinti sonrası) durumu doğrudan kapat
                            val n = Recorder.update { it.copy(status = "done") }
                            if (n != null) Thread {
                                Recorder.push(n, org.json.JSONObject().put("type", "done"))
                                Recorder.submitIfAuto(n)
                                Recorder.pump()
                                Live.syncRequested = true
                            }.start()
                        }
                    }) { Text("Bitir") }
                },
                dismissButton = { TextButton(onClick = { confirm = false }) { Text("Devam") } },
            )
        }
    }

    /** İstenen süre doldu: onaya gönder / fazladan devam / baştan çek */
    @Composable
    private fun Reached(task: TaskItem?) {
        val s by Recorder.state.collectAsState()
        val st = s ?: return
        val scope = rememberCoroutineScope()
        var askRestart by remember { mutableStateOf(false) }
        var busy by remember { mutableStateOf(false) }
        var left by remember { mutableStateOf(0) }
        LaunchedEffect(st.reachedAt) {
            while (true) {
                left = (((st.reachedAt + RecordService.REVIEW_TIMEOUT_MS) - System.currentTimeMillis()) / 1000).toInt().coerceAtLeast(0)
                delay(1000)
            }
        }
        Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("✅ Kayıt süresi tamamlandı", color = C.text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Muted("${st.title} · ${clock(st.recordedSeconds)} kayıt")
            Muted(
                if (st.autoSubmit) "Seçmezsen ${left} sn sonra kendiliğinden onaya gönderilir."
                else "Seçmezsen ${left} sn sonra kayıt kaydedilir; görevin kalan adımlarını Görevlerim'den tamamla.",
                13,
            )
            Spacer(Modifier.weight(1f))
            Button(
                enabled = !busy,
                onClick = { RecordService.send(this@RecordActivity, RecordService.ACTION_FINISH) },
                modifier = Modifier.fillMaxWidth().height(60.dp),
                colors = ButtonDefaults.buttonColors(containerColor = C.accent),
            ) { Text(if (st.autoSubmit) "✓ Onaya gönder" else "✓ Kaydı bitir, göreve dön", fontSize = 18.sp) }
            Button(
                enabled = !busy,
                onClick = { RecordService.send(this@RecordActivity, RecordService.ACTION_EXTEND) },
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = C.surface2),
            ) { Text("▶ Devam et (fazladan kayıt)") }
            if (task != null) TextButton(
                enabled = !busy,
                onClick = { askRestart = true },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Baştan başlatılıyor…" else "↺ Baştan çek", color = C.bad) }
        }
        if (askRestart && task != null) AlertDialog(
            onDismissRequest = { askRestart = false },
            title = { Text("Baştan çekilsin mi?") },
            text = { Text("Bu kayıt (${clock(st.recordedSeconds)}) silinir ve yeni kayıt sıfırdan başlar.") },
            confirmButton = {
                TextButton(onClick = {
                    askRestart = false
                    busy = true
                    val cam = st.camera
                    RecordService.send(this@RecordActivity, RecordService.ACTION_CANCEL)
                    scope.launch {
                        // Eski kayıt kapanana kadar bekle, sonra yenisini başlat
                        var waited = 0
                        while ((RecordService.running || Recorder.current()?.active == true) && waited < 8000) { delay(200); waited += 200 }
                        val err = withContext(Dispatchers.IO) { Recorder.begin(task, cam) }
                        busy = false
                        if (err == null) { RecordService.send(this@RecordActivity, RecordService.ACTION_START); Live.syncRequested = true }
                        else Toast.makeText(this@RecordActivity, err, Toast.LENGTH_LONG).show()
                    }
                }) { Text("Baştan çek", color = C.bad) }
            },
            dismissButton = { TextButton(onClick = { askRestart = false }) { Text("Vazgeç") } },
        )
    }

    @Composable
    private fun Finished() {
        val s by Recorder.state.collectAsState()
        val pending by Recorder.pending.collectAsState()
        val st = s ?: return
        Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (st.status == "done") "✅ Kayıt tamamlandı" else "Kayıt iptal edildi", color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Muted("${st.title} · ${clock(st.recordedSeconds)} kayıt")
            Muted(if (pending > 0) "Yükleniyor: $pending parça kaldı (internet varken kendiliğinden yüklenir)." else "Kayıt ebeveynine gönderildi.")
            if (st.status == "done" && !st.autoSubmit) Muted("Görevi bitirmek için Görevlerim'de \"Tamamladım\"a bas.")
            Spacer(Modifier.weight(1f))
            Button(onClick = { finish() }, modifier = Modifier.fillMaxWidth().height(56.dp), colors = ButtonDefaults.buttonColors(containerColor = C.accent)) {
                Text("Kapat")
            }
        }
    }
}

private fun clock(sec: Int): String {
    val h = sec / 3600
    val m = (sec % 3600) / 60
    val s = sec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}
