package app.orbit.ui

import android.content.pm.ActivityInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
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
 * Bir video listesinin ekranı: üstte oynatıcı, altında listenin videoları (inenler oynar, inmeyenlerin yüzdesi görünür).
 * Ön planda "video:<listeId>" uygulaması sayılır: süre, saat ve kilit kuralları buna göre işler.
 */
class VideoPlayerActivity : ComponentActivity() {
    private val player by lazy { ExoPlayer.Builder(this).build() }
    private lateinit var listId: String
    private val ui = Handler(Looper.getMainLooper())
    private var current by mutableStateOf<String?>(null)
    private var full by mutableStateOf(false)
    private var ask by mutableStateOf<Videos.Video?>(null)

    private val tick = object : Runnable {
        override fun run() { save(false); ui.postDelayed(this, 5_000) }
    }

    private fun list(): Videos.VList? = Videos.list(listId)
    private fun playable(): List<Videos.Video> = list()?.videos?.filter { Videos.file(it.id).exists() } ?: emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        Videos.init(this)
        listId = intent.getStringExtra("list") ?: run { finish(); return }
        val l = list() ?: run { finish(); return }
        val st = Videos.state.value
        val want = intent.getStringExtra("video")
        val items = playable()
        val start = items.firstOrNull { it.id == want } ?: items.firstOrNull { st.progress[it.id]?.watched != true } ?: items.firstOrNull()
        start?.let { load(it, play = want != null) }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state != Player.STATE_ENDED) return
                save(true)
                // Sıradaki inmiş video
                val ps = playable()
                val i = ps.indexOfFirst { it.id == current }
                ps.getOrNull(i + 1)?.let { load(it, play = true) }
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (full) setFull(false) else finish() }
        })

        lifecycleScope.launch {
            WebApps.close.collect { c ->
                if (c != null && c.first == l.pkg) { WebApps.clearClose(); finish() }
            }
        }

        setContent {
            OrbitTheme {
                val st2 by Videos.state.collectAsState()
                val vl = remember(st2.lists) { list() } ?: l
                Column(Modifier.fillMaxSize().background(C.bg).let { if (full) it else it.statusBarsPadding() }) {
                    if (!full) Row(Modifier.fillMaxWidth().background(C.surface).padding(horizontal = 4.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.clip(RoundedCornerShape(10.dp)).clickable { finish() }.padding(horizontal = 14.dp, vertical = 10.dp)) { Text("✕", color = C.text, fontSize = 20.sp) }
                        Text("${vl.emoji} ${vl.name}", color = C.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 6.dp))
                    }
                    Box(Modifier.fillMaxWidth().let { if (full) it.weight(1f) else it.aspectRatio(16f / 9f) }.background(androidx.compose.ui.graphics.Color.Black)) {
                        if (current == null) Text("Oynatmak için aşağıdan bir video seç", color = C.muted, modifier = Modifier.align(Alignment.Center))
                        AndroidView(factory = { ctx ->
                            PlayerView(ctx).apply {
                                player = this@VideoPlayerActivity.player
                                setShowNextButton(false)
                                setShowPreviousButton(false)
                                setFullscreenButtonClickListener { setFull(it) }
                            }
                        }, modifier = Modifier.fillMaxSize())
                    }
                    if (!full) {
                        val now = vl.videos.firstOrNull { it.id == current }
                        if (now != null) Text(now.title, color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        LazyColumn(Modifier.fillMaxWidth().weight(1f).padding(horizontal = 10.dp)) {
                            items(vl.videos, key = { it.id }) { vid ->
                                VideoRow(vid, st2, open = true, playing = vid.id == current, onAsk = { ask = it }) { load(vid, play = true) }
                            }
                        }
                    }
                }
                DeleteAsk(ask, st2) { ask = null }
            }
        }
    }

    private fun load(v: Videos.Video, play: Boolean) {
        if (current != null) save(false)
        val f = Videos.file(v.id)
        if (!f.exists()) return
        current = v.id
        val p = Videos.state.value.progress[v.id]
        player.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(f)), (p?.takeIf { !it.watched }?.position ?: 0) * 1000L)
        player.prepare()
        player.playWhenReady = play
    }

    private fun setFull(on: Boolean) {
        full = on
        val c = WindowInsetsControllerCompat(window, window.decorView)
        if (on) {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(WindowInsetsCompat.Type.systemBars())
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            WindowCompat.setDecorFitsSystemWindows(window, true)
            c.show(WindowInsetsCompat.Type.systemBars())
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    private fun save(ended: Boolean) {
        val id = current ?: return
        val v = list()?.videos?.firstOrNull { it.id == id } ?: return
        val dur = (player.duration.takeIf { it > 0 } ?: (v.duration * 1000L)) / 1000
        val pos = player.currentPosition / 1000
        if (pos <= 0 && !ended) return
        Videos.saveProgress(v, pos.toInt(), dur.toInt(), ended || (dur > 0 && pos >= dur * 0.9))
    }

    override fun onResume() {
        super.onResume()
        if (::listId.isInitialized) WebApps.current = Videos.PREFIX + listId
        ui.postDelayed(tick, 5_000)
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(tick)
        save(false)
        player.pause()
        if (::listId.isInitialized && WebApps.current == Videos.PREFIX + listId) WebApps.current = null
    }

    override fun onDestroy() {
        player.release()
        super.onDestroy()
    }
}
