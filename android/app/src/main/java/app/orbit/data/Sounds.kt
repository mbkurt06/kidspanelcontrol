package app.orbit.data

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Alarm ve "telefonu bul" sesleri.
 * Alarm akışında çalar (sessiz / titreşim modunda da duyulur); istenen seviyeye alarm sesini geçici olarak ayarlar,
 * bitince eski seviyeye döner. İstenirse sessizden başlayıp 30 sn'de tam sese çıkar.
 */
class SoundPlayer(private val ctx: Context) {
    private var player: MediaPlayer? = null
    private val am = ctx.getSystemService(AudioManager::class.java)
    private var oldVolume: Int? = null
    private val h = Handler(Looper.getMainLooper())
    private var rampStep = 0

    fun start(uri: String?, volumePct: Int?, ramp: Boolean) {
        stop()
        if (volumePct != null) setVolume(volumePct)
        val u = uri?.let { runCatching { Uri.parse(it) }.getOrNull() }
        val fallback = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        for (candidate in listOfNotNull(u, fallback)) {
            val ok = runCatching {
                player = MediaPlayer().apply {
                    setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    setDataSource(ctx, candidate)
                    isLooping = true
                    prepare()
                    if (ramp) setVolume(0.05f, 0.05f)
                    start()
                }
            }.onFailure { Log.w("OrbitSound", "çalınamadı: $candidate", it); runCatching { player?.release() }; player = null }.isSuccess
            if (ok) break
        }
        if (ramp) {
            rampStep = 0
            h.post(object : Runnable {
                override fun run() {
                    val p = player ?: return
                    rampStep++
                    val v = (0.05f + 0.95f * rampStep / 30f).coerceAtMost(1f)
                    runCatching { p.setVolume(v, v) }
                    if (v < 1f) h.postDelayed(this, 1000)
                }
            })
        }
    }

    /** Bir kez çal (hatırlatıcı); bitince ses seviyesi eski haline döner */
    fun playOnce(uri: String, volumePct: Int?) {
        stop()
        if (volumePct != null) setVolume(volumePct)
        runCatching {
            player = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(ctx, Uri.parse(uri))
                isLooping = false
                setOnCompletionListener { this@SoundPlayer.stop() }
                prepare()
                start()
            }
            // Uzun bir şarkı seçildiyse 20 sn'de kes
            h.postDelayed({ stop() }, 20_000)
        }.onFailure { Log.w("OrbitSound", "hatırlatıcı sesi çalınamadı", it); stop() }
    }

    /** Alarm ses seviyesi (%), çalarken de değiştirilebilir */
    fun setVolume(pct: Int) {
        runCatching {
            val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            if (oldVolume == null) oldVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
            val v = ((pct.coerceIn(0, 100) / 100f) * max).toInt().coerceIn(if (pct > 0) 1 else 0, max)
            am.setStreamVolume(AudioManager.STREAM_ALARM, v, 0)
        }
    }

    fun stop() {
        h.removeCallbacksAndMessages(null)
        runCatching { player?.stop(); player?.release() }
        player = null
        oldVolume?.let { v -> runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, v, 0) } }
        oldVolume = null
    }
}

object Sounds {
    data class Sound(val uri: String, val title: String, val kind: String)

    /** Telefonun alarm ve zil sesleri */
    fun system(ctx: Context): List<Sound> {
        val out = mutableListOf<Sound>()
        for ((type, kind) in listOf(RingtoneManager.TYPE_ALARM to "alarm", RingtoneManager.TYPE_RINGTONE to "ringtone")) {
            runCatching {
                val rm = RingtoneManager(ctx).apply { setType(type) }
                rm.cursor.use { c ->
                    while (c.moveToNext()) {
                        val uri = rm.getRingtoneUri(c.position)?.toString() ?: continue
                        out += Sound(uri, c.getString(RingtoneManager.TITLE_COLUMN_INDEX) ?: "Ses", kind)
                    }
                }
            }
        }
        return out.distinctBy { it.uri }
    }

    /** Orbit'teki müzikler */
    fun music(): List<Sound> = Music.tracks.value.map { Sound(it.uri, it.title, "music") }

    fun all(ctx: Context): List<Sound> = system(ctx) + music().take(300)

    /** Panelde alarm sesi seçebilmek için listeyi bildir (değişince) */
    fun report(ctx: Context) {
        val list = all(ctx)
        val a = JSONArray()
        for (s in list) a.put(JSONObject().put("uri", s.uri).put("title", s.title).put("kind", s.kind))
        val sig = a.toString().hashCode().toString()
        val p = Store.prefs()
        if (p.getString("soundsSig", null) == sig) return
        runCatching { Api.rpc("device_report_sounds", JSONObject().put("p_sounds", a)) }
            .onSuccess { p.edit().putString("soundsSig", sig).apply() }
    }
}
