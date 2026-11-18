package app.orbit.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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

private fun dur(sec: Int): String = if (sec <= 0) "" else "%d:%02d".format(sec / 60, sec % 60)

@Composable
private fun Thumb(data: String?) {
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

/** Videolarım: görebildiği listeler; saati dışındakiler kilitli görünür (ne zaman açılacağı yazar). */
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
    val engine = remember(live.lastSync) { RuleEngine(Store.rules()) }

    if (lists.isEmpty()) {
        Card { Muted("Henüz video yok. Ebeveynin video eklediğinde burada görünür.") }
        return
    }
    st.note?.let { Muted("ⓘ $it", 13) }
    for (l in lists) {
        val snap = live.snapshot
        val usage = live.usage
        val v = if (snap != null && usage != null) engine.verdict(l.pkg, snap, usage) else null
        val open = v?.allowed != false
        val lockText = if (open) null else {
            val rule = Store.rules().apps[l.pkg]
            val now = snap?.now ?: LocalTime.now()
            val next = rule?.kioskWindows?.map { it.start }?.sorted()?.firstOrNull { it > now } ?: rule?.kioskWindows?.minByOrNull { it.start }?.start
            if (next != null) "🔒 ${next.toString().take(5)}'te açılır" else "🔒 ${v?.reason ?: "Şu an kapalı"}"
        }
        Card {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${l.emoji} ${l.name}", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (lockText != null) Text(lockText, color = C.warn, fontSize = 13.sp)
            }
            if (l.videos.isEmpty()) Muted("Bu listede video yok", 13)
            for (vid in l.videos) {
                val local = vid.id in st.local
                val pct = st.downloading[vid.id]
                val prog = st.progress[vid.id]
                val removed = prog?.removed == true && !local
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                        .clickable(enabled = open && local) { openVideoList(ctx, l.id, vid.id) }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Thumb(vid.thumb)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(vid.title, color = if (open) C.text else C.muted, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        val info = buildList {
                            dur(vid.duration).takeIf { it.isNotEmpty() }?.let { add(it) }
                            when {
                                prog?.watched == true -> add("✔ izlendi")
                                (prog?.position ?: 0) > 5 && vid.duration > 0 -> add("%${(prog!!.position * 100 / vid.duration).coerceIn(0, 99)} izlendi")
                            }
                            when {
                                pct != null -> add("⬇ %$pct")
                                removed -> add("telefondan silindi")
                                !local -> add("⬇ inecek")
                            }
                        }
                        Muted(info.joinToString(" · "), 12)
                        if (pct != null) LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp), color = C.accent)
                    }
                    if (local && st.settings.canDelete) Text("🗑", fontSize = 18.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { ask = vid }.padding(8.dp))
                    else if (removed && st.settings.canRedownload) Text("⬇", fontSize = 18.sp, color = C.accent,
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { Videos.redownload(vid) }.padding(8.dp))
                }
            }
            if (open && l.videos.any { it.id in st.local }) {
                Text("▶ Hepsini oynat", color = C.accent, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { openVideoList(ctx, l.id, null) }.padding(vertical = 8.dp))
            }
        }
    }
    ask?.let { vid ->
        AlertDialog(
            onDismissRequest = { ask = null },
            title = { Text("Telefondan silinsin mi?") },
            text = { Muted(vid.title + if (st.settings.canRedownload) "\nİstersen sonra tekrar indirebilirsin." else "\nTekrar indirmek için ebeveynine sorman gerekir.") },
            confirmButton = { TextButton(onClick = { Videos.removeLocal(vid); ask = null }) { Text("Sil", color = C.bad) } },
            dismissButton = { TextButton(onClick = { ask = null }) { Text("Vazgeç") } },
        )
    }
}
