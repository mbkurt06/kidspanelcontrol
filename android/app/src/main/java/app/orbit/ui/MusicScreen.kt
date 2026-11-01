package app.orbit.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.media3.common.Player
import app.orbit.data.Music
import app.orbit.data.Store
import app.orbit.data.Track
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private fun mmss(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MusicScreen() {
    val ctx = LocalContext.current
    val all by Music.tracks.collectAsState()
    val blocked by Music.blocked.collectAsState()
    var loaded by remember { mutableStateOf(false) }
    val fixed = remember { Store.rules().musicFolder }
    val folder = fixed

    // Çalma durumu
    var title by remember { mutableStateOf<String?>(null) }
    var artist by remember { mutableStateOf<String?>(null) }
    var playing by remember { mutableStateOf(false) }
    var pos by remember { mutableLongStateOf(0L) }
    var dur by remember { mutableLongStateOf(0L) }
    var shuffle by remember { mutableStateOf(false) }
    var repeat by remember { mutableIntStateOf(Player.REPEAT_MODE_OFF) }
    var currentId by remember { mutableStateOf<String?>(null) }
    var dragging by remember { mutableStateOf<Float?>(null) }

    val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    val granted = ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    LaunchedEffect(granted) {
        if (!granted) app.orbit.device.Policy.grantSelf(ctx, perm)
        val list = withContext(Dispatchers.IO) { Music.scan(ctx) }
        loaded = true
        withContext(Dispatchers.IO) { Music.reportFolders(ctx) }
    }

    fun sync(p: Player) {
        val m = p.mediaMetadata
        title = m.title?.toString()
        artist = m.artist?.toString()
        playing = p.isPlaying
        dur = p.duration.coerceAtLeast(0)
        pos = p.currentPosition
        shuffle = p.shuffleModeEnabled
        repeat = p.repeatMode
        currentId = p.currentMediaItem?.mediaId
    }

    DisposableEffect(Unit) {
        var ctrl: Player? = null
        val l = object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) = sync(player)
        }
        Music.connect(ctx) { c -> ctrl = c; c.addListener(l); sync(c) }
        onDispose { ctrl?.removeListener(l) }
    }
    LaunchedEffect(Unit) {
        while (true) {
            Music.controllerOrNull()?.let { if (dragging == null) pos = it.currentPosition; dur = it.duration.coerceAtLeast(0) }
            delay(500)
        }
    }

    val list = remember(all, folder) { all }

    if (blocked != null) Card { Text("🔇 $blocked", color = C.warn) }

    // Şimdi çalan
    Card {
        Text(title ?: "Bir şarkı seç", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        artist?.let { Muted(it, 13) }
        Slider(
            value = dragging ?: if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f,
            onValueChange = { dragging = it },
            onValueChangeFinished = {
                dragging?.let { f -> Music.controllerOrNull()?.seekTo((f * dur).toLong()) }
                dragging = null
            },
            colors = SliderDefaults.colors(thumbColor = C.accent, activeTrackColor = C.accent),
        )
        Row(Modifier.fillMaxWidth()) {
            Muted(mmss(pos), 12)
            Spacer(Modifier.weight(1f))
            Muted(mmss(dur), 12)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            CtlButton(if (shuffle) "🔀" else "➡️", on = shuffle) { Music.controllerOrNull()?.let { it.shuffleModeEnabled = !it.shuffleModeEnabled } }
            CtlButton("⏮") { Music.controllerOrNull()?.seekToPreviousMediaItem() }
            CtlButton(if (playing) "⏸" else "▶️", big = true) {
                val c = Music.controllerOrNull()
                when {
                    c == null || c.mediaItemCount == 0 -> if (list.isNotEmpty()) Music.play(ctx, list, 0)
                    c.isPlaying -> c.pause()
                    blocked == null -> c.play()
                }
            }
            CtlButton("⏭") { Music.controllerOrNull()?.seekToNextMediaItem() }
            CtlButton(
                when (repeat) { Player.REPEAT_MODE_ONE -> "🔂"; else -> "🔁" },
                on = repeat != Player.REPEAT_MODE_OFF,
            ) {
                Music.controllerOrNull()?.let {
                    it.repeatMode = when (it.repeatMode) {
                        Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
                        Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
                        else -> Player.REPEAT_MODE_OFF
                    }
                }
            }
        }
        Muted(
            "Tekrar: " + when (repeat) { Player.REPEAT_MODE_ONE -> "bu şarkı"; Player.REPEAT_MODE_ALL -> "liste"; else -> "kapalı" } +
                " · Karışık: " + if (shuffle) "açık" else "kapalı",
            12,
        )
    }

    // Klasör
    val folders = remember(all) { Music.folders(all) }
    Card {
        Title("Klasör")
        if (fixed != null) Muted("📁 $fixed (ebeveynin seçti)")
        else Muted("Ebeveynin müzik klasörü seçmesi bekleniyor.", 13)
        if (loaded && all.isEmpty()) Muted("Telefonda müzik bulunamadı. Müzikleri bilgisayardan telefonun Music klasörüne at.", 13)
        if (!granted) Muted("Müzik dosyalarına erişim izni bekleniyor.", 13)
    }

    // Liste
    if (list.isNotEmpty()) {
        Card {
            Title("Şarkılar (${list.size})")
            list.forEachIndexed { i, t ->
                var editing by remember(t.id) { mutableStateOf(false) }
                var name by remember(t.id) { mutableStateOf(t.fileName.substringBeforeLast('.')) }
                TrackRow(t, t.id.toString() == currentId, onRename = { editing = true }) { Music.play(ctx, list, i) }
                if (editing) AlertDialog(
                    onDismissRequest = { editing = false },
                    title = { Text("Dosyanın adını değiştir") },
                    text = { TextField(value = name, onValueChange = { name = it }, label = { Text("Dosya adı (uzantısız)") }) },
                    confirmButton = { Button(onClick = {
                        if (Music.rename(ctx, t, name)) Music.scan(ctx)
                        editing = false
                    }) { Text("Kaydet") } },
                    dismissButton = { Button(onClick = { editing = false }) { Text("İptal") } },
                )
            }
        }
    }
}

@Composable
private fun TrackRow(t: Track, current: Boolean, onRename: () -> Unit, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (current) C.surface2 else Color.Transparent)
            .clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(if (current) "🎵" else "♪", color = if (current) C.accent else C.muted, fontSize = 16.sp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(t.title, color = C.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            t.artist?.let { Muted(it, 12) }
        }
        Text("✏️", modifier = Modifier.clickable(onClick = onRename).padding(8.dp))
        Muted(mmss(t.durationMs), 12)
    }
}

@Composable
private fun CtlButton(label: String, on: Boolean = false, big: Boolean = false, onClick: () -> Unit) {
    Column(
        Modifier.size(if (big) 64.dp else 48.dp).clip(CircleShape).background(if (big) C.accent else if (on) C.surface2 else Color.Transparent)
            .clickable(onClick = onClick),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { Text(label, fontSize = if (big) 26.sp else 20.sp) }
}

@Composable
private fun MusicChip(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (on) Color.White else C.text,
        fontSize = 13.sp,
        modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(if (on) C.accent else C.surface2).clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}
