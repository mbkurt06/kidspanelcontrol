package app.orbit.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.runtime.rememberCoroutineScope
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
import app.orbit.data.Track
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import androidx.compose.ui.input.pointer.pointerInput
import kotlin.math.abs

private fun mmss(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MusicScreen() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val all by Music.tracks.collectAsState()
    val blocked by Music.blocked.collectAsState()

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
    var playlists by remember { mutableStateOf<List<app.orbit.data.Playlist>>(emptyList()) }
    var missingTracks by remember { mutableStateOf<List<app.orbit.data.MissingTrack>>(emptyList()) }
    var selectedPlaylist by remember { mutableStateOf<String?>(null) }
    var playlistSongs by remember { mutableStateOf<List<Track>>(emptyList()) }
    var playlistDialog by remember { mutableStateOf(false) }
    var playlistName by remember { mutableStateOf("") }
    var editingPlaylist by remember { mutableStateOf<String?>(null) }
    var addFor by remember { mutableStateOf<Track?>(null) }

    val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    val granted = ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    LaunchedEffect(granted) {
        if (!granted) app.orbit.device.Policy.grantSelf(ctx, perm)
        val list = withContext(Dispatchers.IO) { Music.scan(ctx) }
        withContext(Dispatchers.IO) { Music.reportFolders(ctx); if (granted) Music.syncCatalog(list) }
    }
    LaunchedEffect(Unit) {
        playlists = withContext(Dispatchers.IO) { Music.playlists() }
    }
    LaunchedEffect(all) { missingTracks = withContext(Dispatchers.IO) { Music.missingTracks() } }
    LaunchedEffect(selectedPlaylist, all) {
        val id = selectedPlaylist ?: return@LaunchedEffect
        playlistSongs = withContext(Dispatchers.IO) { Music.playlistTracks(id, all) }
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

    val list = all

    fun refreshPlaylists() {
        scope.launch(Dispatchers.IO) {
            val next = Music.playlists()
            withContext(kotlinx.coroutines.Dispatchers.Main) {
                playlists = next
                if (selectedPlaylist !in next.map { it.id }) {
                    selectedPlaylist = null
                    playlistSongs = emptyList()
                }
            }
        }
    }

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
            modifier = Modifier.fillMaxWidth().height(24.dp),
            colors = SliderDefaults.colors(thumbColor = C.accent, activeTrackColor = C.accent, inactiveTrackColor = C.surface2),
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

    Card {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Title("Çalma listeleri")
            Spacer(Modifier.weight(1f))
            Button(onClick = { editingPlaylist = null; playlistName = ""; playlistDialog = true }) { Text("＋ Yeni") }
        }
        if (playlists.isEmpty()) Muted("Henüz çalma listesi yok.", 13)
        playlists.forEach { p ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (selectedPlaylist == p.id) "▶ ${p.name}" else p.name, color = C.text,
                    modifier = Modifier.weight(1f).clickable { selectedPlaylist = p.id })
                Text("✏️", modifier = Modifier.clickable { editingPlaylist = p.id; playlistName = p.name; playlistDialog = true }.padding(8.dp))
                Text("🗑️", modifier = Modifier.clickable {
                    scope.launch(Dispatchers.IO) { if (Music.deletePlaylist(p.id)) withContext(kotlinx.coroutines.Dispatchers.Main) { refreshPlaylists() } }
                }.padding(8.dp))
            }
        }
        if (selectedPlaylist != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Info("Seçili listeye şarkı eklemek için aşağıdaki şarkıların ＋ düğmesine dokun. Uzun basıp sürükleyerek sırala.")
            }
            playlistSongs.forEachIndexed { index, track ->
                PlaylistTrackRow(track, index, onMove = { from, to ->
                    if (to in playlistSongs.indices) playlistSongs = playlistSongs.toMutableList().also { it.add(to, it.removeAt(from)) }
                }, onDrop = {
                    selectedPlaylist?.let { id -> scope.launch(Dispatchers.IO) { Music.savePlaylistTracks(id, playlistSongs) } }
                }, onRemove = {
                    playlistSongs = playlistSongs.filterNot { it.id == track.id }
                    selectedPlaylist?.let { id -> scope.launch(Dispatchers.IO) { Music.savePlaylistTracks(id, playlistSongs) } }
                }, onClick = { Music.play(ctx, playlistSongs, index) })
            }
        }
    }

    if (missingTracks.isNotEmpty()) Card {
        Title("Eksik dosyalar")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Info("SD karttan silinen şarkılar burada tutulur; kaldırınca playlist kayıtlarından da çıkar.")
        }
        missingTracks.forEach { missing ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("⚠️ ${missing.label}", color = C.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("🗑️", modifier = Modifier.clickable {
                    scope.launch(Dispatchers.IO) {
                        if (Music.removeMissingTrack(missing.key)) withContext(kotlinx.coroutines.Dispatchers.Main) {
                            missingTracks = missingTracks.filterNot { it.key == missing.key }
                        }
                    }
                }.padding(8.dp))
            }
        }
    }

    if (playlistDialog) AlertDialog(
        onDismissRequest = { playlistDialog = false },
        title = { Text(if (editingPlaylist == null) "Yeni çalma listesi" else "Çalma listesini yeniden adlandır") },
        text = { TextField(value = playlistName, onValueChange = { playlistName = it }, label = { Text("Liste adı") }) },
        confirmButton = { Button(onClick = {
            val id = editingPlaylist
            playlistDialog = false
            scope.launch(Dispatchers.IO) {
                if (if (id == null) Music.createPlaylist(playlistName) else Music.renamePlaylist(id, playlistName)) {
                    withContext(kotlinx.coroutines.Dispatchers.Main) { refreshPlaylists() }
                }
            }
        }) { Text("Kaydet") } },
        dismissButton = { Button(onClick = { playlistDialog = false }) { Text("İptal") } },
    )

    // Çalma listesine ekle (YouTube gibi): listeler onay kutusuyla, oradan yeni liste
    addFor?.let { track ->
        AddToPlaylistDialog(track, playlists, onClose = { addFor = null }, onChanged = {
            refreshPlaylists()
            selectedPlaylist?.let { id -> scope.launch { playlistSongs = withContext(Dispatchers.IO) { Music.playlistTracks(id, all) } } }
        })
    }

    // Liste
    if (list.isNotEmpty()) {
        Card {
            Title("Şarkılar (${list.size})")
            list.forEachIndexed { i, t ->
                var editing by remember(t.id) { mutableStateOf(false) }
                var name by remember(t.id) { mutableStateOf(t.fileName.substringBeforeLast('.')) }
                TrackRow(t, t.id.toString() == currentId, onRename = { editing = true }, onAdd = { addFor = t }) { Music.play(ctx, if (selectedPlaylist == null) list else playlistSongs, if (selectedPlaylist == null) i else playlistSongs.indexOfFirst { it.id == t.id }.coerceAtLeast(0)) }
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
private fun TrackRow(t: Track, current: Boolean, onRename: () -> Unit, onAdd: (() -> Unit)? = null, onClick: () -> Unit) {
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
        Muted(mmss(t.durationMs), 12)
        var menu by remember { mutableStateOf(false) }
        androidx.compose.foundation.layout.Box {
            Text("⋮", color = C.text, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clickable { menu = true }.padding(horizontal = 12.dp, vertical = 4.dp))
            androidx.compose.material3.DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = C.surface) {
                onAdd?.let { add ->
                    androidx.compose.material3.DropdownMenuItem(text = { Text("➕ Çalma listesine ekle", color = C.text) }, onClick = { menu = false; add() })
                }
                androidx.compose.material3.DropdownMenuItem(text = { Text("✏️ Adını değiştir", color = C.text) }, onClick = { menu = false; onRename() })
            }
        }
    }
}

@Composable
private fun PlaylistTrackRow(track: Track, index: Int, onMove: (Int, Int) -> Unit, onDrop: () -> Unit, onRemove: () -> Unit, onClick: () -> Unit) {
    var distance by remember { mutableFloatStateOf(0f) }
    Row(
        Modifier.fillMaxWidth().pointerInput(index) {
            detectDragGesturesAfterLongPress(
                onDragStart = { distance = 0f },
                onDragCancel = { distance = 0f },
                onDragEnd = { distance = 0f; onDrop() },
                onDrag = { change, amount ->
                    distance += amount.y
                    if (abs(distance) > 56f) {
                        val next = if (distance > 0) index + 1 else index - 1
                        onMove(index, next)
                        distance = 0f
                    }
                },
            )
        }.clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("☰", color = C.muted, modifier = Modifier.padding(end = 8.dp))
        Text(track.title, color = C.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("✕", modifier = Modifier.clickable(onClick = onRemove).padding(8.dp))
    }
}

@Composable
private fun CtlButton(label: String, on: Boolean = false, big: Boolean = false, onClick: () -> Unit) {
    Column(
        Modifier.size(if (big) 58.dp else 42.dp).clip(CircleShape).background(if (big) C.accent else if (on) C.surface2 else Color.Transparent)
            .clickable(onClick = onClick),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { Text(label, fontSize = if (big) 24.sp else 18.sp) }
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

/** Şarkıyı bir ya da birden fazla çalma listesine ekle; buradan yeni liste de oluşturulur. */
@Composable
private fun AddToPlaylistDialog(track: Track, playlists: List<app.orbit.data.Playlist>, onClose: () -> Unit, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    val key = track.id.toString()
    var inLists by remember { mutableStateOf<Set<String>?>(null) }
    var lists by remember { mutableStateOf(playlists) }
    var creating by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(key) { inLists = withContext(Dispatchers.IO) { Music.playlistsWith(key) } }
    fun toggle(id: String, on: Boolean) {
        inLists = (inLists ?: emptySet()).let { if (on) it + id else it - id }
        scope.launch(Dispatchers.IO) {
            if (on) Music.addToPlaylist(id, track) else Music.removeFromPlaylist(id, key)
            withContext(Dispatchers.Main) { onChanged() }
        }
    }
    AlertDialog(
        onDismissRequest = onClose,
        containerColor = C.surface,
        title = { Text("Kaydet: ${track.title}", color = C.text, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val cur = inLists
                if (cur == null) Muted("Yükleniyor…")
                else {
                    if (lists.isEmpty() && !creating) Muted("Henüz çalma listen yok.", 13)
                    lists.forEach { p ->
                        val on = p.id in cur
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { toggle(p.id, !on) }.padding(vertical = 8.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            androidx.compose.material3.Checkbox(checked = on, onCheckedChange = { toggle(p.id, it) })
                            Text(p.name, color = C.text, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        }
                    }
                }
                if (creating) {
                    TextField(value = newName, onValueChange = { newName = it }, label = { Text("Yeni liste adı") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(enabled = newName.isNotBlank() && !busy, onClick = {
                            busy = true
                            scope.launch {
                                val id = withContext(Dispatchers.IO) { Music.createPlaylistId(newName)?.also { Music.addToPlaylist(it, track) } }
                                busy = false
                                if (id != null) {
                                    lists = withContext(Dispatchers.IO) { Music.playlists() }
                                    inLists = (inLists ?: emptySet()) + id
                                    creating = false
                                    newName = ""
                                    onChanged()
                                }
                            }
                        }) { Text("Oluştur") }
                        Button(onClick = { creating = false; newName = "" }) { Text("Vazgeç") }
                    }
                } else {
                    Text("＋ Yeni çalma listesi", color = C.accent, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.fillMaxWidth().clickable { creating = true }.padding(vertical = 10.dp, horizontal = 4.dp))
                }
            }
        },
        confirmButton = { Button(onClick = onClose) { Text("Bitti") } },
    )
}
