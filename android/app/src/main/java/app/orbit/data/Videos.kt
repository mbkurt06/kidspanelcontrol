package app.orbit.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Videolarım: panelden OneDrive'a yüklenen videolar. Telefon görebildiği listelerin videolarını bir kez indirir
 * (filesDir/videos/<id>.mp4), sonra internetsiz oynatır. Her liste bir "uygulama": paket "video:<listeId>".
 */
object Videos {
    private const val TAG = "OrbitVideos"
    const val PREFIX = "video:"

    data class Video(
        val id: String, val listId: String, val title: String, val size: Long, val duration: Int,
        val thumb: String?, val sort: Int, val createdAt: String,
    )
    data class VList(val id: String, val name: String, val emoji: String, val sort: Int, val videos: List<Video>) {
        val pkg get() = PREFIX + id
    }
    data class Settings(
        val canDelete: Boolean = true, val canRedownload: Boolean = false, val autoDeleteDays: Int? = null,
        val maxGb: Double = 4.0, val wifiOnly: Boolean = true,
    )
    data class Progress(val position: Int = 0, val duration: Int = 0, val watched: Boolean = false, val removed: Boolean = false, val updatedAt: String = "")
    data class State(
        val lists: List<VList> = emptyList(),
        val settings: Settings = Settings(),
        val progress: Map<String, Progress> = emptyMap(),
        /** İnen video → yüzde (0..100) */
        val downloading: Map<String, Int> = emptyMap(),
        /** Telefonda hazır videolar */
        val local: Set<String> = emptySet(),
        val note: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    @Volatile private var ctx: Context? = null
    private val busy = AtomicBoolean(false)

    fun init(c: Context) {
        ctx = c.applicationContext
        if (_state.value.lists.isEmpty()) runCatching {
            Store.prefs().getString("videos.cache", null)?.let { decode(JSONObject(it)) }?.let { _state.value = it.copy(local = scanLocal()) }
        }
    }

    private fun dir(): File = File(ctx!!.filesDir, "videos").apply { mkdirs() }
    fun file(id: String): File = File(dir(), "$id.mp4")
    private fun scanLocal(): Set<String> = (dir().listFiles() ?: emptyArray()).filter { it.name.endsWith(".mp4") }.map { it.name.removeSuffix(".mp4") }.toSet()

    fun list(id: String): VList? = _state.value.lists.firstOrNull { it.id == id }
    fun byPkg(pkg: String): VList? = if (pkg.startsWith(PREFIX)) list(pkg.removePrefix(PREFIX)) else null

    // --- Sunucudan (Sync içinden, ağ iş parçacığında) ---

    fun store(lists: JSONArray, videos: JSONArray, settings: JSONArray, progress: JSONArray) {
        val b = JSONObject().put("lists", lists).put("videos", videos).put("settings", settings.optJSONObject(0) ?: JSONObject()).put("progress", progress)
        val s = decode(b)
        _state.value = s.copy(local = scanLocal(), downloading = _state.value.downloading)
        runCatching { Store.prefs().edit().putString("videos.cache", b.toString()).apply() }
    }

    private fun decode(b: JSONObject): State {
        val va = b.optJSONArray("videos") ?: JSONArray()
        val vids = (0 until va.length()).mapNotNull { i ->
            val o = va.getJSONObject(i)
            if (o.optString("status") != "ready") return@mapNotNull null
            runCatching {
                Video(o.getString("id"), o.getString("list_id"), o.optString("title"), o.optLong("size_bytes"), o.optInt("duration_sec"),
                    o.optString("thumb").takeIf { !o.isNull("thumb") && it.isNotBlank() }, o.optInt("sort"), o.optString("created_at"))
            }.getOrNull()
        }.groupBy { it.listId }
        val la = b.optJSONArray("lists") ?: JSONArray()
        val lists = (0 until la.length()).mapNotNull { i ->
            val o = la.getJSONObject(i)
            runCatching {
                val id = o.getString("id")
                VList(id, o.optString("name"), o.optString("emoji", "🎬"), o.optInt("sort"),
                    (vids[id] ?: emptyList()).sortedWith(compareBy({ it.sort }, { it.createdAt })))
            }.getOrNull()
        }.sortedWith(compareBy({ it.sort }, { it.name.lowercase() }))
        val so = b.optJSONObject("settings") ?: JSONObject()
        val st = Settings(
            so.optBoolean("can_delete", true), so.optBoolean("can_redownload", false),
            if (so.has("auto_delete_days") && !so.isNull("auto_delete_days")) so.optInt("auto_delete_days") else null,
            so.optDouble("max_gb", 4.0).takeIf { !it.isNaN() } ?: 4.0, so.optBoolean("wifi_only", true),
        )
        val pa = b.optJSONArray("progress") ?: JSONArray()
        val prog = (0 until pa.length()).associate { i ->
            val o = pa.getJSONObject(i)
            o.optString("video_id") to Progress(o.optInt("position_sec"), o.optInt("duration_sec"), o.optBoolean("watched"), o.optBoolean("removed"), o.optString("updated_at"))
        }
        return State(lists, st, prog)
    }

    /** Bu çocuğun görebildiği listeler: child_apps satırı var ve "Hep kapalı" değil */
    fun visibleLists(): List<VList> {
        val apps = Store.rules().apps
        return _state.value.lists.filter { l -> apps[l.pkg]?.let { it.approved && it.group != app.orbit.engine.Group.BLOCKED } == true }
    }

    // --- İlerleme ---

    fun saveProgress(v: Video, positionSec: Int, durationSec: Int, watched: Boolean) {
        val old = _state.value.progress[v.id]
        val p = Progress(positionSec, durationSec, watched || old?.watched == true, false, Instant.now().toString())
        _state.value = _state.value.copy(progress = _state.value.progress + (v.id to p))
        upsertProgress(v.id, p, downloaded = file(v.id).exists())
    }

    private fun upsertProgress(id: String, p: Progress, downloaded: Boolean) {
        val c = Store.creds ?: return
        Thread {
            runCatching {
                Api.post("video_progress", JSONObject().put("child_id", c.childId).put("video_id", id).put("family_id", c.familyId)
                    .put("position_sec", p.position).put("duration_sec", p.duration).put("watched", p.watched).put("removed", p.removed)
                    .put("downloaded", downloaded).put("updated_at", p.updatedAt.ifBlank { Instant.now().toString() }), upsert = true)
            }.onFailure { Log.w(TAG, "ilerleme yazılamadı", it) }
        }.start()
    }

    /** Çocuk sildi (izin varsa) */
    fun removeLocal(v: Video) {
        file(v.id).delete()
        val old = _state.value.progress[v.id] ?: Progress()
        val p = old.copy(removed = true, updatedAt = Instant.now().toString())
        _state.value = _state.value.copy(progress = _state.value.progress + (v.id to p), local = _state.value.local - v.id)
        upsertProgress(v.id, p, downloaded = false)
    }

    /** Silineni tekrar indir (izin varsa) */
    fun redownload(v: Video) {
        val old = _state.value.progress[v.id] ?: Progress()
        val p = old.copy(removed = false, updatedAt = Instant.now().toString())
        _state.value = _state.value.copy(progress = _state.value.progress + (v.id to p))
        upsertProgress(v.id, p, downloaded = false)
        Thread { sync() }.start()
    }

    // --- İndirme / temizlik (ağ iş parçacığında) ---

    private fun onWifi(): Boolean {
        val cm = ctx?.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
            !cm.isActiveNetworkMetered
    }

    /** Görünen listelerin eksik videolarını indir; panelden kalkanları ve süresi dolanları sil */
    fun sync() {
        if (ctx == null || !busy.compareAndSet(false, true)) return
        try {
            val s = _state.value
            val visible = visibleLists()
            val wanted = visible.flatMap { it.videos }.filter { s.progress[it.id]?.removed != true }
            val allIds = s.lists.flatMap { l -> l.videos.map { it.id } }.toSet()
            // Panelden kalkan ya da çocuğun artık görmediği liste → telefondan sil
            val keep = wanted.map { it.id }.toSet()
            for (id in scanLocal()) if (id !in allIds || id !in keep) file(id).delete()
            // İzlendikten X gün sonra otomatik sil
            s.settings.autoDeleteDays?.let { days ->
                val limit = Instant.now().minusSeconds(days * 86_400L)
                for (v in wanted) {
                    val p = s.progress[v.id] ?: continue
                    val at = runCatching { Instant.parse(p.updatedAt) }.getOrNull() ?: continue
                    if (p.watched && at.isBefore(limit) && file(v.id).exists()) { file(v.id).delete(); upsertProgress(v.id, p.copy(removed = true), false) }
                }
            }
            _state.value = _state.value.copy(local = scanLocal())
            if (s.settings.wifiOnly && !onWifi()) { _state.value = _state.value.copy(note = "Wi-Fi bekleniyor"); return }
            val maxBytes = (s.settings.maxGb * 1_073_741_824L).toLong()
            for (v in wanted.sortedWith(compareBy({ s.progress[it.id]?.watched == true }, { it.sort }))) {
                if (file(v.id).exists()) continue
                val used = (dir().listFiles() ?: emptyArray()).sumOf { it.length() }
                if (used + v.size > maxBytes) { _state.value = _state.value.copy(note = "Yer sınırı doldu (${"%.1f".format(s.settings.maxGb)} GB)"); break }
                if (dir().usableSpace < v.size + 300L * 1_048_576) { _state.value = _state.value.copy(note = "Telefonda yer yok"); break }
                if (s.settings.wifiOnly && !onWifi()) break
                download(v)
            }
            _state.value = _state.value.copy(note = null, local = scanLocal())
        } catch (t: Throwable) {
            Log.w(TAG, "video eşitleme", t)
        } finally {
            busy.set(false)
        }
    }

    private fun download(v: Video) {
        val (code, txt) = Api.function("orbit-onedrive", JSONObject().put("action", "video_url").put("video_id", v.id))
        if (code !in 200..299) { Log.w(TAG, "adres alınamadı $code ${txt.take(120)}"); return }
        val url = JSONObject(txt).optString("url").takeIf { it.startsWith("https://") } ?: return
        val part = File(dir(), "${v.id}.part")
        val from = if (part.exists()) part.length() else 0L
        val req = Request.Builder().url(url).apply { if (from > 0) header("Range", "bytes=$from-") }.build()
        Api.bigClient.newCall(req).execute().use { r ->
            if (!r.isSuccessful) { Log.w(TAG, "indirme HTTP ${r.code}"); return }
            val append = r.code == 206
            val total = if (append) from + (r.body?.contentLength() ?: 0) else (r.body?.contentLength() ?: v.size)
            var done = if (append) from else 0L
            var last = -1
            r.body!!.byteStream().use { inp ->
                java.io.FileOutputStream(part, append).use { out ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val pct = if (total > 0) (done * 100 / total).toInt() else 0
                        if (pct != last) { last = pct; _state.value = _state.value.copy(downloading = _state.value.downloading + (v.id to pct)) }
                    }
                }
            }
            if (total > 0 && done < total) return
        }
        part.renameTo(file(v.id))
        _state.value = _state.value.copy(downloading = _state.value.downloading - v.id, local = scanLocal())
        upsertProgress(v.id, _state.value.progress[v.id] ?: Progress(updatedAt = Instant.now().toString()), downloaded = true)
    }
}
