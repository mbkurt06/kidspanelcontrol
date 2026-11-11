package app.orbit.service

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.orbit.data.Music
import app.orbit.data.Notifier
import app.orbit.ui.MainActivity

/** Arka planda müzik: bildirim ve kilit ekranında kontroller, kulaklık tuşları. */
class MusicService : MediaSessionService() {
    private var session: MediaSession? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var fading = false

    /** Uyku zamanlayıcısı: son 10 sn sesi kısar, süre dolunca durdurur (ekran kapalı / Orbit arka planda olsa da). */
    private val sleepTick = object : Runnable {
        override fun run() {
            val p = Music.player
            val at = Music.sleepAt.value
            if (p != null && at != null) {
                val left = at - System.currentTimeMillis()
                when {
                    left <= 0 -> {
                        p.pause()
                        p.volume = 1f
                        fading = false
                        Music.cancelSleep()
                    }
                    left <= 10_000 && p.isPlaying -> { fading = true; p.volume = (left / 10_000f).coerceIn(0.05f, 1f) }
                    fading -> { fading = false; p.volume = 1f }
                }
            } else if (fading) {
                fading = false
                p?.volume = 1f
            }
            handler.postDelayed(this, 500)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val p = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        p.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                // Kurallar kapattıysa çalmaya izin verme
                if (isPlaying && Music.blocked.value != null) p.pause()
            }
        })
        Music.player = p
        val open = Intent(this, MainActivity::class.java)
            .putExtra(Notifier.EXTRA_SCREEN, "MUSIC")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        session = MediaSession.Builder(this, p)
            .setSessionActivity(PendingIntent.getActivity(this, 55, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build()
        handler.post(sleepTick)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(sleepTick)
        session?.run {
            player.release()
            release()
        }
        session = null
        Music.player = null
        super.onDestroy()
    }
}
