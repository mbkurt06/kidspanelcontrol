package app.orbit.service

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Build
import android.os.PowerManager
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import app.orbit.R
import app.orbit.data.Api
import app.orbit.data.RecState
import app.orbit.data.Recorder
import app.orbit.ui.RecordActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Kameralı görev kaydı: ön plan servisi kamerayı açık tutar ve normal video (720p, sesli) kaydeder.
 * Her 3 dakikada bir yeni parça açılır; kapanan parçalar Wi‑Fi varken OneDrive'a (bağlı değilse Orbit deposuna) yüklenir.
 * Mola verilince parça kapanır, devam edince yenisi başlar.
 */
class RecordService : LifecycleService() {
    companion object {
        private const val TAG = "OrbitRecSvc"
        private const val CH = "orbit-rec"
        const val ACTION_START = "start"
        const val ACTION_PAUSE = "pause"
        const val ACTION_RESUME = "resume"
        const val ACTION_FINISH = "finish"
        const val ACTION_CANCEL = "cancel"
        /** Parça uzunluğu */
        private const val SEGMENT_MS = 3 * 60_000L

        @Volatile var running = false
            private set

        /** Servis kapandıktan sonra da biten ağ işleri için */
        private val ioScope = kotlinx.coroutines.CoroutineScope(Dispatchers.IO + kotlinx.coroutines.SupervisorJob())

        fun send(ctx: Context, action: String) {
            val i = Intent(ctx, RecordService::class.java).setAction(action)
            if (action == ACTION_START || action == ACTION_RESUME) ContextCompat.startForegroundService(ctx, i)
            else if (running) ctx.startService(i)
        }
    }

    private val camExec = Executors.newSingleThreadExecutor()
    private var provider: ProcessCameraProvider? = null
    private var boundCamera: String? = null
    private var videoCap: VideoCapture<androidx.camera.video.Recorder>? = null
    private var previewUc: Preview? = null
    private var recording: Recording? = null
    private var segStartMs = 0L
    private var rollover = false
    private var finishing = false
    private var realtimeSent = false
    private var lastPreviewMs = 0L
    private var lastFrameSeen = 0L
    private var hasAnalysis = false
    private var surfaceWatch = false
    private var wake: PowerManager.WakeLock? = null
    private var ticking = false

    override fun onCreate() {
        super.onCreate()
        running = true
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Görev kaydı", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        app.orbit.device.Policy.grantSelf(this, Manifest.permission.RECORD_AUDIO)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val s = Recorder.current()
        if (s == null || !s.active) {
            if (!finishing) stopSelf()
            return START_NOT_STICKY
        }
        Recorder.lastAlive = System.currentTimeMillis()
        goForeground(s)
        when (intent?.action) {
            ACTION_PAUSE -> pause()
            ACTION_RESUME -> resume()
            ACTION_FINISH -> finish(cancelled = false)
            ACTION_CANCEL -> finish(cancelled = true)
            else -> {}
        }
        Recorder.current()?.takeIf { it.active }?.let { bindCamera(it) }
        if (!ticking) {
            ticking = true
            lifecycleScope.launch { tickLoop() }
            if (!surfaceWatch) {
                surfaceWatch = true
                lifecycleScope.launch { Recorder.previewSurface.collect { sp -> previewUc?.setSurfaceProvider(sp) } }
            }
        }
        return START_NOT_STICKY
    }

    private fun goForeground(s: RecState) {
        val pi = PendingIntent.getActivity(this, 7, Intent(this, RecordActivity::class.java).putExtra("runId", s.runId), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle("📹 Kayıt: ${s.title}")
            .setContentText(if (s.status == "paused") "Mola" else "Kayıt sürüyor")
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        if (Build.VERSION.SDK_INT >= 30) runCatching { startForeground(3, n, type) }.onFailure { startForeground(3, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA) }
        else startForeground(3, n)
        if (wake == null) {
            wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "orbit:rec").apply { acquire(4 * 3600_000L) }
        }
    }

    private fun bindCamera(s: RecState) {
        if (provider != null && boundCamera == s.camera) { startSegment(); return }
        val f = ProcessCameraProvider.getInstance(this)
        f.addListener({
            runCatching {
                val p = f.get()
                provider = p
                recording?.stop()
                p.unbindAll()
                // Küçük görüntü: önizleme ve "kamera görüntü veriyor mu" denetimi
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                            .build()
                    )
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(camExec) { img -> onFrame(img) }
                val recorder = androidx.camera.video.Recorder.Builder()
                    .setQualitySelector(QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.HD)))
                    .setTargetVideoEncodingBitRate(2_000_000)
                    .build()
                val vc = VideoCapture.withOutput(recorder)
                val sel = if (s.camera == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                // Akıcı önizleme (Preview) + canlılık (ImageAnalysis) + video; zayıf kameralarda üçü birden olmazsa adım adım azalt
                val pv = Preview.Builder().build()
                val combos: List<Array<UseCase>> = listOf(arrayOf(pv, analysis, vc), arrayOf(pv, vc), arrayOf(analysis, vc))
                var bound: Array<UseCase>? = null
                for (c in combos) {
                    val ok = runCatching { p.unbindAll(); p.bindToLifecycle(this, sel, *c) }
                    if (ok.isSuccess) { bound = c; break } else Log.w(TAG, "kamera eşleşmesi olmadı: ${c.size}", ok.exceptionOrNull())
                }
                if (bound == null) throw IllegalStateException("kamera kullanılamıyor")
                previewUc = if (pv in bound) pv else null
                hasAnalysis = analysis in bound
                Recorder.livePreview.value = previewUc != null
                previewUc?.setSurfaceProvider(Recorder.previewSurface.value)
                if (previewUc != null) Recorder.preview.value = null
                videoCap = vc
                boundCamera = s.camera
                Recorder.error.value = null
                startSegment()
            }.onFailure {
                Log.e(TAG, "kamera açılamadı", it)
                Recorder.error.value = "Kamera açılamadı: ${it.message ?: "bilinmeyen hata"}"
            }
        }, ContextCompat.getMainExecutor(this))
    }

    /** Kamera iş parçacığı: canlılık ve saniyede bir önizleme */
    private fun onFrame(img: ImageProxy) {
        try {
            val now = System.currentTimeMillis()
            lastFrameSeen = now
            if (previewUc != null || now - lastPreviewMs < 1000) return
            lastPreviewMs = now
            val rot = img.imageInfo.rotationDegrees
            runCatching {
                val b = img.toBitmap()
                val w = 360
                val h = (b.height * w / b.width.toFloat()).toInt().coerceAtLeast(1)
                val m = Matrix().apply { postScale(w / b.width.toFloat(), h / b.height.toFloat()); postRotate(rot.toFloat()) }
                Recorder.preview.value = Bitmap.createBitmap(b, 0, 0, b.width, b.height, m, true)
                b.recycle()
            }
        } catch (e: Exception) {
            Log.e(TAG, "kare işlenemedi", e)
        } finally {
            img.close()
        }
    }

    /** Ana iş parçacığında: yeni video parçası başlat */
    @SuppressLint("MissingPermission")
    private fun startSegment() {
        if (recording != null || finishing) return
        val vc = videoCap ?: return
        val s = Recorder.current() ?: return
        if (s.status != "recording") return
        val start = System.currentTimeMillis()
        val file = Recorder.segmentFile(s.id, start / 1000)
        segStartMs = start
        var pending = vc.output.prepareRecording(this, FileOutputOptions.Builder(file).build())
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) pending = pending.withAudioEnabled()
        recording = runCatching {
            pending.start(ContextCompat.getMainExecutor(this)) { ev ->
                // Kamera analizi yoksa canlılık video kaydının ilerlemesinden anlaşılır
                if (ev is VideoRecordEvent.Status && !hasAnalysis) lastFrameSeen = System.currentTimeMillis()
                if (ev is VideoRecordEvent.Finalize) onFinalized(ev, file, start, s.id, s.runId)
            }
        }.onFailure { Log.e(TAG, "kayıt başlatılamadı", it); Recorder.error.value = "Kayıt başlatılamadı" }.getOrNull()
        if (!realtimeSent) {
            realtimeSent = true
            net { Api.rpc("device_record_realtime", JSONObject().put("p_id", s.id)) }
        }
    }

    private fun onFinalized(ev: VideoRecordEvent.Finalize, file: File, start: Long, recId: String, runId: String) {
        recording = null
        val dur = (ev.recordingStats.recordedDurationNanos / 1_000_000_000L).toInt()
        if (file.exists() && file.length() > 0 && dur > 0) {
            Recorder.segmentClosed(recId, runId, file, dur * 30, start, start + dur * 1000L)
        } else {
            if (ev.hasError()) Log.w(TAG, "parça kaydedilemedi: ${ev.error}", ev.cause)
            file.delete()
        }
        net { Recorder.pump() }
        if (finishing) { stopAll(); return }
        if (rollover) { rollover = false; startSegment() }
    }

    private fun closeSegment() {
        recording?.stop()
    }

    private fun pause() {
        val s = Recorder.current() ?: return
        if (s.status != "recording" || !s.canPause) return
        val n = Recorder.update { it.copy(status = "paused", pauseCount = it.pauseCount + 1) } ?: return
        closeSegment()
        net { Recorder.push(n, JSONObject().put("type", "pause")) }
        goForeground(n)
    }

    private fun resume(auto: Boolean = false) {
        val s = Recorder.current() ?: return
        if (s.status != "paused") return
        val n = Recorder.update { it.copy(status = "recording") } ?: return
        net { Recorder.push(n, JSONObject().put("type", "resume").apply { if (auto) put("note", "mola hakkı bitti") }) }
        goForeground(n)
        startSegment()
    }

    private fun finish(cancelled: Boolean) {
        val s = Recorder.current() ?: return
        if (!s.active) return
        val n = Recorder.update { it.copy(status = if (cancelled) "cancelled" else "done") } ?: return
        finishing = true
        net {
            Recorder.push(n, JSONObject().put("type", if (cancelled) "cancel" else "done"))
            Recorder.submitIfAuto(n)
            Live.syncRequested = true
        }
        if (recording != null) closeSegment() else stopAll()
    }

    private fun net(block: () -> Unit) {
        ioScope.launch { runCatching(block).onFailure { Log.w(TAG, "ağ", it) } }
    }

    private suspend fun tickLoop() {
        var last = System.currentTimeMillis()
        var lastPush = 0L
        var gapReported = false
        while (lifecycleScope.isActive && running) {
            delay(1000)
            val now = System.currentTimeMillis()
            Recorder.lastAlive = now
            val dt = ((now - last) / 1000).toInt().coerceIn(0, 5)
            last = now
            val s = Recorder.current() ?: break
            if (!s.active) break
            if (s.status == "recording") {
                // Kamera görüntü vermiyorsa (başka uygulama kamerayı aldı vb.) süre sayılmaz
                val camOk = now - lastFrameSeen < 5_000
                if (camOk) {
                    gapReported = false
                    val n = Recorder.update { it.copy(recordedSeconds = it.recordedSeconds + dt) } ?: break
                    if (n.recordedSeconds >= n.plannedSeconds) { finish(cancelled = false); break }
                    if (recording != null && !rollover && now - segStartMs > SEGMENT_MS) { rollover = true; closeSegment() }
                    if (recording == null && !rollover) startSegment()
                } else if (!gapReported && now - lastFrameSeen > 15_000 && lastFrameSeen > 0) {
                    gapReported = true
                    net { Recorder.push(s, JSONObject().put("type", "gap").put("note", "kamera görüntü vermiyor")) }
                    boundCamera = null
                    provider = null
                    bindCamera(s)
                }
            } else if (s.status == "paused") {
                val n = Recorder.update { it.copy(pausedSeconds = it.pausedSeconds + dt) } ?: break
                if (n.pausePolicy == "limit" && n.pauseLeftSeconds <= 0) resume(auto = true)
            }
            if (now - lastPush > 60_000) {
                lastPush = now
                Recorder.current()?.let { cur -> net { Recorder.push(cur) } }
            }
        }
        ticking = false
    }

    private fun stopAll() {
        running = false
        runCatching { provider?.unbindAll() }
        provider = null
        boundCamera = null
        wake?.let { if (it.isHeld) it.release() }
        wake = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        runCatching { recording?.stop() }
        camExec.shutdown()
        runCatching { provider?.unbindAll() }
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}

