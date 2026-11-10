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
data class Playlist(val id: String, val name: String, val sort: Int)
data class MissingTrack(val key: String, val label: String)

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
    fun syncCatalog(list: List<Track>): List<Track> {
        val child = Store.creds?.childId ?: return list
        if (Store.rules().musicFolder.isNullOrBlank()) return list
        runCatching {
            val existing = Api.get("music_meta?child_id=eq.$child&select=track_key,sort,missing")
            val seen = list.map { it.id.toString() }.toSet()
            val remoteSort = (0 until existing.length()).associate { i ->
                val row = existing.getJSONObject(i)
                row.optString("track_key") to if (row.isNull("sort")) null else row.optInt("sort")
            }
            val ordered = list.sortedWith(compareBy<Track>({ remoteSort[it.id.toString()] ?: Int.MAX_VALUE }, { it.title.lowercase() }, { it.fileName.lowercase() }))
            for (track in list) {
                val key = track.id.toString()
                val body = JSONObject().put("child_id", child).put("track_key", key)
                    .put("title", track.title).put("file_name", track.fileName)
                    .put("relative_path", track.folder).put("duration_ms", track.durationMs)
                    .put("sort", ordered.indexOfFirst { it.id == track.id }).put("missing", false)
                    .put("last_seen_at", java.time.Instant.now().toString())
                Api.post("music_meta?on_conflict=child_id,track_key", body, upsert = true)
            }
            for (i in 0 until existing.length()) {
                val row = existing.getJSONObject(i)
                val key = row.optString("track_key")
                if (key !in seen && !row.optBoolean("missing")) {
                    Api.patch("music_meta?child_id=eq.$child&track_key=eq.$key", JSONObject().put("missing", true))
                }
            }
            tracks.value = ordered
            return ordered
        }.onFailure { Log.w(TAG, "Müzik kataloğu eşitlenemedi", it) }
        return list
    }

    fun playlists(): List<Playlist> {
        val child = Store.creds?.childId ?: return emptyList()
        return runCatching {
            val rows = Api.get("music_playlists?child_id=eq.$child&select=id,name,sort&order=sort.asc")
            (0 until rows.length()).map { i ->
                val o = rows.getJSONObject(i)
                Playlist(o.getString("id"), o.optString("name"), o.optInt("sort"))
            }
        }.onFailure { Log.w(TAG, "çalma listeleri okunamadı", it) }.getOrDefault(emptyList())
    }

    fun playlistTracks(playlistId: String, tracks: List<Track>): List<Track> {
        return runCatching {
            val rows = Api.get("music_playlist_items?playlist_id=eq.$playlistId&select=track_key,sort&order=sort.asc")
            val byKey = tracks.associateBy { it.id.toString() }
            (0 until rows.length()).mapNotNull { i -> byKey[rows.getJSONObject(i).optString("track_key")] }
        }.onFailure { Log.w(TAG, "çalma listesi okunamadı", it) }.getOrDefault(emptyList())
    }

    fun missingTracks(): List<MissingTrack> {
        val child = Store.creds?.childId ?: return emptyList()
        return runCatching {
            val rows = Api.get("music_meta?child_id=eq.$child&missing=is.true&select=track_key,file_name,title&order=sort.asc")
            (0 until rows.length()).map { i ->
                val o = rows.getJSONObject(i)
                MissingTrack(o.optString("track_key"), o.optString("file_name").ifBlank { o.optString("title") })
            }
        }.onFailure { Log.w(TAG, "eksik şarkılar okunamadı", it) }.getOrDefault(emptyList())
    }

    fun createPlaylist(name: String): Boolean {
        val c = Store.creds ?: return false
        val clean = name.trim().take(100)
        if (clean.isBlank()) return false
        return runCatching {
            val sort = playlists().size
            Api.post("music_playlists", JSONObject().put("child_id", c.childId).put("family_id", c.familyId).put("name", clean).put("sort", sort))
            true
        }.onFailure { Log.w(TAG, "çalma listesi oluşturulamadı", it) }.getOrDefault(false)
    }

    fun renamePlaylist(playlistId: String, name: String): Boolean {
        val clean = name.trim().take(100)
        if (clean.isBlank()) return false
        return runCatching { Api.patch("music_playlists?id=eq.$playlistId", JSONObject().put("name", clean)); true }
            .onFailure { Log.w(TAG, "çalma listesi yeniden adlandırılamadı", it) }.getOrDefault(false)
    }

    fun deletePlaylist(playlistId: String): Boolean = runCatching {
        Api.delete("music_playlists?id=eq.$playlistId")
        true
    }.onFailure { Log.w(TAG, "çalma listesi silinemedi", it) }.getOrDefault(false)

    fun savePlaylistTracks(playlistId: String, items: List<Track>): Boolean = runCatching {
        items.forEach { ensureMeta(it) }
        Api.delete("music_playlist_items?playlist_id=eq.$playlistId")
        items.forEachIndexed { i, track ->
            Api.post("music_playlist_items", JSONObject().put("playlist_id", playlistId).put("track_key", track.id.toString()).put("title", track.title).put("sort", i))
        }
        true
    }.onFailure { Log.w(TAG, "çalma listesi kaydedilemedi", it) }.getOrDefault(false)

    /** Şarkının bulunduğu çalma listeleri */
    fun playlistsWith(trackKey: String): Set<String> = runCatching {
        val rows = Api.get("music_playlist_items?track_key=eq.$trackKey&select=playlist_id")
        (0 until rows.length()).map { rows.getJSONObject(it).optString("playlist_id") }.toSet()
    }.getOrDefault(emptySet())

    /** Şarkıyı listenin sonuna ekle (zaten varsa dokunma) */
    /** Şarkı kataloğa kayıtlı değilse kaydet (listeye eklemek için gerekli) */
    private fun ensureMeta(track: Track) {
        val child = Store.creds?.childId ?: return
        runCatching {
            Api.post("music_meta?on_conflict=child_id,track_key", JSONObject().put("child_id", child).put("track_key", track.id.toString())
                .put("title", track.title).put("file_name", track.fileName).put("relative_path", track.folder)
                .put("duration_ms", track.durationMs).put("missing", false), upsert = true)
        }.onFailure { Log.w(TAG, "katalog kaydı", it) }
    }

    fun addToPlaylist(playlistId: String, track: Track): Boolean = runCatching {
        val key = track.id.toString()
        ensureMeta(track)
        val rows = Api.get("music_playlist_items?playlist_id=eq.$playlistId&select=track_key,sort")
        if ((0 until rows.length()).any { rows.getJSONObject(it).optString("track_key") == key }) return true
        val next = (0 until rows.length()).maxOfOrNull { rows.getJSONObject(it).optInt("sort") }?.plus(1) ?: 0
        Api.post("music_playlist_items", JSONObject().put("playlist_id", playlistId).put("track_key", key).put("title", track.title).put("sort", next))
        true
    }.onFailure { Log.w(TAG, "listeye eklenemedi", it) }.getOrDefault(false)

    fun removeFromPlaylist(playlistId: String, trackKey: String): Boolean = runCatching {
        Api.delete("music_playlist_items?playlist_id=eq.$playlistId&track_key=eq.$trackKey")
        true
    }.onFailure { Log.w(TAG, "listeden çıkarılamadı", it) }.getOrDefault(false)

    /** Yeni liste oluştur ve id'sini döndür */
    fun createPlaylistId(name: String): String? {
        val clean = name.trim().take(100)
        if (!createPlaylist(clean)) return null
        return playlists().lastOrNull { it.name == clean }?.id
    }

    fun removeMissingTrack(trackKey: String): Boolean = runCatching {
        val child = Store.creds?.childId ?: return false
        Api.delete("music_playlist_items?track_key=eq.$trackKey")
        Api.delete("music_meta?child_id=eq.$child&track_key=eq.$trackKey")
        true
    }.onFailure { Log.w(TAG, "eksik şarkı silinemedi", it) }.getOrDefault(false)

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
    /** Müzik ne zamandan beri kapalı (bildirimi hemen silmeden önce kısa bekleme; anlık kural titremelerinde liste gitmesin) */
    private var blockedSince = 0L

    fun enforce() {
        if (blocked.value == null) { blockedSince = 0L; return }
        if (blockedSince == 0L) blockedSince = System.currentTimeMillis()
        val p = player ?: return
        // Durdur ve listeyi boşalt: bildirim / kilit ekranı oynatıcısı da kaybolur, oradan yeniden çalınamaz
        Handler(Looper.getMainLooper()).post {
            runCatching {
                if (p.isPlaying) p.pause()
                if (p.mediaItemCount > 0 && System.currentTimeMillis() - blockedSince.coerceAtLeast(1) > 5_000) {
                    p.stop()
                    p.clearMediaItems()
                }
            }
        }
    }
}
