package app.orbit.data

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * Kameralı görev kaydı: durum (telefonda saklanır, uygulama kapansa da kalır), parça yükleme kuyruğu ve sunucu bildirimleri.
 * Kamerayı ve kodlayıcıyı [app.orbit.service.RecordService] çalıştırır.
 */
data class RecState(
    val id: String,
    val runId: String,
    val title: String,
    val plannedSeconds: Int,
    val camera: String,
    /** none | limit | child */
    val pausePolicy: String,
    val pauseMaxSeconds: Int?,
    /** recording | paused | done | cancelled */
    val status: String,
    val recordedSeconds: Int = 0,
    val pausedSeconds: Int = 0,
    val pauseCount: Int = 0,
    /** Görev kanıt istemiyorsa kayıt bitince otomatik gönderilir */
    val autoSubmit: Boolean = false,
    /** Sunucuya bildirilmemiş son durum var mı */
    val dirty: Boolean = false,
    /** İstenen süre doldu, çocuğun seçimi bekleniyor (onaya gönder / devam / baştan) */
    val reached: Boolean = false,
    val reachedAt: Long = 0L,
    /** Süre dolduktan sonra fazladan kayda devam ediyor */
    val extra: Boolean = false,
) {
    /** Fazladan kayıt üst sınırı: istenen süre + 60 dk */
    val hardMaxSeconds get() = plannedSeconds + 3600
    val active get() = status == "recording" || status == "paused"
    val canPause get() = pausePolicy != "none" && (pausePolicy != "limit" || pauseLeftSeconds > 0)
    val pauseLeftSeconds get() = if (pausePolicy == "limit") ((pauseMaxSeconds ?: 0) - pausedSeconds).coerceAtLeast(0) else Int.MAX_VALUE

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("runId", runId).put("title", title).put("planned", plannedSeconds).put("camera", camera)
        .put("pausePolicy", pausePolicy).put("pauseMax", pauseMaxSeconds ?: JSONObject.NULL).put("status", status)
        .put("recorded", recordedSeconds).put("paused", pausedSeconds).put("pauseCount", pauseCount)
        .put("autoSubmit", autoSubmit).put("dirty", dirty).put("reached", reached).put("reachedAt", reachedAt).put("extra", extra)

    companion object {
        fun fromJson(o: JSONObject) = RecState(
            o.getString("id"), o.getString("runId"), o.optString("title"), o.optInt("planned"), o.optString("camera", "back"),
            o.optString("pausePolicy", "child"), if (o.isNull("pauseMax")) null else o.optInt("pauseMax"), o.optString("status"),
            o.optInt("recorded"), o.optInt("paused"), o.optInt("pauseCount"), o.optBoolean("autoSubmit"), o.optBoolean("dirty"),
            o.optBoolean("reached"), o.optLong("reachedAt"), o.optBoolean("extra"),
        )
    }
}

object Recorder {
    private const val TAG = "OrbitRec"
    /** Kare yakalama sıklığı ve oynatma hızı: 2 kare/sn çekilir, 40 kare/sn oynatılır → 1x = 20 kat hız */
    const val CAPTURE_INTERVAL_MS = 500L
    const val VIDEO_FPS = 40
    /** Bir parça en fazla 10 dakikalık kayıt (1200 kare) */
    const val SEGMENT_FRAMES = 1200

    private val _state = MutableStateFlow<RecState?>(null)
    val state: StateFlow<RecState?> = _state
    /** Ekranda gösterilecek son kare */
    val preview = MutableStateFlow<Bitmap?>(null)
    /** Canlı önizleme yüzeyi (kayıt ekranı açıkken); varsa saniyede bir kare yerine akıcı görüntü */
    val previewSurface = MutableStateFlow<androidx.camera.core.Preview.SurfaceProvider?>(null)
    /** Kamera canlı önizlemeyi destekliyor mu (desteklemiyorsa ekran saniyede bir kareye döner) */
    val livePreview = MutableStateFlow(false)
    /** Kamera hatası (çocuğa gösterilir) */
    val error = MutableStateFlow<String?>(null)
    /** Yüklenmeyi bekleyen parça sayısı */
    val pending = MutableStateFlow(0)

    private lateinit var appCtx: Context
    /** Kayıt servisinin son canlılık işareti (servis yeni başlarken yanlış "kesinti" algılanmasın) */
    @Volatile var lastAlive = 0L
    private val lock = Any()

    fun init(ctx: Context) {
        appCtx = ctx.applicationContext
        val raw = Store.prefs().getString("recState", null)
        _state.value = raw?.let { runCatching { RecState.fromJson(JSONObject(it)) }.getOrNull() }
        pending.value = pendingFiles().size
    }

    val active get() = _state.value?.active == true

    fun current(): RecState? = _state.value

    fun save(s: RecState?) {
        synchronized(lock) {
            _state.value = s
            Store.prefs().edit().putString("recState", s?.toJson()?.toString()).apply()
        }
    }

    fun update(f: (RecState) -> RecState): RecState? {
        synchronized(lock) {
            val s = _state.value ?: return null
            val n = f(s)
            save(n)
            return n
        }
    }

    // --- Sunucu (IO iş parçacığında) ---

    /** Kaydı başlat ya da yarım kalanı sürdür. Hata metni ya da null döner. */
    fun begin(t: TaskItem, camera: String): String? = runCatching {
        val r = JSONObject(Api.rpc("device_record_start", JSONObject().put("p_run", t.runId).put("p_camera", camera)))
        val s = RecState(
            id = r.getString("id"), runId = t.runId, title = t.title,
            plannedSeconds = r.optInt("planned_seconds", (t.recordMinutes ?: 60) * 60),
            camera = r.optString("camera", camera),
            pausePolicy = t.recordPause, pauseMaxSeconds = t.recordPauseMax?.let { it * 60 },
            status = "recording",
            recordedSeconds = r.optInt("recorded_seconds"), pausedSeconds = r.optInt("paused_seconds"), pauseCount = r.optInt("pause_count"),
            autoSubmit = t.proof == "none",
        )
        lastAlive = System.currentTimeMillis()
        save(s)
        if (r.optString("status") == "paused") push(s, JSONObject().put("type", "resume"))
        null
    }.getOrElse { e ->
        Log.w(TAG, "başlatılamadı", e)
        val m = e.message ?: ""
        when {
            "not_open" in m -> "Bu görev artık açık değil"
            "no_recording" in m -> "Bu görevde kayıt yok"
            else -> "İnternet gerekli"
        }
    }

    /** Durumu sunucuya bildir; olmazsa sonra tekrar dener. */
    fun push(s: RecState, event: JSONObject? = null): Boolean {
        val ok = runCatching {
            Api.rpc("device_record_update", JSONObject()
                .put("p_id", s.id).put("p_status", s.status).put("p_recorded", s.recordedSeconds)
                .put("p_paused", s.pausedSeconds).put("p_pause_count", s.pauseCount)
                .put("p_event", event ?: JSONObject.NULL))
        }.isSuccess
        if (!ok) {
            // Olay kaybolmasın: bekleyen olayları sakla
            event?.let { ev ->
                val arr = org.json.JSONArray(Store.prefs().getString("recEvents", "[]"))
                arr.put(ev.put("id", s.id))
                Store.prefs().edit().putString("recEvents", arr.toString()).apply()
            }
        }
        update { if (it.id == s.id) it.copy(dirty = !ok) else it }
        return ok
    }

    /** Ağ döngüsünden: bekleyen durum/olayları ve parçaları gönder. */
    fun pump() {
        val s = _state.value
        val evs = org.json.JSONArray(Store.prefs().getString("recEvents", "[]"))
        if (evs.length() > 0) {
            Store.prefs().edit().putString("recEvents", "[]").apply()
            for (i in 0 until evs.length()) {
                val ev = evs.getJSONObject(i)
                val id = ev.optString("id")
                ev.remove("id")
                val target = if (s != null && s.id == id) s else null
                if (target != null) push(target, ev)
            }
        }
        if (s != null && s.dirty) push(s)
        uploadPending()
        // Bitmiş kaydın hepsi yüklendiyse durumu temizle
        val now = _state.value
        if (now != null && !now.active && !now.dirty && pendingFiles().none { it.parentFile?.name == now.id }) save(null)
    }

    private fun recDir(): File = File(appCtx.filesDir, "rec").apply { mkdirs() }

    fun segmentFile(recId: String, seq: Long): File = File(File(recDir(), recId).apply { mkdirs() }, "$seq.mp4")

    /** Parça kapandı: yükleme bilgisi yanına yazılır. */
    fun segmentClosed(recId: String, runId: String, file: File, frames: Int, startMs: Long, endMs: Long) {
        if (frames <= 0 || !file.exists()) { file.delete(); return }
        File(file.path.removeSuffix(".mp4") + ".json").writeText(
            JSONObject().put("runId", runId).put("frames", frames).put("start", startMs).put("end", endMs).toString()
        )
        pending.value = pendingFiles().size
    }

    /** Panele bildirilen yükleme durumu (Telefon ayarları → Sistem) */
    @Volatile var lastUploadError: String? = null
    @Volatile var lastUploadErrorAt = 0L
    @Volatile var lastSegmentError: String? = null

    fun uploadState(): JSONObject {
        val files = pendingFiles().map { File(it.path.removeSuffix(".json") + ".mp4") }.filter { it.exists() }
        return JSONObject()
            .put("pending", files.size)
            .put("pending_mb", files.sumOf { it.length() } / 1_048_576)
            .put("oldest", files.minOfOrNull { it.lastModified() }?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)
            .put("error", lastUploadError ?: JSONObject.NULL)
            .put("segment_error", lastSegmentError ?: JSONObject.NULL)
            .put("cloud", Cloud.available)
    }

    private fun pendingFiles(): List<File> =
        if (!::appCtx.isInitialized) emptyList()
        else recDir().listFiles()?.flatMap { d -> d.listFiles()?.filter { it.name.endsWith(".json") } ?: emptyList() }?.sortedBy { it.name } ?: emptyList()

    /** Aynı anda tek yükleme: birden çok yerden çağrılınca aynı parça iki kez gönderiliyordu */
    private val uploading = java.util.concurrent.atomic.AtomicBoolean(false)

    private fun uploadPending() {
        if (!uploading.compareAndSet(false, true)) return
        try { uploadPendingOnce() } finally { uploading.set(false) }
    }

    private fun uploadPendingOnce() {
        val c = Store.creds ?: return
        for (meta in pendingFiles()) {
            val recId = meta.parentFile?.name ?: continue
            val video = File(meta.path.removeSuffix(".json") + ".mp4")
            val seq = meta.name.removeSuffix(".json").toLongOrNull() ?: continue
            if (!video.exists()) { meta.delete(); continue }
            val m = runCatching { JSONObject(meta.readText()) }.getOrNull()
            if (m == null) { meta.delete(); continue }
            val runId = m.getString("runId")
            // Büyük video parçaları sadece Wi-Fi'de; önce OneDrive (yarıda kalırsa kaldığı yerden), yoksa Orbit deposu
            if (video.length() > 8_000_000 && !Cloud.unmetered(appCtx)) { lastUploadError = "Wi-Fi bekleniyor"; continue }
            var path = "${c.familyId}/$runId/rec-${recId.take(8)}-$seq.mp4"
            val ok = runCatching {
                var url = m.optString("odUrl").takeIf { it.isNotBlank() }
                if (url == null && Cloud.available) {
                    url = Cloud.session("kayit-${java.time.Instant.ofEpochMilli(m.optLong("start")).atZone(java.time.ZoneId.of("Europe/Berlin")).toLocalTime().toString().take(8).replace(':', '-')}-${recId.take(6)}-$seq.mp4")
                    if (url != null) { m.put("odUrl", url); meta.writeText(m.toString()) }
                }
                if (url != null) {
                    val id = runCatching { Cloud.uploadFile(video, url, "video/mp4") }.getOrElse { e ->
                        // Oturumun süresi dolduysa yenisini açmak için sil
                        if (e is Api.ApiError && (e.code == 404 || e.code == 410)) { m.remove("odUrl"); meta.writeText(m.toString()) }
                        throw e
                    }
                    path = "${c.familyId}/$runId/od:$id"
                } else Api.uploadFile("orbit-proofs", path, video, "video/mp4")
                Api.rpc("device_record_segment", JSONObject()
                    .put("p_id", recId).put("p_seq", seq).put("p_path", path).put("p_frames", m.optInt("frames"))
                    .put("p_start", Instant.ofEpochMilli(m.optLong("start")).toString())
                    .put("p_end", Instant.ofEpochMilli(m.optLong("end")).toString()))
            }.onFailure {
                Log.w(TAG, "parça yüklenemedi", it)
                lastUploadError = "Yüklenemedi: ${(it.message ?: it.javaClass.simpleName).take(140)}"
                lastUploadErrorAt = System.currentTimeMillis()
            }.isSuccess
            if (!ok) break
            lastUploadError = null
            video.delete()
            meta.delete()
            File(recDir(), recId).takeIf { it.listFiles()?.isEmpty() == true }?.delete()
            pending.value = pendingFiles().size
        }
    }

    /** Kayıt bitti: görev başka kanıt istemiyorsa gönder. */
    fun submitIfAuto(s: RecState) {
        if (!s.autoSubmit || s.status != "done") return
        runCatching { Sync.submitTask(s.runId) }.onFailure { Log.w(TAG, "otomatik gönderilemedi", it) }
    }
}
