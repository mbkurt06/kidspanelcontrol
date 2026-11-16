package app.orbit.service

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import app.orbit.R
import app.orbit.data.Api
import app.orbit.data.Recorder
import app.orbit.data.Sync
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.abs

/**
 * Görev kanıtı için ekran yakalama. Ekranda sürüklenebilir yuvarlak bir düğme durur:
 *  - shot: dokununca ekran görüntüsü alınır, önizlemede "Yeniden al" / "Ekle"; galeriye kaydedilmez.
 *  - record: ekran kaydı (2 kare/sn, zaman atlamalı); sayaç, en az süreye gelince uyarı, "Bitir" / "Baştan başla" / "Küçült".
 * Kayıt parçaları kamera kaydıyla aynı yoldan ([Recorder]) yüklenir.
 */
class ScreenCaptureService : Service() {
    companion object {
        private const val TAG = "OrbitScreen"
        private const val CH = "orbit-screen"
        const val ACT_SHOT = "app.orbit.screen.SHOT"
        const val ACT_DONE = "app.orbit.screen.DONE"
        const val ACT_PAUSE = "app.orbit.screen.PAUSE"
        const val ACT_RESTART = "app.orbit.screen.RESTART"
        @Volatile var running = false
            private set
        /** İzin penceresi açılırken (servis henüz başlamadan) kilit yumuşasın */
        @Volatile var preparingUntil = 0L
        fun active(now: Long) = running || now < preparingUntil
    }

    private lateinit var wm: WindowManager
    private val main = Handler(Looper.getMainLooper())
    private val worker = HandlerThread("orbit-screen").apply { start() }
    private val bg = Handler(worker.looper)
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var width = 0
    private var height = 0

    private var mode = "shot"
    private var runId = ""
    private var title = ""
    private var autoSubmit = false

    // Ekran görüntüsü
    private var shotCount = 0
    private var shotMin = 1
    private var shotMax = 1
    @Volatile private var wantShot = false

    // Ekran kaydı
    private var recId: String? = null
    private var recMin = 0
    private var recMax = 1800
    private var recorded = 0
    private var minReached = false
    @Volatile private var lastFrame: IntArray? = null
    private var lastCopy = 0L
    private var encoder: ScreenEncoder? = null
    private var segStart = 0L
    private var stopping = false
    private var paused = false
    private var pausedSec = 0
    private var pauseCount = 0
    private var allowed: List<String> = emptyList()

    // Yüzen düğme
    private var bubble: LinearLayout? = null
    private var bubbleText: TextView? = null
    private var bubbleSub: TextView? = null
    private var panel: LinearLayout? = null
    private var preview: LinearLayout? = null
    private var small = false
    private var bubbleParams: WindowManager.LayoutParams? = null
    // Üzerinde gösterme izni yoksa (Android Go gibi) kontroller bildirimde
    private var overlay = true
    private var lastNote = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        preparingUntil = 0L
        wm = getSystemService(WindowManager::class.java)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CH, "Ekran yakalama", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) }
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACT_SHOT -> { if (projection != null) { toast("2 sn sonra çekilecek, bildirim panelini kapat"); main.postDelayed({ takeShot() }, 1800) }; return START_NOT_STICKY }
            ACT_DONE -> { if (mode == "shot") finishShots() else finishRecording(); return START_NOT_STICKY }
            ACT_PAUSE -> { togglePause(); return START_NOT_STICKY }
            ACT_RESTART -> { restartRecording(); return START_NOT_STICKY }
        }
        if (intent == null || projection != null) return START_NOT_STICKY
        overlay = android.provider.Settings.canDrawOverlays(this)
        mode = intent.getStringExtra("mode") ?: "shot"
        runId = intent.getStringExtra("runId") ?: ""
        title = intent.getStringExtra("title") ?: "Görev"
        shotCount = intent.getIntExtra("shotCount", 0)
        shotMin = intent.getIntExtra("shotMin", 1)
        shotMax = intent.getIntExtra("shotMax", 1).coerceAtLeast(shotMin)
        recMin = intent.getIntExtra("recMin", 0)
        recMax = intent.getIntExtra("recMax", 1800).coerceAtLeast(60)
        autoSubmit = intent.getBooleanExtra("autoSubmit", false)
        allowed = intent.getStringArrayListExtra("allowed")?.toList().orEmpty()
        val n = Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_orbit)
            .setContentTitle(if (mode == "record") "🎬 Ekran kaydı: $title" else "📱 Ekran görüntüsü: $title")
            .setContentText("Yuvarlak düğmeyi kullan")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(5, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) else startForeground(5, n)

        val mpm = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        val data: Intent? = intent.getParcelableExtra("data")
        val code = intent.getIntExtra("resultCode", Activity.RESULT_CANCELED)
        val mp = runCatching { mpm.getMediaProjection(code, data!!) }.getOrNull()
        if (mp == null) { toast("Ekran yakalama başlatılamadı"); stopAll(); return START_NOT_STICKY }
        projection = mp
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { main.post { onProjectionStopped() } }
        }, main)
        setupDisplay(mp)
        if (overlay) showBubble() else updateNote(force = true)
        if (mode == "record") startRecording()
        return START_NOT_STICKY
    }

    // ---------------------------------------------------------------- yakalama

    private fun setupDisplay(mp: MediaProjection) {
        val m = resources.displayMetrics
        val scale = if (mode == "record") minOf(1f, 720f / m.widthPixels) else minOf(1f, 1080f / m.widthPixels)
        width = ((m.widthPixels * scale).toInt() / 16) * 16
        height = ((m.heightPixels * scale).toInt() / 16) * 16
        if (mode == "record") {
            // Normal video: ekran doğrudan video kodlayıcıya (MediaRecorder) yazılır
            display = mp.createVirtualDisplay("orbit-screen", width, height, m.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, bg)
            return
        }
        val r = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        reader = r
        r.setOnImageAvailableListener({ rd ->
            val img = runCatching { rd.acquireLatestImage() }.getOrNull() ?: return@setOnImageAvailableListener
            try {
                val now = System.currentTimeMillis()
                val take = wantShot || (mode == "record" && now - lastCopy >= 250)
                if (!take) return@setOnImageAvailableListener
                val plane = img.planes[0]
                val buf = plane.buffer
                val ps = plane.pixelStride
                val rs = plane.rowStride
                val px = IntArray(width * height)
                for (y in 0 until height) {
                    var o = y * rs
                    for (x in 0 until width) {
                        val r0 = buf.get(o).toInt() and 0xff
                        val g0 = buf.get(o + 1).toInt() and 0xff
                        val b0 = buf.get(o + 2).toInt() and 0xff
                        px[y * width + x] = (0xff shl 24) or (r0 shl 16) or (g0 shl 8) or b0
                        o += ps
                    }
                }
                if (wantShot) {
                    wantShot = false
                    val bmp = Bitmap.createBitmap(px, width, height, Bitmap.Config.ARGB_8888)
                    main.post { showPreview(bmp) }
                } else {
                    lastCopy = now
                    lastFrame = px
                }
            } catch (e: Exception) {
                Log.w(TAG, "kare", e)
            } finally {
                img.close()
            }
        }, bg)
        display = mp.createVirtualDisplay("orbit-screen", width, height, m.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, bg)
    }

    // ---------------------------------------------------------------- ekran görüntüsü

    private fun takeShot() {
        if (preview != null) return
        bubble?.visibility = View.INVISIBLE
        main.postDelayed({ wantShot = true }, 220)
        // Ekran değişmezse yeni kare gelmeyebilir: düğme gizlendiği için en az bir kare gelir; yine de 2 sn sonra geri getir
        main.postDelayed({ if (preview == null) bubble?.visibility = View.VISIBLE }, 2500)
    }

    private fun showPreview(bmp: Bitmap) {
        // Önizleme penceresi açılamıyorsa doğrudan ekle
        if (!overlay) { toast("Ekran görüntüsü ${shotCount + 1} eklendi"); upload(bmp); return }
        bubble?.visibility = View.VISIBLE
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = round(Color.parseColor("#F0171B33"), dp(18).toFloat())
        }
        box.addView(TextView(this).apply { text = "Ekran görüntüsü ${shotCount + 1}"; setTextColor(Color.WHITE); textSize = 16f })
        val iv = ImageView(this).apply { setImageBitmap(bmp); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER }
        box.addView(iv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(380)).apply { topMargin = dp(10); bottomMargin = dp(10) })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(btn("Yeniden al", "#2B3157") { closePreview(); takeShot() }, LinearLayout.LayoutParams(0, dp(48), 1f).apply { rightMargin = dp(8) })
        row.addView(btn("Ekle", "#7C5CFF") { closePreview(); upload(bmp) }, LinearLayout.LayoutParams(0, dp(48), 1f))
        box.addView(row)
        val p = overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.CENTER; width = (resources.displayMetrics.widthPixels * 0.88f).toInt()
        }
        preview = box
        runCatching { wm.addView(box, p) }
    }

    private fun closePreview() {
        preview?.let { runCatching { wm.removeView(it) } }
        preview = null
    }

    private fun upload(bmp: Bitmap) {
        shotCount++
        updateBubble()
        bg.post {
            val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
            val ok = runCatching { Sync.uploadProof(runId, "screenshot", "photo", bytes, "image/jpeg") }
                .onFailure { Log.w(TAG, "yüklenemedi", it) }.isSuccess
            main.post {
                if (!ok) { shotCount--; toast("Yüklenemedi, internet?"); updateBubble(); return@post }
                Live.syncRequested = true
                if (shotCount >= shotMax) {
                    toast("$shotCount ekran görüntüsü eklendi")
                    finishShots()
                }
            }
        }
    }

    private fun finishShots() {
        if (autoSubmit && shotCount >= shotMin) bg.post { runCatching { Sync.submitTask(runId) }; Live.syncRequested = true }
        stopAll()
    }

    // ---------------------------------------------------------------- ekran kaydı

    private fun startRecording() {
        bg.post {
            val r = runCatching { JSONObject(Api.rpc("device_record_start", JSONObject().put("p_run", runId).put("p_camera", "screen"))) }
                .onFailure { Log.w(TAG, "kayıt başlatılamadı", it) }.getOrNull()
            main.post {
                if (r == null) { toast("Kayıt başlatılamadı (internet?)"); stopAll(); return@post }
                recId = r.getString("id")
                recorded = r.optInt("recorded_seconds")
                pausedSec = r.optInt("paused_seconds")
                pauseCount = r.optInt("pause_count")
                paused = false
                lockToTask()
                minReached = recorded >= recMin
                updateBubble()
                main.post(tick)
                startSeg()
            }
        }
    }

    private val frameLoop = Runnable { }
    private var mr: android.media.MediaRecorder? = null
    private var segFile: File? = null
    private var realtimeSent = false

    /** Yeni video parçası (ana iş parçacığı) */
    private fun startSeg() {
        if (mr != null || stopping || paused) return
        val id = recId ?: return
        val d = display ?: return
        val now = System.currentTimeMillis()
        val f = Recorder.segmentFile(id, now / 1000)
        val r = (if (Build.VERSION.SDK_INT >= 31) android.media.MediaRecorder(this) else @Suppress("DEPRECATION") android.media.MediaRecorder())
        runCatching {
            r.setVideoSource(android.media.MediaRecorder.VideoSource.SURFACE)
            r.setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4)
            r.setVideoEncoder(android.media.MediaRecorder.VideoEncoder.H264)
            r.setVideoSize(width, height)
            r.setVideoFrameRate(30)
            r.setVideoEncodingBitRate(1_500_000)
            r.setOutputFile(f.path)
            r.prepare()
            d.surface = r.surface
            r.start()
        }.onFailure {
            Log.e(TAG, "ekran kaydı başlatılamadı", it)
            runCatching { r.release() }
            toast("Ekran kaydı başlatılamadı")
            return
        }
        mr = r
        segFile = f
        segStart = now
        if (!realtimeSent) {
            realtimeSent = true
            bg.post { runCatching { Api.rpc("device_record_realtime", JSONObject().put("p_id", id)) } }
        }
    }

    /** Parçayı kapat ve yükleme sırasına ekle */
    private fun closeSegment() {
        val r = mr ?: return
        mr = null
        val f = segFile
        segFile = null
        val ok = runCatching { r.stop() }.isSuccess
        runCatching { r.release() }
        runCatching { display?.surface = null }
        val end = System.currentTimeMillis()
        val dur = ((end - segStart) / 1000).toInt()
        val id = recId
        if (f != null && id != null && ok && dur > 0) Recorder.segmentClosed(id, runId, f, dur * 30, segStart, end) else f?.delete()
    }

    private var lastPush = 0L
    private val tick = object : Runnable {
        override fun run() {
            if (stopping || recId == null) return
            if (paused) { pausedSec++; updateBubble(); main.postDelayed(this, 1000); return }
            recorded++
            if (mr != null && System.currentTimeMillis() - segStart > 3 * 60_000L) { closeSegment(); startSeg() }
            if (mr == null) startSeg()
            if (!minReached && recorded >= recMin) {
                minReached = true
                vibrate()
                toast(if (recMin > 0) "En az süre doldu, artık bitirebilirsin" else "Kayıt sürüyor")
            }
            updateBubble()
            val now = System.currentTimeMillis()
            if (now - lastPush > 60_000) { lastPush = now; push("recording", null) }
            if (recorded >= recMax) { finishRecording(); return }
            main.postDelayed(this, 1000)
        }
    }

    private fun push(status: String, event: String?) {
        val id = recId ?: return
        val sec = recorded
        bg.post {
            runCatching {
                Api.rpc("device_record_update", JSONObject().put("p_id", id).put("p_status", status).put("p_recorded", sec)
                    .put("p_paused", pausedSec).put("p_pause_count", pauseCount).put("p_event", event?.let { JSONObject().put("type", it) } ?: JSONObject.NULL))
            }.onFailure { Log.w(TAG, "durum", it) }
        }
    }

    /** Kayıt sürerken telefonda sadece görevin izinli uygulamaları açık; süre sayılmaz */
    private fun lockToTask() {
        if (allowed.isEmpty()) return
        app.orbit.data.TaskSession.start(runId, title, allowed, screen = true)
    }

    private fun togglePause() {
        if (recId == null || stopping) return
        paused = !paused
        if (paused) {
            pauseCount++
            push("paused", "pause")
            closeSegment()
            bg.post { Recorder.pump() }
            app.orbit.data.TaskSession.stop(runId)
            toast("Duraklatıldı: diğer uygulamalar açık ve süreden düşer")
        } else {
            push("recording", "resume")
            startSeg()
            lockToTask()
            allowed.firstOrNull()?.let { pkg -> packageManager.getLaunchIntentForPackage(pkg)?.let { runCatching { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } } }
            toast("Kayıt devam ediyor")
        }
        updateBubble()
    }

    private fun finishRecording() {
        if (recorded < recMin) { toast("En az ${recMin / 60} dk kayıt gerekli (şu an ${recorded / 60} dk)"); return }
        stopping = true
        push("done", "done")
        closeSegment()
        bg.post {
            Recorder.pump()
            if (autoSubmit) runCatching { Sync.submitTask(runId) }
            Live.syncRequested = true
        }
        toast("Ekran kaydı göreve eklendi")
        stopAll()
    }

    private fun restartRecording() {
        stopping = true
        main.removeCallbacks(tick)
        bg.removeCallbacks(frameLoop)
        val old = recId
        push("cancelled", "cancel")
        closeSegment()
        bg.post {
            old?.let { File(filesDir, "rec/$it").deleteRecursively() }
            main.post {
                recId = null
                recorded = 0
                minReached = false
                stopping = false
                toast("Kayıt baştan başlıyor")
                startRecording()
            }
        }
    }

    private fun onProjectionStopped() {
        if (mode == "record" && !stopping) {
            // Kullanıcı sistemden durdurdu: süre yetiyorsa bitir, yetmiyorsa kaydı açık bırak (sonra devam eder)
            if (recorded >= recMin) { finishRecording(); return }
            stopping = true
            push("recording", null)
            closeSegment()
            bg.post { Recorder.pump() }
            toast("Kayıt durdu; görevden tekrar başlatınca kaldığı yerden devam eder")
            runCatching { app.orbit.data.Notifier.screenStopped(this, title) }
        }
        stopAll()
    }

    // ---------------------------------------------------------------- yüzen düğme

    private fun showBubble() {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        val circle = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            background = round(Color.parseColor(if (mode == "record") "#E6FF5D6C" else "#E67C5CFF"), dp(36).toFloat())
            elevation = dp(6).toFloat()
        }
        bubbleText = TextView(this).apply { setTextColor(Color.WHITE); textSize = 15f; gravity = Gravity.CENTER; setTypeface(typeface, android.graphics.Typeface.BOLD) }
        bubbleSub = TextView(this).apply { setTextColor(Color.WHITE); textSize = 10f; gravity = Gravity.CENTER; alpha = 0.9f }
        circle.addView(bubbleText)
        circle.addView(bubbleSub)
        col.addView(circle, LinearLayout.LayoutParams(dp(72), dp(72)))
        bubble = col
        val p = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - dp(96)
            y = resources.displayMetrics.heightPixels / 3
        }
        bubbleParams = p
        dragAndTap(col, p) { onBubbleTap() }
        runCatching { wm.addView(col, p) }.onFailure { toast("Düğme gösterilemedi: üzerinde gösterme izni yok"); stopAll() }
        updateBubble()
    }

    private fun onBubbleTap() {
        if (small) { setSmall(false); return }
        if (mode == "shot") takeShot() else togglePanel()
    }

    private fun updateBubble() {
        if (!overlay) { updateNote(); return }
        val t = bubbleText ?: return
        if (small) { t.text = if (mode == "record") "●" else "📱"; bubbleSub?.text = ""; return }
        if (mode == "shot") {
            t.text = "📷 $shotCount"
            bubbleSub?.text = if (shotMax > shotMin) "$shotMin–$shotMax" else "/ $shotMin"
        } else {
            t.text = if (paused) "⏸" else "%d:%02d".format(recorded / 60, recorded % 60)
            bubbleSub?.text = if (paused) "duraklatıldı" else if (minReached) "✓ bitirebilirsin" else "en az ${recMin / 60} dk"
        }
        (t.parent as? View)?.background = round(
            Color.parseColor(
                when {
                    mode == "shot" && shotCount >= shotMin -> "#E62BB673"
                    mode == "shot" -> "#E67C5CFF"
                    minReached -> "#E62BB673"
                    else -> "#E6FF5D6C"
                }
            ),
            dp(36).toFloat(),
        )
        // Ekran görüntüsünde en aza ulaşınca "Bitti" seçeneği
        if (mode == "shot") {
            val col = bubble ?: return
            if (shotCount >= shotMin && col.childCount == 1) {
                col.addView(btn("Bitti", "#2B3157") { finishShots() }, LinearLayout.LayoutParams(dp(72), dp(34)).apply { topMargin = dp(6) })
            }
        }
    }

    /** Bildirimdeki kontroller (yüzen düğme gösterilemeyen telefonlar için) */
    private fun updateNote(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastNote < 3000) return
        lastNote = now
        fun pi(action: String, code: Int) = android.app.PendingIntent.getService(this, code, Intent(this, ScreenCaptureService::class.java).setAction(action), android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
        val b = Notification.Builder(this, CH).setSmallIcon(R.drawable.ic_orbit).setOngoing(true).setOnlyAlertOnce(true)
        if (mode == "shot") {
            b.setContentTitle("📱 Ekran görüntüsü: $title")
                .setContentText("$shotCount / $shotMin · çekmek için \"Görüntü al\"a bas")
                .addAction(Notification.Action.Builder(null, "📷 Görüntü al", pi(ACT_SHOT, 51)).build())
            if (shotCount >= shotMin) b.addAction(Notification.Action.Builder(null, "✓ Bitti", pi(ACT_DONE, 52)).build())
        } else {
            val time = "%d:%02d".format(recorded / 60, recorded % 60)
            b.setContentTitle("🎬 Ekran kaydı: $title")
                .setContentText(if (paused) "⏸ Duraklatıldı · $time" else "● $time · " + if (minReached) "bitirebilirsin" else "en az ${recMin / 60} dk")
                .addAction(Notification.Action.Builder(null, if (paused) "▶ Devam" else "⏸ Duraklat", pi(ACT_PAUSE, 53)).build())
            if (minReached) b.addAction(Notification.Action.Builder(null, "✓ Bitir", pi(ACT_DONE, 54)).build())
            b.addAction(Notification.Action.Builder(null, "↺ Baştan", pi(ACT_RESTART, 55)).build())
        }
        runCatching { getSystemService(NotificationManager::class.java).notify(5, b.build()) }
    }

    private fun togglePanel() {
        panel?.let { runCatching { wm.removeView(it) }; panel = null; return }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = round(Color.parseColor("#F0171B33"), dp(16).toFloat())
        }
        box.addView(TextView(this).apply {
            text = "🎬 $title\n${"%d:%02d".format(recorded / 60, recorded % 60)} · en az ${recMin / 60} · en fazla ${recMax / 60} dk"
            setTextColor(Color.WHITE); textSize = 14f
        })
        box.addView(btn("Bitir ve kaydet", "#7C5CFF") { togglePanel(); finishRecording() }, LinearLayout.LayoutParams(dp(220), dp(46)).apply { topMargin = dp(10) })
        box.addView(btn(if (paused) "▶ Devam et" else "⏸ Duraklat", "#2B3157") { togglePanel(); togglePause() }, LinearLayout.LayoutParams(dp(220), dp(46)).apply { topMargin = dp(8) })
        box.addView(btn("Baştan başla", "#2B3157") { togglePanel(); restartRecording() }, LinearLayout.LayoutParams(dp(220), dp(46)).apply { topMargin = dp(8) })
        box.addView(btn("Küçült", "#2B3157") { togglePanel(); setSmall(true) }, LinearLayout.LayoutParams(dp(220), dp(46)).apply { topMargin = dp(8) })
        box.addView(btn("Kapat", "#00000000") { togglePanel() }, LinearLayout.LayoutParams(dp(220), dp(40)).apply { topMargin = dp(4) })
        val bp = bubbleParams
        val p = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.TOP or Gravity.START
            x = ((bp?.x ?: 0) - dp(160)).coerceAtLeast(dp(8))
            y = (bp?.y ?: 0) + dp(80)
        }
        panel = box
        runCatching { wm.addView(box, p) }
    }

    private fun setSmall(on: Boolean) {
        small = on
        val col = bubble ?: return
        val p = bubbleParams ?: return
        val circle = col.getChildAt(0)
        circle.layoutParams = LinearLayout.LayoutParams(if (on) dp(26) else dp(72), if (on) dp(26) else dp(72))
        if (on) p.x = resources.displayMetrics.widthPixels - dp(30)
        runCatching { wm.updateViewLayout(col, p) }
        updateBubble()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun dragAndTap(v: View, p: WindowManager.LayoutParams, onTap: () -> Unit) {
        var sx = 0f; var sy = 0f; var px = 0; var py = 0; var moved = false
        v.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { sx = e.rawX; sy = e.rawY; px = p.x; py = p.y; moved = false; true }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - sx; val dy = e.rawY - sy
                    if (abs(dx) > dp(6) || abs(dy) > dp(6)) moved = true
                    if (moved) { p.x = px + dx.toInt(); p.y = py + dy.toInt(); runCatching { wm.updateViewLayout(v, p) } }
                    true
                }
                MotionEvent.ACTION_UP -> { if (!moved) onTap(); true }
                else -> false
            }
        }
    }

    // ---------------------------------------------------------------- yardımcılar

    private fun overlayParams(w: Int, h: Int) = WindowManager.LayoutParams(
        w, h,
        if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )

    private fun btn(label: String, color: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        textSize = 14f
        background = round(Color.parseColor(color), dp(23).toFloat())
        setOnClickListener { onClick() }
    }

    private fun round(color: Int, r: Float) = GradientDrawable().apply { setColor(color); cornerRadius = r }
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun toast(m: String) = main.post { Toast.makeText(this, m, Toast.LENGTH_SHORT).show() }

    private fun vibrate() {
        runCatching {
            val v = getSystemService(Vibrator::class.java)
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 180, 120, 180), -1)) else @Suppress("DEPRECATION") v.vibrate(300)
        }
    }

    private fun stopAll() {
        closeSegment()
        stopping = true
        if (mode == "record") app.orbit.data.TaskSession.stop(runId)
        main.removeCallbacks(tick)
        bg.removeCallbacks(frameLoop)
        closePreview()
        panel?.let { runCatching { wm.removeView(it) } }
        panel = null
        bubble?.let { runCatching { wm.removeView(it) } }
        bubble = null
        runCatching { display?.release() }
        display = null
        runCatching { projection?.stop() }
        projection = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        bg.post { runCatching { reader?.close() } }
        worker.quitSafely()
        super.onDestroy()
    }
}

/** Ekran kareleri (ARGB) → H.264 MP4 parçası, sabit 40 kare/sn zaman damgası (2 kare/sn çekim = 20x). */
class ScreenEncoder(val file: File, private val w: Int, private val h: Int) {
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
        f.setInteger(MediaFormat.KEY_BIT_RATE, 700_000)
        f.setInteger(MediaFormat.KEY_FRAME_RATE, Recorder.VIDEO_FPS)
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
        codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }

    private fun pts(n: Int) = n * 1_000_000L / Recorder.VIDEO_FPS

    fun encode(px: IntArray) {
        val idx = codec.dequeueInputBuffer(20_000)
        if (idx < 0) { drain(false); return }
        val img = codec.getInputImage(idx)
        if (img != null) {
            val yp = img.planes[0]; val up = img.planes[1]; val vp = img.planes[2]
            val yb = yp.buffer; val ub = up.buffer; val vb = vp.buffer
            for (y in 0 until h) {
                for (x in 0 until w) {
                    val c = px[y * w + x]
                    val r = (c shr 16) and 0xff; val g = (c shr 8) and 0xff; val b = c and 0xff
                    val yy = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
                    val yi = y * yp.rowStride + x * yp.pixelStride
                    if (yi < yb.limit()) yb.put(yi, yy.coerceIn(0, 255).toByte())
                    if (y % 2 == 0 && x % 2 == 0) {
                        val uu = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
                        val vv = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
                        val ui = (y / 2) * up.rowStride + (x / 2) * up.pixelStride
                        val vi = (y / 2) * vp.rowStride + (x / 2) * vp.pixelStride
                        if (ui < ub.limit()) ub.put(ui, uu.coerceIn(0, 255).toByte())
                        if (vi < vb.limit()) vb.put(vi, vv.coerceIn(0, 255).toByte())
                    }
                }
            }
        }
        codec.queueInputBuffer(idx, 0, w * h * 3 / 2, pts(frames), 0)
        frames++
        drain(false)
    }

    private fun drain(eos: Boolean) {
        var tries = 0
        while (true) {
            val i = codec.dequeueOutputBuffer(info, if (eos) 10_000 else 0)
            when {
                i == MediaCodec.INFO_TRY_AGAIN_LATER -> { if (!eos || ++tries > 200) return }
                i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> { track = muxer.addTrack(codec.outputFormat); muxer.start(); started = true }
                i >= 0 -> {
                    val buf = codec.getOutputBuffer(i)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                    if (info.size > 0 && started && buf != null) {
                        buf.position(info.offset); buf.limit(info.offset + info.size)
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
