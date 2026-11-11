package app.orbit.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.orbit.data.Messages
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val QUICK = listOf("Beni alır mısın?", "Eve vardım 🏠", "Beni ara 📞", "Tamam 👍", "Seni seviyorum ❤️")

/** Mesajlar: sohbet listesi → sohbet. Telefon kilitli / kapalı saatlerde de çalışır. */
@Composable
fun MessagesScreen() {
    val chats by Messages.chats.collectAsState()
    val all by Messages.list.collectAsState()
    var open by rememberSaveable { mutableStateOf<String?>(null) }

    DisposableEffect(Unit) {
        Messages.screenOpen = true
        onDispose { Messages.screenOpen = false; Messages.openChat = null }
    }
    LaunchedEffect(Unit) { withContext(Dispatchers.IO) { Messages.refresh() } }
    // Tek sohbet varsa doğrudan aç
    LaunchedEffect(chats.size) { if (open == null && chats.size == 1) open = chats[0].id }

    val chat = chats.firstOrNull { it.id == open }
    if (chat == null) {
        ChatList(chats, all) { open = it }
    } else {
        ChatView(chat, all.filter { it.chatId == chat.id }, all, onBack = if (chats.size > 1) ({ open = null }) else null)
    }
}

@Composable
private fun ChatList(chats: List<Messages.Chat>, all: List<Messages.Msg>, onOpen: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (chats.isEmpty()) item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { Muted("Sohbetler yükleniyor…") } }
        items(chats.sortedByDescending { c -> all.lastOrNull { it.chatId == c.id }?.at ?: 0L }, key = { it.id }) { c ->
            val last = all.lastOrNull { it.chatId == c.id }
            val unread = Messages.unread(c, all)
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(C.surface2).clickable { onOpen(c.id) }.padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(if (c.group) "👥" else "👤", fontSize = 22.sp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(c.title, color = C.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (c.readonly == "frozen") Text("  ⏸", color = C.warn, fontSize = 14.sp)
                    }
                    Text(
                        when {
                            last == null -> "Henüz mesaj yok"
                            last.deleted -> "🗑 Bu mesaj silindi"
                            Messages.mine(last) -> "Sen: ${last.body}"
                            c.group -> "${last.sender ?: ""}: ${last.body}"
                            else -> last.body
                        },
                        color = C.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                if (unread > 0) {
                    Box(Modifier.clip(RoundedCornerShape(12.dp)).background(C.accent).padding(horizontal = 8.dp, vertical = 2.dp)) {
                        Text("$unread", color = C.text, fontSize = 13.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatView(chat: Messages.Chat, list: List<Messages.Msg>, all: List<Messages.Msg>, onBack: (() -> Unit)?) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf("") }
    var reply by remember { mutableStateOf<Messages.Msg?>(null) }
    var sel by remember { mutableStateOf<String?>(null) }
    val clip = LocalClipboardManager.current
    val byId = remember(all) { all.associateBy { it.id } }

    DisposableEffect(chat.id) {
        Messages.openChat = chat.id
        onDispose { if (Messages.openChat == chat.id) Messages.openChat = null }
    }
    LaunchedEffect(chat.id, list.size) { withContext(Dispatchers.IO) { Messages.markRead(chat.id) } }

    fun send(body: String) {
        if (body.isBlank() || busy || !chat.canWrite) return
        busy = true; err = ""
        val r = reply?.id
        scope.launch {
            val e = withContext(Dispatchers.IO) { Messages.send(chat.id, body, r) }
            busy = false
            if (e == null) { text = ""; reply = null } else err = e
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) TextButton(onClick = onBack) { Text("‹ Sohbetler") }
            Text(chat.title, color = C.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        when (chat.readonly) {
            "frozen" -> Banner("⏸ Bu sohbet durduruldu · mesaj yazamazsın" + (chat.frozenUntil?.takeIf { it < 4_000_000_000_000L }?.let { " (" + SimpleDateFormat("HH:mm", Locale("tr")).format(Date(it)) + "'e kadar)" } ?: ""), C.bad)
            "parents_only" -> Banner("Bu grupta sadece ebeveynler yazabiliyor", C.muted)
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            reverseLayout = true,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (list.isEmpty()) item {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { Muted("Henüz mesaj yok.") }
            }
            items(list.reversed(), key = { it.id }) { m ->
                Bubble(
                    m, chat.group, m.replyTo?.let { byId[it] }, selected = sel == m.id,
                    onSelect = { sel = if (sel == m.id) null else m.id },
                    onReply = { if (!m.deleted && chat.canWrite) { reply = m; sel = null } },
                    onCopy = { clip.setText(AnnotatedString(m.body)); sel = null },
                    onDelete = if (Messages.canDelete(m)) ({
                        sel = null
                        scope.launch { if (!withContext(Dispatchers.IO) { Messages.delete(m.id) }) err = "Silinemedi" }
                    }) else null,
                    canReply = chat.canWrite,
                )
            }
        }
        if (chat.canWrite) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (q in QUICK) {
                    Box(
                        Modifier.clip(RoundedCornerShape(16.dp)).background(C.surface2).clickable(enabled = !busy) { send(q) }.padding(horizontal = 12.dp, vertical = 8.dp),
                    ) { Text(q, color = C.text, fontSize = 14.sp) }
                }
            }
        }
        if (err.isNotEmpty()) Text(err, color = C.bad, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp))
        reply?.let { r ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(10.dp)).background(C.surface2).padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(if (Messages.mine(r)) "Sen" else r.sender ?: "Ebeveyn", color = C.accent, fontSize = 12.sp)
                    Text(r.body, color = C.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                TextButton(onClick = { reply = null }) { Text("✕") }
            }
        }
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                text, { text = it.take(1000) },
                placeholder = { Text(if (chat.canWrite) "Mesaj yaz" else "Yazamazsın") },
                modifier = Modifier.weight(1f),
                enabled = chat.canWrite,
                maxLines = 4,
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = { send(text) },
                enabled = chat.canWrite && text.isNotBlank() && !busy,
                colors = ButtonDefaults.buttonColors(containerColor = C.accent),
            ) { Text("Gönder") }
        }
    }
}

@Composable
private fun Banner(text: String, color: androidx.compose.ui.graphics.Color) {
    Box(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(color.copy(alpha = 0.18f)).padding(10.dp),
    ) { Text(text, color = C.text, fontSize = 14.sp) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Bubble(
    m: Messages.Msg, group: Boolean, quote: Messages.Msg?, selected: Boolean,
    onSelect: () -> Unit, onReply: () -> Unit, onCopy: () -> Unit, onDelete: (() -> Unit)?, canReply: Boolean,
) {
    val mine = Messages.mine(m)
    val time = remember(m.at) { SimpleDateFormat("d MMM HH:mm", Locale("tr")).format(Date(m.at)) }
    var drag by remember { mutableStateOf(0f) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier.widthIn(max = 300.dp)
                .graphicsLayer { translationX = drag }
                // Sağa kaydır: yanıtla
                .pointerInput(m.id, canReply) {
                    detectHorizontalDragGestures(
                        onDragEnd = { if (drag > 120f) onReply(); drag = 0f },
                        onDragCancel = { drag = 0f },
                    ) { _, d -> drag = (drag + d).coerceIn(0f, 200f) }
                }
                .clip(RoundedCornerShape(16.dp))
                .background(if (mine) C.accent else C.surface2)
                .combinedClickable(onClick = onSelect, onLongClick = onSelect)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            if (!mine) Text(m.sender ?: if (m.fromParent) "Ebeveyn" else "", color = C.warn, fontSize = 12.sp)
            quote?.let { q ->
                Box(Modifier.padding(vertical = 4.dp).clip(RoundedCornerShape(8.dp)).background(C.bg.copy(alpha = 0.35f)).padding(horizontal = 8.dp, vertical = 4.dp)) {
                    Column {
                        Text(if (Messages.mine(q)) "Sen" else q.sender ?: "Ebeveyn", color = C.accent, fontSize = 12.sp)
                        Text(if (q.deleted) "🗑 silindi" else q.body, color = C.text.copy(alpha = 0.8f), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (m.deleted) Text("🗑 Bu mesaj silindi", color = C.text.copy(alpha = 0.7f), fontSize = 15.sp, fontStyle = FontStyle.Italic)
            else Text(m.body, color = C.text, fontSize = 16.sp)
            Text(
                time + if (mine && m.read) " · görüldü" else "",
                color = if (mine) C.text.copy(alpha = 0.7f) else C.muted, fontSize = 11.sp,
                modifier = Modifier.align(Alignment.End),
            )
            if (selected && !m.deleted) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (canReply) TextButton(onClick = onReply) { Text("↩ Yanıtla", fontSize = 13.sp) }
                    TextButton(onClick = onCopy) { Text("📋 Kopyala", fontSize = 13.sp) }
                    onDelete?.let { TextButton(onClick = it) { Text("🗑 Sil", fontSize = 13.sp) } }
                }
            }
        }
    }
}
