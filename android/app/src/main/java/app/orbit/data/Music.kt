package app.orbit.data

import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.content.ContentValues
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.orbit.service.MusicService
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject

data class Track(val id: Long, val title: String, val artist: String?, val durationMs: Long, val uri: String, val folder: String, val fileName: String = "")

/** Orbit müzik çalar: telefondaki müzik dosyaları, çalma listesi ve arka planda çalan servis. Süreden düşmez. */
object Music {
    private const val TAG = "OrbitMusic"

    /** Servisteki oynatıcı (aynı süreç); kurallar müziği kapatınca durdurmak için */
    @Volatile var player: Player? = null
    private var controller: MediaController? = null
    private var connecting = false
    private val waiting = mutableListOf<(MediaController) -> Unit>()

    /** Şu an müzik çalamıyorsa nedeni (OrbitService her saniye günceller) */
    val blocked = MutableStateFlow<String?>(null)
    val tracks = MutableStateFlow<List<Track>>(emptyList())

    fun scan(ctx: Context): List<Track> {
        val out = mutableListOf<Track>()
        val uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val proj = mutableListOf(
            MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.DATA, MediaStore.Audio.Media.DISPLAY_NAME,
        )
        if (Build.VERSION.SDK_INT >= 29) proj += MediaStore.Audio.Media.RELATIVE_PATH
        val selected = Store.rules().musicFolder?.trim('/')?.takeIf { it.isNotBlank() }
        if (selected == null) { tracks.value = emptyList(); return emptyList() }
        runCatching {
            ctx.contentResolver.query(uri, proj.toTypedArray(), "${MediaStore.Audio.Media.DURATION} >= 15000", null, "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE")?.use { c ->
                val iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val iT = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                val iA = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                val iD = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
                val iData = c.getColumnIndex(MediaStore.Audio.Media.DATA)
                val iFile = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                val iRel = if (Build.VERSION.SDK_INT >= 29) c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH) else -1
                while (c.moveToNext()) {
                    val id = c.getLong(iId)
                    val folder = (if (iRel >= 0) c.getString(iRel) else null)?.trimEnd('/')
                        ?: c.getString(iData)?.substringBeforeLast('/')?.substringAfter("/0/")
                        ?: ""
                    val relative = folder.trim('/')
                    if (relative != selected && !relative.startsWith("$selected/")) continue
                    val fileName = c.getString(iFile) ?: continue
                    val artist = c.getString(iA)?.takeIf { it.isNotBlank() && it != "<unknown>" }
                    out += Track(id, c.getString(iT) ?: "Şarkı", artist, c.getLong(iD), ContentUris.withAppendedId(uri, id).toString(), folder, fileName)
                }
            }
        }.onFailure { Log.w(TAG, "müzik listesi okunamadı", it) }
        tracks.value = out
        return out
    }

    /** Report candidate directories without exposing unrelated audio to the child UI. */
    fun availableFolders(ctx: Context): List<String> {
        val result = mutableSetOf<String>()
        val columns = if (Build.VERSION.SDK_INT >= 29)
            arrayOf(MediaStore.Audio.Media.RELATIVE_PATH, MediaStore.Audio.Media.DATA)
        else arrayOf(MediaStore.Audio.Media.DATA)
        runCatching {
            ctx.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, columns,
                "${MediaStore.Audio.Media.DURATION} >= 15000", null, null)?.use { c ->
                val rel = c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
                val data = c.getColumnIndex(MediaStore.Audio.Media.DATA)
                while (c.moveToNext()) {
                    val f = (if (rel >= 0) c.getString(rel) else null)?.trimEnd('/')
                        ?: (if (data >= 0) c.getString(data)?.substringBeforeLast('/')?.substringAfter("/0/") else null)
                        ?: ""
                    if (f.isNotBlank()) result += f
                }
            }
        }.onFailure { Log.w(TAG, "Klasör taraması başarısız", it) }
        return result.sorted()
    }

    fun reportFolders(ctx: Context) {
        val f = availableFolders(ctx)
        val key = f.joinToString("|")
        if (Store.prefs().getString("musicFoldersReported", null) == key) return
        runCatching {
            Api.rpc("device_report_music", JSONObject().put("p_folders", JSONArray(f)))
            Store.prefs().edit().putString("musicFoldersReported", key).apply()
        }.onFailure { Log.w(TAG, "Klasörler gönderilemedi", it) }
    }

    fun folders(list: List<Track>): List<String> = list.map { it.folder }.filter { it.isNotBlank() }.distinct().sorted()

    /** Klasör listesini panele bildir (değiştiyse). IO iş parçacığında. */
    fun reportFolders(list: List<Track>) {
        val f = folders(list)
        val key = f.joinToString("|")
        if (Store.prefs().getString("musicFoldersReported", null) == key) return
        runCatching {
            Api.rpc("device_report_music", JSONObject().put("p_folders", JSONArray(f)))
            Store.prefs().edit().putString("musicFoldersReported", key).apply()
        }.onFailure { Log.w(TAG, "klasörler gönderilemedi", it) }
    }

    /** Metadata sync only. Keep removed songs as missing so the child can remove them from playlists. */
    fun syncCatalog(list: List<Track>) {
        val child = Store.creds?.childId ?: return
        if (Store.rules().musicFolder.isNullOrBlank()) return
        runCatching {
            val existing = Api.get("music_meta?child_id=eq.$child&select=track_key,missing")
            val seen = list.map { it.id.toString() }.toSet()
            for (track in list) {
                val key = track.id.toString()
                val body = JSONObject().put("child_id", child).put("track_key", key)
                    .put("title", track.title).put("file_name", track.fileName)
                    .put("relative_path", track.folder).put("duration_ms", track.durationMs)
                    .put("missing", false).put("last_seen_at", java.time.Instant.now().toString())
                Api.post("music_meta?on_conflict=child_id,track_key", body, upsert = true)
            }
            for (i in 0 until existing.length()) {
                val row = existing.getJSONObject(i)
                val key = row.optString("track_key")
                if (key !in seen && !row.optBoolean("missing")) {
                    Api.patch("music_meta?child_id=eq.$child&track_key=eq.$key", JSONObject().put("missing", true))
                }
            }
        }.onFailure { Log.w(TAG, "Müzik kataloğu eşitlenemedi", it) }
    }

    /** Rename the actual file; ID3 tags are not changed. */
    fun rename(ctx: Context, track: Track, newName: String): Boolean {
        val base = newName.trim()
        if (base.isBlank() || base == "." || base == ".." || base.any { it.code < 32 || it == '/' || it == ':' || it == '*' || it == '?' || it == '"' || it == '<' || it == '>' || it == '|' || it.code == 92 }) return false
        val extension = track.fileName.substringAfterLast('.', "")
        val target = if (extension.isNotEmpty() && !base.endsWith(".$extension", true)) "$base.$extension" else base
        return runCatching {
            val values = ContentValues().apply { put(MediaStore.Audio.Media.DISPLAY_NAME, target) }
            ctx.contentResolver.update(android.net.Uri.parse(track.uri), values, null, null) > 0
        }.onFailure { Log.w(TAG, "Dosya yeniden adlandırılamadı", it) }.getOrDefault(false)
    }

    /** Çocuğun seçtiği klasör (ebeveyn sabitlemediyse); null = hepsi */
    var childFolder: String?
        get() = Store.prefs().getString("musicFolder", null)
        set(v) = Store.prefs().edit().putString("musicFolder", v).apply()

    fun connect(ctx: Context, cb: (MediaController) -> Unit) {
        controller?.let { if (it.isConnected) { cb(it); return } }
        waiting += cb
        if (connecting) return
        connecting = true
        val token = SessionToken(ctx, ComponentName(ctx, MusicService::class.java))
        val f = MediaController.Builder(ctx.applicationContext, token).buildAsync()
        f.addListener({
            connecting = false
            val c = runCatching { f.get() }.onFailure { Log.w(TAG, "bağlanamadı", it) }.getOrNull() ?: return@addListener
            controller = c
            val list = waiting.toList()
            waiting.clear()
            list.forEach { it(c) }
        }, ContextCompat.getMainExecutor(ctx))
    }

    fun controllerOrNull(): MediaController? = controller?.takeIf { it.isConnected }

    fun play(ctx: Context, list: List<Track>, start: Int) {
        if (blocked.value != null) return
        connect(ctx) { c ->
            c.setMediaItems(list.map { t ->
                MediaItem.Builder().setMediaId(t.id.toString()).setUri(t.uri)
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(t.title).setArtist(t.artist).build())
                    .build()
            }, start.coerceIn(0, (list.size - 1).coerceAtLeast(0)), 0)
            c.prepare()
            c.play()
        }
    }

    /** Kurallar müziği kapattıysa çalmayı durdur (her iş parçacığından çağrılabilir). */
    fun enforce() {
        if (blocked.value == null) return
        val p = player ?: return
        Handler(Looper.getMainLooper()).post { runCatching { if (p.isPlaying) p.pause() } }
    }
}
