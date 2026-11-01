package app.orbit.data

import android.content.ComponentName
import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
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

data class Track(val id: Long, val title: String, val artist: String?, val durationMs: Long, val uri: String, val folder: String)

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
            MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.DATA,
        )
        if (Build.VERSION.SDK_INT >= 29) proj += MediaStore.Audio.Media.RELATIVE_PATH
        runCatching {
            ctx.contentResolver.query(uri, proj.toTypedArray(), "${MediaStore.Audio.Media.DURATION} >= 15000", null, "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE")?.use { c ->
                val iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val iT = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                val iA = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                val iD = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
                val iData = c.getColumnIndex(MediaStore.Audio.Media.DATA)
                val iRel = if (Build.VERSION.SDK_INT >= 29) c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH) else -1
                while (c.moveToNext()) {
                    val id = c.getLong(iId)
                    val folder = (if (iRel >= 0) c.getString(iRel) else null)?.trimEnd('/')
                        ?: c.getString(iData)?.substringBeforeLast('/')?.substringAfter("/0/")
                        ?: ""
                    val artist = c.getString(iA)?.takeIf { it.isNotBlank() && it != "<unknown>" }
                    out += Track(id, c.getString(iT) ?: "Şarkı", artist, c.getLong(iD), ContentUris.withAppendedId(uri, id).toString(), folder)
                }
            }
        }.onFailure { Log.w(TAG, "müzik listesi okunamadı", it) }
        tracks.value = out
        return out
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
