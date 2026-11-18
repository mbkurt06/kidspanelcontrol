package app.orbit.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.orbit.data.Store
import app.orbit.data.Videos
import app.orbit.data.WebApps
import kotlinx.coroutines.launch

/**
 * Videolarım oynatıcısı: sadece telefona inmiş videolar, liste sırasıyla. İnternet / başka yere çıkış yok.
 * Ön planda "video:<listeId>" uygulaması sayılır: süre, saat ve kilit kuralları buna göre işler.
 */
class VideoPlayerActivity : ComponentActivity() {
    private var player: ExoPlayer? = null
    private lateinit var list: Videos.VList
    private var items: List<Videos.Video> = emptyList()
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var titleView: TextView

    private val tick = object : Runnable {
        override fun run() {
            save(false)
            ui.postDelayed(this, 5_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        Videos.init(this)
        val l = intent.getStringExtra("list")?.let { Videos.list(it) }
        if (l == null) { finish(); return }
        list = l
        items = l.videos.filter { Videos.file(it.id).exists() }
        if (items.isEmpty()) { Toast.makeText(this, "Bu listede henüz inmiş video yok", Toast.LENGTH_LONG).show(); finish(); return }
        val st = Videos.state.value
        val wantId = intent.getStringExtra("video")
        val start = items.indexOfFirst { it.id == wantId }.takeIf { it >= 0 }
            ?: items.indexOfFirst { st.progress[it.id]?.watched != true }.takeIf { it >= 0 } ?: 0

        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val p = ExoPlayer.Builder(this).build()
        player = p
        p.setMediaItems(items.map { MediaItem.Builder().setUri(android.net.Uri.fromFile(Videos.file(it.id))).setMediaId(it.id).build() }, start,
            ((st.progress[items[start].id]?.takeIf { !it.watched }?.position ?: 0) * 1000L))
        p.addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: androidx.media3.common.MediaItem?, reason: Int) {
                // Önceki video bitti sayılır
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                    val prev = items.getOrNull(p.currentMediaItemIndex - 1)
                    prev?.let { Videos.saveProgress(it, it.duration, it.duration, true) }
                }
                updateTitle()
            }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) { save(true); finish() }
            }
        })
        p.prepare()
        p.playWhenReady = true

        val root = FrameLayout(this).apply { setBackgroundColor(android.graphics.Color.BLACK) }
        val view = PlayerView(this).apply {
            this.player = p
            setShowNextButton(true)
            setShowPreviousButton(true)
            setFullscreenButtonClickListener(null)
        }
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        titleView = TextView(this).apply {
            setTextColor(android.graphics.Color.WHITE)
            textSize = 15f
            setPadding(36, 48, 36, 24)
            setShadowLayer(6f, 0f, 0f, android.graphics.Color.BLACK)
            maxLines = 1
        }
        root.addView(titleView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        view.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> titleView.visibility = v })
        setContentView(root)
        updateTitle()

        lifecycleScope.launch {
            WebApps.close.collect { c ->
                if (c != null && c.first == list.pkg) {
                    WebApps.clearClose()
                    finish()
                }
            }
        }
    }

    private fun updateTitle() {
        val p = player ?: return
        val v = items.getOrNull(p.currentMediaItemIndex) ?: return
        titleView.text = "${list.emoji} ${list.name} · ${p.currentMediaItemIndex + 1}/${items.size} · ${v.title}"
    }

    private fun save(ended: Boolean) {
        val p = player ?: return
        val v = items.getOrNull(p.currentMediaItemIndex) ?: return
        val dur = (p.duration.takeIf { it > 0 } ?: (v.duration * 1000L)) / 1000
        val pos = p.currentPosition / 1000
        val watched = ended || (dur > 0 && pos >= dur * 0.9)
        Videos.saveProgress(v, pos.toInt(), dur.toInt(), watched)
    }

    override fun onResume() {
        super.onResume()
        if (::list.isInitialized) WebApps.current = list.pkg
        ui.postDelayed(tick, 5_000)
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(tick)
        save(false)
        player?.pause()
        if (::list.isInitialized && WebApps.current == list.pkg) WebApps.current = null
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }
}
