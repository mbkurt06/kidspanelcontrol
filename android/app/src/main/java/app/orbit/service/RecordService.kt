package app.orbit.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.os.PowerManager
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import app.orbit.R
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
 * Kameralı görev kaydı: ön plan servisi kamerayı açık tutar, saniyede 2 kare alır ve
 * 40 kare/sn'lik H.264 videoya (zaman atlamalı) yazar. Her 10 dakikada bir yeni parça açılır,
 * kapanan parçalar Wi‑Fi/İnternet varken yüklenir. Mola verilince parça kapanır.
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
    private var encoder: SegmentEncoder? = null
    private var segStartMs = 0L
    private var lastFrameMs = 0L
    private var lastFrameSeen = 0L
    private var wake: PowerManager.WakeLock? = null
    private var ticking = false

    override fun onCreate() {
        super.onCreate()
        running = true
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Görev kaydı", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val s = Recorder.current()
        if (s == null || !s.active) {
            stopSelf()
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
        if (Build.VERSION.SDK_INT >= 30) startForeground(3, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA) else startForeground(3, n)
        if (wake == null) {
            wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "orbit:rec").apply { acquire(4 * 3600_000L) }
        }
    }

    private fun bindCamera(s: RecState) {
        if (provider != null && boundCamera == s.camera) return
        val f = ProcessCameraProvider.getInstance(this)
        f.addListener({
            runCatching {
                val p = f.get()
                provider = p
                p.unbindAll()
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                            .build()
                    )
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                    .build()
                analysis.setAnalyzer(camExec) { img -> onFrame(img) }
                val sel = if (s.camera == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                p.bindToLifecycle(this, sel, analysis)
                boundCamera = s.camera
                Recorder.error.value = null
            }.onFailure {
                Log.e(TAG, "kamera açılamadı", it)
                Recorder.error.value = "Kamera açılamadı: ${it.message ?: "bilinmeyen hata"}"
            }
        }, ContextCompat.getMainExecutor(this))
    }

    /** Kamera iş parçacığı: her 500 ms'de bir kareyi kodla ve önizlemeyi güncelle. */
    private fun onFrame(img: ImageProxy) {
        try {
            val now = System.currentTimeMillis()
            lastFrameSeen = now
            val s = Recorder.current() ?: return
            if (s.status != "recording" || now - lastFrameMs < Recorder.CAPTURE_INTERVAL_MS) return
            lastFrameMs = now
            val rot = img.imageInfo.rotationDegrees
            var enc = encoder
            if (enc == null) {
                val seq = now / 1000
                segStartMs = now
                enc = runCatching { SegmentEncoder(Recorder.segmentFile(s.id, seq), img.width and 1.inv(), img.height and 1.inv(), rot) }
                    .onFailure { Log.e(TAG, "kodlayıcı açılamadı", it); Recorder.error.value = "Kayıt başlatılamadı" }
                    .getOrNull() ?: return
                encoder = enc
            }
            enc.encode(img)
            if (enc.frames >= Recorder.SEGMENT_FRAMES) closeSegment()
            // Önizleme (küçük)
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

    /** Kamera iş parçacığında çağrılır. */
    private fun closeSegment() {
        val enc = encoder ?: return
        encoder = null
        val s = Recorder.current() ?: return
        runCatching { enc.finish() }.onFailure { Log.e(TAG, "parça kapatılamadı", it) }
        Recorder.segmentClosed(s.id, s.runId, enc.file, enc.frames, segStartMs, System.currentTimeMillis())
    }

    private fun pause() {
        val s = Recorder.current() ?: return
        if (s.status != "recording" || !s.canPause) return
        val n = Recorder.update { it.copy(status = "paused", pauseCount = it.pauseCount + 1) } ?: return
        camExec.execute { closeSegment() }
        net { Recorder.push(n, JSONObject().put("type", "pause")) }
        goForeground(n)
    }

    private fun resume(auto: Boolean = false) {
        val s = Recorder.current() ?: return
        if (s.status != "paused") return
        val n = Recorder.update { it.copy(status = "recording") } ?: return
        net { Recorder.push(n, JSONObject().put("type", "resume").apply { if (auto) put("note", "mola hakkı bitti") }) }
        goForeground(n)
    }

    private fun finish(cancelled: Boolean) {
        val s = Recorder.current() ?: return
        if (!s.active) return
        val n = Recorder.update { it.copy(status = if (cancelled) "cancelled" else "done") } ?: return
        camExec.execute {
            closeSegment()
            net {
                Recorder.push(n, JSONObject().put("type", if (cancelled) "cancel" else "done"))
                Recorder.submitIfAuto(n)
                Recorder.pump()
                Live.syncRequested = true
            }
        }
        stopAll()
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
                // Kamera kare vermiyorsa (başka uygulama kamerayı aldı vb.) süre sayılmaz
                val camOk = now - lastFrameSeen < 5_000
                if (camOk) {
                    gapReported = false
                    val n = Recorder.update { it.copy(recordedSeconds = it.recordedSeconds + dt) } ?: break
                    if (n.recordedSeconds >= n.plannedSeconds) { finish(cancelled = false); break }
                } else if (!gapReported && now - lastFrameSeen > 15_000 && lastFrameSeen > 0) {
                    gapReported = true
                    net { Recorder.push(s, JSONObject().put("type", "gap").put("note", "kamera görüntü vermiyor")) }
                    boundCamera = null
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
        camExec.execute { closeSegment() }
        camExec.shutdown()
        runCatching { provider?.unbindAll() }
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}

/** Tek bir video parçası: YUV kareleri H.264 olarak MP4'e yazar (sabit 40 kare/sn zaman damgası). */
class SegmentEncoder(val file: File, private val w: Int, private val h: Int, rotation: Int) {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    private val muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private var track = -1
    private var started = false
    private val info = MediaCodec.BufferInfo()
    var frames = 0
        private set

    init {
        val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h)
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        f.setInteger(MediaFormat.KEY_BIT_RATE, 2_000_000)
        f.setInteger(MediaFormat.KEY_FRAME_RATE, Recorder.VIDEO_FPS)
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
        codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        muxer.setOrientationHint(rotation)
    }

    private fun pts(n: Int) = n * 1_000_000L / Recorder.VIDEO_FPS

    fun encode(img: ImageProxy) {
        val idx = codec.dequeueInputBuffer(20_000)
        if (idx < 0) { drain(false); return }
        val input = codec.getInputImage(idx)
        val size = w * h * 3 / 2
        if (input != null) {
            copyPlane(img.planes[0], input.planes[0], w, h)
            copyPlane(img.planes[1], input.planes[1], w / 2, h / 2)
            copyPlane(img.planes[2], input.planes[2], w / 2, h / 2)
        } else {
            // Yedek: düzlemsel I420
            val buf = codec.getInputBuffer(idx)!!
            buf.clear()
            writePlanar(img.planes[0], w, h, buf)
            writePlanar(img.planes[1], w / 2, h / 2, buf)
            writePlanar(img.planes[2], w / 2, h / 2, buf)
        }
        codec.queueInputBuffer(idx, 0, size, pts(frames), 0)
        frames++
        drain(false)
    }

    private fun copyPlane(src: ImageProxy.PlaneProxy, dst: android.media.Image.Plane, pw: Int, ph: Int) {
        val s = src.buffer
        val d = dst.buffer
        val sp = src.pixelStride
        val dp = dst.pixelStride
        val sr = src.rowStride
        val dr = dst.rowStride
        if (sp == 1 && dp == 1) {
            val row = ByteArray(pw)
            for (y in 0 until ph) {
                s.position(y * sr); s.get(row, 0, minOf(pw, s.remaining()))
                d.position(y * dr); d.put(row, 0, minOf(pw, d.remaining()))
            }
        } else {
            val sl = s.limit()
            val dl = d.limit()
            for (y in 0 until ph) {
                val so = y * sr
                val doff = y * dr
                for (x in 0 until pw) {
                    val si = so + x * sp
                    val di = doff + x * dp
                    if (si < sl && di < dl) d.put(di, s.get(si))
                }
            }
        }
    }

    private fun writePlanar(src: ImageProxy.PlaneProxy, pw: Int, ph: Int, out: java.nio.ByteBuffer) {
        val s = src.buffer
        for (y in 0 until ph) for (x in 0 until pw) {
            val i = y * src.rowStride + x * src.pixelStride
            out.put(if (i < s.limit()) s.get(i) else 0)
        }
    }

    private fun drain(eos: Boolean) {
        var tries = 0
        while (true) {
            val i = codec.dequeueOutputBuffer(info, if (eos) 10_000 else 0)
            when {
                i == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                    if (!eos || ++tries > 200) return
                }
                i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    started = true
                }
                i >= 0 -> {
                    val buf = codec.getOutputBuffer(i)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                    if (info.size > 0 && started && buf != null) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        muxer.writeSampleData(track, buf, info)
                    }
                    codec.releaseOutputBuffer(i, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
            }
        }
    }

    fun finish() {
        try {
            val idx = codec.dequeueInputBuffer(50_000)
            if (idx >= 0) codec.queueInputBuffer(idx, 0, 0, pts(frames), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            drain(true)
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
            if (started) runCatching { muxer.stop() }
            runCatching { muxer.release() }
            if (!started || frames == 0) file.delete()
        }
    }
}
