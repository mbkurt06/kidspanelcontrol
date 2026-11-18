package app.orbit.ui

import android.graphics.BitmapFactory
import android.util.Base64
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Store
import app.orbit.data.Videos
import app.orbit.engine.RuleEngine
import app.orbit.service.Live
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.LocalTime

internal fun dur(sec: Int): String = if (sec <= 0) "" else "%d:%02d".format(sec / 60, sec % 60)

@Composable
internal fun Thumb(data: String?) {
    val bmp = remember(data) {
        runCatching {
            val b64 = data?.substringAfter("base64,", "") ?: ""
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
    Box(Modifier.width(96.dp).height(54.dp).clip(RoundedCornerShape(8.dp)).background(C.surface2), contentAlignment = Alignment.Center) {
        if (bmp != null) Image(bmp, null, Modifier.width(96.dp).height(54.dp), contentScale = ContentScale.Crop)
        else Text("🎬", fontSize = 22.sp)
    }
}

/** Liste şu an açık mı; kapalıysa kilit yazısı ("🔒 15:00'te açılır") */
@Composable
internal fun listLock(l: Videos.VList): String? {
    val live by Live.state.collectAsState()
    val engine = remember(live.lastSync) { RuleEngine(Store.rules()) }
    val snap = live.snapshot
    val usage = live.usage
    val v = if (snap != null && usage != null) engine.verdict(l.pkg, snap, usage) else null
    if (v?.allowed != false) return null
    val rule = Store.rules().apps[l.pkg]
    val now = snap?.now ?: LocalTime.now()
    val next = rule?.kioskWindows?.map { it.start }?.sorted()?.firstOrNull { it > now } ?: rule?.kioskWindows?.minByOrNull { it.start }?.start
    return if (next != null) "🔒 ${next.toString().take(5)}'te açılır" else "🔒 ${v.reason ?: "Şu an kapalı"}"
}

/** Bir video satırı: kapak, ad, süre, izlenme ve indirme yüzdesi; İndir / Sil düğmeleri */
@Composable
internal fun VideoRow(vid: Videos.Video, st: Videos.State, open: Boolean, playing: Boolean = false, onAsk: (Videos.Video) -> Unit, onPlay: () -> Unit) {
    val local = vid.id in st.local
    val pct = st.downloading[vid.id]
    val prog = st.progress[vid.id]
    val removed = prog?.removed == true && !local
    val err = st.errors[vid.id]
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (playing) C.surface2 else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(enabled = open && local, onClick = onPlay)
            .padding(vertical = 6.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumb(vid.thumb)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text((if (playing) "▶ " else "") + vid.title, color = if (open) C.text else C.muted, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val info = buildList {
                dur(vid.duration).takeIf { it.isNotEmpty() }?.let { add(it) }
                if (vid.size > 0) add("${vid.size / 1_048_576} MB")
                when {
                    prog?.watched == true -> add("✔ izlendi")
                    (prog?.position ?: 0) > 5 && vid.duration > 0 -> add("%${(prog!!.position * 100 / vid.duration).coerceIn(0, 99)} izlendi")
                }
                when {
                    local -> add("📥 telefonda")
                    pct != null -> add("⬇ %$pct iniyor")
                    removed -> add("telefondan silindi")
                    vid.id in st.queued -> add("⏳ sırada")
                    err != null -> add("⚠ inemedi")
                    else -> add("⬇ inmedi")
                }
            }
            Muted(info.joinToString(" · "), 12)
            if (pct != null) LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp), color = C.accent)
            if (err != null && pct == null && !local) Text(err, color = C.bad, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        when {
            local && st.settings.canDelete -> Text("🗑", fontSize = 18.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onAsk(vid) }.padding(8.dp))
            removed && st.settings.canRedownload -> Text("⬇", fontSize = 20.sp, color = C.accent,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { Videos.redownload(vid) }.padding(8.dp))
            !local && !removed && pct == null -> Text("⬇", fontSize = 20.sp, color = C.accent,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { Videos.downloadNow() }.padding(8.dp))
        }
    }
}

@Composable
internal fun DeleteAsk(vid: Videos.Video?, st: Videos.State, onDone: () -> Unit) {
    vid ?: return
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text("Telefondan silinsin mi?") },
        text = { Muted(vid.title + if (st.settings.canRedownload) "\nİstersen sonra tekrar indirebilirsin." else "\nTekrar indirmek için ebeveynine sorman gerekir.") },
        confirmButton = { TextButton(onClick = { Videos.removeLocal(vid); onDone() }) { Text("Sil", color = C.bad) } },
        dismissButton = { TextButton(onClick = onDone) { Text("Vazgeç") } },
    )
}

/** Videolarım: listeler ok ile açılıp kapanır; liste adına basınca o listenin oynatıcı ekranı açılır. */
@Composable
fun VideosScreen() {
    val ctx = LocalContext.current
    LaunchedEffect(Unit) {
        Videos.init(ctx)
        withContext(Dispatchers.IO) { Videos.sync() }
    }
    val st by Videos.state.collectAsState()
    val live by Live.state.collectAsState()
    val lists = remember(st.lists, live.lastSync) { Videos.visibleLists() }
    var ask by remember { mutableStateOf<Videos.Video?>(null) }
    var closed by rememberSaveable { mutableStateOf(setOf<String>()) }

    if (lists.isEmpty()) {
        Card { Muted("Henüz video yok. Ebeveynin video eklediğinde burada görünür.") }
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Muted(if (Videos.onSdCard) "💾 Videolar hafıza kartında" else "📱 Videolar telefon hafızasında", 12)
        Spacer(Modifier.weight(1f))
        if (lists.any { l -> l.videos.any { it.id !in st.local } }) Text("⬇ Hepsini indir", color = C.accent, fontSize = 14.sp,
            modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { Videos.downloadNow() }.padding(6.dp))
    }
    st.note?.let { Muted("ⓘ $it", 13) }
    for (l in lists) {
        val lock = listLock(l)
        val open = lock == null
        val expanded = l.id !in closed
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(
                    Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable {
                        if (!open) Toast.makeText(ctx, lock, Toast.LENGTH_SHORT).show()
                        else openVideoList(ctx, l.id, null)
                    }.padding(vertical = 4.dp),
                ) {
                    Text("${l.emoji} ${l.name}", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                    val n = l.videos.count { it.id in st.local }
                    Muted(if (lock != null) lock else "${l.videos.size} video · $n telefonda", 12)
                }
                Text(if (expanded) "▴" else "▾", color = C.text, fontSize = 22.sp,
                    modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { closed = if (expanded) closed + l.id else closed - l.id }.padding(horizontal = 14.dp, vertical = 6.dp))
            }
            if (expanded) {
                if (l.videos.isEmpty()) Muted("Bu listede video yok", 13)
                for (vid in l.videos) VideoRow(vid, st, open, onAsk = { ask = it }) { openVideoList(ctx, l.id, vid.id) }
            }
        }
    }
    DeleteAsk(ask, st) { ask = null }
}
